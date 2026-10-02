/**
 * Template-backed custom tags are compilation units.
 *
 * Discovery supplies an absolute template filename. The caller lowers the tag
 * call exactly like an explicitly imported component and synthesizes only the
 * import that makes that component binding available. The template itself is
 * never expanded into the caller.
 *
 * The one cross-file fact a caller needs is metadata used for silent-drop
 * diagnostics. It is produced by compiling the template through the ordinary
 * per-file lowerer, then cached by filename, mtime and source text.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { CALLEE_INPUT_ERROR } from "./callee-input-error.ts";
import type { Ctx, Node } from "./core.ts";
import { markoBabel, TranslateError, warn } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { Ir, IrNode } from "./ir.ts";

export interface TemplateTag {
  filename: string;
  source: string;
  mtimeMs?: number;
}

export interface TemplateMetadata {
  readsContent: boolean;
  attributeTags: string[];
  /**
   * The unit spreads `input` wholesale (`...input`), so it reads every
   * attribute tag and the body alike, whatever `attributeTags` happens to
   * list from the member reads that were also matched individually.
   *
   * The dropped-attribute-tag and dropped-body warnings both suppress on this
   * flag rather than trying to enumerate the spread's effect into
   * `attributeTags`/`readsContent`: this unit's own copy of `input` may or may
   * not touch every property, but the warning is about whether the *call
   * site's* content reaches the unit, and a wholesale copy always carries it
   * there.
   */
  readsAllInput?: boolean;
  /**
   * This unit declares `<return>`, so its default export returns
   * `{ value, output }` rather than the output alone (design §3.3).
   *
   * The caller consumes it for two decisions it cannot make on its own: how
   * to unwrap the call (the `{ value, output }` shape is invisible at the
   * call site), and whether a `/var` on the call is legal at all — C5's
   * "`<x>` does not return a value".
   */
  returnsValue?: boolean;
  /**
   * The source text of the `<return>` value expression, when there is one.
   *
   * Carried for typing: the `/var` binding's type is this expression's
   * inferred type, and a host that projects a virtual module needs the
   * expression rather than just the fact that one exists.
   */
  returnValueCode?: string;
  /**
   * This unit is still being compiled, so the other fields are placeholders.
   *
   * Set only on the provisional entry that terminates recursion. A consumer
   * must treat it as "not yet known" rather than as a negative answer.
   */
  pending?: boolean;
  /**
   * The verbatim source of this unit's `Input` declaration — `export
   * interface Input …`, or the `<static>` block's `type Input`/`interface
   * Input` — when it has one.
   *
   * Carried for the callee-`Input` reader (decision 106,
   * `callee-input.ts`): a caller with attribute tags reads the callee's
   * `Input` syntactically, and a `.mx` callee's Input is reached through
   * this metadata rather than by re-parsing the template.
   */
  inputCode?: string;
  /**
   * The `<static>` block and authored `import` statements of a unit whose
   * `Input` (or its attribute-tag config aliases) may live there — the
   * same-file alias and `import type` sources the syntactic resolver
   * follows. Static blocks joined verbatim, one import statement per line.
   * Only set when the unit has at least one of them.
   */
  inputAuxCode?: string;
  /**
   * The verbatim source of each top-level `export` statement this unit
   * hoists (`export const …`, `export function …`), one entry per statement,
   * in source order. `export interface Input` is not among them.
   *
   * Host-authoring metadata, additive like `inputAuxCode`: carried so a host
   * can read a callee's own `export const` facts (the
   * Angular host reads `selector`) from the same parsed statements its
   * module emission consumes, rather than re-scanning the callee's text —
   * which would also see an `export` inside a comment or a string. Only set
   * when the unit has at least one.
   */
  hoistedExports?: string[];
}

export interface TemplateBackedTag extends CustomTag {
  template: TemplateTag;
}

export function hasTemplate(
  definition: CustomTag,
): definition is TemplateBackedTag {
  const candidate = definition as Partial<TemplateBackedTag>;
  return (
    !!candidate.template &&
    typeof candidate.template.filename === "string" &&
    typeof candidate.template.source === "string"
  );
}

interface CacheEntry {
  mtimeMs: number | undefined;
  source: string;
  metadata: TemplateMetadata;
  /**
   * This unit's own compile is still in progress.
   *
   * A provisional entry exists only to terminate recursion; its metadata is a
   * placeholder, not an answer. A caller that reads one must not draw a
   * conclusion from it — see `routeTemplateCall`, which suppresses the
   * silent-drop warnings rather than raising them off an empty value.
   */
  pending?: boolean;
}

const templateCache = new Map<string, CacheEntry>();
const MAX_CACHED_TEMPLATES = 256;
let compileCount = 0;

/**
 * Sets `key` to `value`, refreshing its recency, then evicts the oldest
 * entries until `cache.size <= max` — never evicting `key` itself, even at
 * the bound.
 *
 * `delete` before `set`: `set` on an existing key keeps its original
 * insertion ordinal, which would let eviction drop the entry just written.
 */
export function touchAndEvict<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  max: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === key) break;
    cache.delete(oldest.value);
  }
}

export function templateCompileCount(): number {
  return compileCount;
}

/**
 * The cached metadata for one template, without compiling it.
 *
 * A read-only window on the cache, for asserting what a caller would observe
 * at a given moment — in particular that a unit mid-compile is `pending` and
 * the same unit afterwards is not. `metadataForTemplate` cannot show that: it
 * compiles on a miss, so asking it turns the answer into the thing asked for.
 */
export function peekTemplateMetadata(
  filename: string,
): TemplateMetadata | undefined {
  return templateCache.get(filename)?.metadata;
}

export function resetTemplateCache(): void {
  templateCache.clear();
  compileCount = 0;
}

export type CompileTemplateMetadata = (
  ctx: Ctx,
  tag: TemplateTag,
) => TemplateMetadata;

let compileMetadata: CompileTemplateMetadata | null = null;

export function registerTemplateMetadataCompiler(
  compile: CompileTemplateMetadata,
): void {
  compileMetadata = compile;
}

/** Returns cached metadata, compiling the tag unit on a cache miss. */
export function metadataForTemplate(
  ctx: Ctx,
  tag: TemplateTag,
): TemplateMetadata {
  const cached = templateCache.get(tag.filename);
  if (
    cached &&
    cached.mtimeMs === tag.mtimeMs &&
    cached.source === tag.source
  ) {
    return cached.metadata;
  }
  if (!compileMetadata) {
    throw new Error(
      "@mxlang/core: the template metadata compiler was not registered; import `lower.ts` before lowering a template tag",
    );
  }

  // A provisional entry breaks direct and mutual recursion while the unit is
  // being compiled: a nested call back to this same file finds it and returns
  // rather than recursing forever. It is marked `pending`, because its
  // metadata is a placeholder and not an answer — the cache is process-global,
  // so a caller that reaches this file by another route while the compile is
  // in flight would otherwise read `readsContent: false` and warn that a body
  // was dropped by a template that does read it.
  const provisional: CacheEntry = {
    mtimeMs: tag.mtimeMs,
    source: tag.source,
    metadata: { readsContent: false, attributeTags: [], pending: true },
    pending: true,
  };
  templateCache.set(tag.filename, provisional);
  compileCount++;
  try {
    const metadata = compileMetadata(ctx, tag);
    touchAndEvict(
      templateCache,
      tag.filename,
      { mtimeMs: tag.mtimeMs, source: tag.source, metadata },
      MAX_CACHED_TEMPLATES,
    );
    return metadata;
  } catch (error) {
    templateCache.delete(tag.filename);
    if (error instanceof TranslateError && error.file === undefined) {
      const positioned = new TranslateError(
        error.message,
        error.line,
        error.column,
        tag.filename,
      );
      const carried = (error as { [CALLEE_INPUT_ERROR]?: unknown })[
        CALLEE_INPUT_ERROR
      ];
      if (carried !== undefined) {
        Object.defineProperty(positioned, CALLEE_INPUT_ERROR, {
          value: carried,
        });
      }
      throw positioned;
    }
    throw error;
  }
}

/**
 * One member read off `input`, however it was spelled.
 *
 * Matches a `MemberExpression`/`OptionalMemberExpression` chain rooted at the
 * identifier `input`: dot or bracket access, with or without `?.`, optionally
 * followed by a `.content`/`?.content` read of that member (`input.head`,
 * `input?.head`, `input["head"]`, `input?.["head"]`, `input.head?.content`).
 * AST-based rather than the regex this replaced, because a regex has to grow
 * one branch per spelling and a caller only ever wrote one more of them.
 */
/**
 * Whether an `Identifier` node named `input` refers to the template's own
 * `input` parameter rather than a local binding that shadows it — a callback
 * parameter, a nested function's parameter, or a tag param, all spelled
 * `input`. `path.scope.getBinding("input")` resolves to whichever binding is
 * actually in scope at that reference; the template's own `input` is never a
 * real binding in this parsed-in-isolation AST (it is a compile-time
 * synthetic, not a JS declaration the parser sees), so "no binding found"
 * is exactly the case that means "this is the real one".
 */
function isRealInput(path: Node): boolean {
  return (
    path.node.name === "input" && path.scope.getBinding("input") === undefined
  );
}

const propertyNameOf = (
  node: Node,
): { name: string | null; dynamic: boolean } => {
  if (!node.computed) {
    return {
      name: node.property.type === "Identifier" ? node.property.name : null,
      dynamic: false,
    };
  }
  if (node.property.type === "StringLiteral") {
    return { name: node.property.value, dynamic: false };
  }
  return { name: null, dynamic: true };
};

const isMemberOf = (node: Node): boolean =>
  node.type === "MemberExpression" || node.type === "OptionalMemberExpression";

/**
 * One member read off `input`, however it was spelled — or `"dynamic"` when
 * the read exists but its key cannot be determined statically
 * (`input[someVariable]`), which must be treated the same as a spread: it
 * may read anything, so it can never be the source of a false "was dropped"
 * warning.
 *
 * Matches a `MemberExpression`/`OptionalMemberExpression` chain rooted at the
 * identifier `input`: dot or bracket access, with or without `?.`, optionally
 * followed by a `.content`/`?.content` read of that member (`input.head`,
 * `input?.head`, `input["head"]`, `input?.["head"]`, `input.head?.content`).
 * Scope-aware: a local binding named `input` (a callback parameter, a tag
 * param) does not count — see `isRealInput`. AST-based rather than the regex
 * this replaced, because a regex has to grow one branch per spelling and a
 * caller only ever wrote one more of them.
 */
export function inputMember(
  code: string,
): { name: string; content: boolean } | "dynamic" | null {
  let expr: Node;
  try {
    expr = markoBabel().parseExpression(code.trim());
  } catch {
    return null;
  }

  let content = false;
  let target = expr;
  if (isMemberOf(target) && propertyNameOf(target).name === "content") {
    content = true;
    target = target.object;
  }
  if (!isMemberOf(target)) return null;
  if (target.object.type !== "Identifier" || target.object.name !== "input") {
    return null;
  }

  // A bare parsed expression carries no scope info of its own; wrap it in a
  // Program and traverse so `path.scope` resolves bindings (e.g. an
  // enclosing arrow's `input` parameter) the same way `scanCodeForInputMembers`
  // does.
  let real = true;
  try {
    const { traverse, types: t } = markoBabel();
    const program = t.program([t.expressionStatement(expr)]);
    traverse(program, {
      Identifier(path: Node) {
        if (path.node === target.object) {
          real = isRealInput(path);
        }
      },
    });
  } catch {
    // Fall through: if traversal fails, trust the syntactic match.
  }
  if (!real) return null;

  const { name, dynamic } = propertyNameOf(target);
  if (dynamic) return "dynamic";
  if (!name) return null;
  return { name, content };
}

/**
 * Whether `code` spreads `input` wholesale (`...input`), which reads every
 * property — `<@x>` and `input.content` alike — no matter what a caller
 * later does with the copy.
 */
function spreadsInput(code: string): boolean {
  let found = false;
  try {
    const { traverse } = markoBabel();
    const expr = markoBabel().parse(code, { allowReturnOutsideFunction: true });
    traverse(expr, {
      SpreadElement(path: Node) {
        if (
          path.node.argument.type === "Identifier" &&
          path.node.argument.name === "input"
        ) {
          found = true;
        }
      },
    });
  } catch {
    return false;
  }
  return found;
}

/**
 * Every member read off `input` found anywhere inside `code`, not only as
 * the expression's whole value — a template that writes
 * `input.content ? a : b`, wraps a read in `<if=input.head?.content>`, or
 * hands `input.head` to a function still read that member.
 *
 * Scope-aware, same as `inputMember`: a reference to a local binding named
 * `input` (a callback parameter shadowing the template's own `input`) is
 * skipped, not recorded. `dynamic` comes back `true` when a computed member
 * with a non-literal key is found (`input[someVariable]`) — it may read
 * anything, so the caller must treat it the same as a spread.
 *
 * The fallback for any node whose `.code` isn't one of the specific sites
 * `inputMember` checks against exactly (a `<static>` block, an `<if>`
 * condition, a `<const>` initializer used in a larger expression, an
 * attribute value). AST-based over the same
 * `MemberExpression`/`OptionalMemberExpression` shapes `inputMember`
 * matches, so `input?.head` is caught the same way `input.head` is.
 */
function scanCodeForInputMembers(code: string): {
  members: Array<{ name: string; content: boolean }>;
  dynamic: boolean;
} {
  const members: Array<{ name: string; content: boolean }> = [];
  let dynamic = false;
  try {
    const { traverse } = markoBabel();
    const expr = markoBabel().parse(code, { allowReturnOutsideFunction: true });
    traverse(expr, {
      "MemberExpression|OptionalMemberExpression"(path: Node) {
        const node = path.node;
        if (node.object.type !== "Identifier" || node.object.name !== "input") {
          return;
        }
        if (!isRealInput({ node: node.object, scope: path.scope })) return;
        const { name, dynamic: computed } = propertyNameOf(node);
        if (computed) {
          dynamic = true;
        } else if (name) {
          members.push({ name, content: name === "content" });
        }
      },
    });
  } catch {
    return { members: [], dynamic: false };
  }
  return { members, dynamic };
}

/**
 * The property names a binding pattern's source text destructures, when that
 * pattern is bound directly to `input` — `<const/{ head }=input/>` or
 * `const { head } = input`. `patternCode` is the declaration site's printed
 * pattern (`Const.name`); `initCode` is its initializer.
 *
 * Only a plain, non-computed, non-renamed shorthand or `x: y` property is
 * recognized as a named member — a nested pattern inside a property is
 * treated as "not a simple member list" and the whole destructure is
 * ignored, which is conservative: it can miss a read, never fabricate one
 * that would suppress a real warning.
 *
 * A rest element (`const { head, ...rest } = input`) is different: `rest`
 * itself is a copy of every *other* property of `input`, so it reads
 * everything the same way a bare `...input` spread does. `dynamic` comes
 * back `true` in that case — the caller treats it exactly like
 * `scanCodeForInputMembers`'s dynamic flag — while the named properties
 * before the rest are still returned in `names`.
 */
function destructuredInputMembers(
  patternCode: string,
  initCode: string,
): { names: string[]; dynamic: boolean } {
  if (initCode.trim() !== "input") return { names: [], dynamic: false };
  let pattern: Node;
  try {
    pattern = markoBabel().parseExpression(`(${patternCode.trim()} = 0)`);
  } catch {
    return { names: [], dynamic: false };
  }
  if (pattern.type !== "AssignmentExpression") {
    return { names: [], dynamic: false };
  }
  const left = pattern.left;
  if (!left || left.type !== "ObjectPattern") {
    return { names: [], dynamic: false };
  }
  const names: string[] = [];
  let dynamic = false;
  for (const prop of left.properties) {
    if (prop.type === "RestElement") {
      dynamic = true;
      continue;
    }
    if (prop.type !== "ObjectProperty" || prop.computed) {
      return { names: [], dynamic: false };
    }
    if (prop.key.type !== "Identifier") return { names: [], dynamic: false };
    names.push(prop.key.name);
  }
  return { names, dynamic };
}

/** Computes the public metadata of one already-lowered tag unit. */
export function metadataOfIr(
  ir: Pick<Ir, "body"> &
    Partial<Pick<Ir, "returnValue" | "inputInterface" | "hoisted" | "imports">>,
): TemplateMetadata {
  let readsContent = false;
  let readsAllInput = false;
  const attributeTags = new Set<string>();
  const seen = new Set<object>();

  const record = (
    member: { name: string; content: boolean } | "dynamic" | null,
  ): void => {
    if (!member) return;
    if (member === "dynamic") {
      readsAllInput = true;
      return;
    }
    if (member.content) readsContent = true;
    else attributeTags.add(member.name);
  };

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const node = value as Partial<IrNode> & Record<string, unknown>;
    if (node.kind === "Component") {
      const component = node as Extract<IrNode, { kind: "Component" }>;
      if (component.target.kind === "dynamic") {
        record(inputMember(component.target.expr.code));
      }
    }
    if (node.kind === "Interpolation") {
      const interpolation = node as Extract<IrNode, { kind: "Interpolation" }>;
      record(inputMember(interpolation.expr.code));
    }
    if (node.kind === "DelegatedTag") {
      const data = (node as Extract<IrNode, { kind: "DelegatedTag" }>).tag
        .data as { kind?: string; expr?: { code?: string } } | undefined;
      if (data?.kind === "dynamic" && typeof data.expr?.code === "string") {
        record(inputMember(data.expr.code));
      }
    }
    if ((value as { kind?: string }).kind === "dynamic") {
      const expr = (value as { expr?: { code?: string } }).expr;
      if (typeof expr?.code === "string") record(inputMember(expr.code));
    }
    if (node.kind === "Const") {
      const decl = node as Extract<IrNode, { kind: "Const" }>;
      const destructured = destructuredInputMembers(decl.name, decl.init.code);
      for (const name of destructured.names) attributeTags.add(name);
      if (destructured.dynamic) readsAllInput = true;
      if (spreadsInput(decl.init.code)) readsAllInput = true;
    }
    if (typeof node.code === "string") {
      const scanned = scanCodeForInputMembers(node.code);
      for (const member of scanned.members) record(member);
      if (scanned.dynamic) readsAllInput = true;
      if (spreadsInput(node.code)) readsAllInput = true;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "node") visit(child);
    }
  };

  visit(ir.body);
  // A `static` block lives in `ir.hoisted`, not `ir.body` — a spread or
  // member read written there (`static const props = {...input}`) is a real
  // read of the tag's own `input`, so it must feed the same scan the body
  // gets rather than being invisible to it.
  visit(ir.hoisted);
  if (readsAllInput) readsContent = true;
  const metadata: TemplateMetadata = {
    readsContent,
    attributeTags: [...attributeTags],
    ...(readsAllInput ? { readsAllInput: true } : {}),
  };
  // Only when there is one: the field's absence is what every existing
  // caller (and every cached entry written before `<return>` shipped) reads
  // as "this unit returns output only".
  if (ir.returnValue) {
    metadata.returnsValue = true;
    metadata.returnValueCode = ir.returnValue.code;
  }
  // The callee-Input reader's sources (decision 106). The exported interface
  // is the primary source; the static blocks and authored imports are the
  // alias/import-type channel a `type Input` in `<static>` or an attribute-
  // tag config alias may live in. Synthesized imports are skipped: their
  // targets are template units, not type sources.
  if (ir.inputInterface) metadata.inputCode = ir.inputInterface.code;
  const aux: string[] = [];
  for (const node of ir.imports ?? []) {
    if (!node.synthesized) aux.push(node.code);
  }
  for (const node of ir.hoisted ?? []) {
    if (node.kind === "Static" || node.kind === "Export") aux.push(node.code);
  }
  if (aux.length > 0) metadata.inputAuxCode = aux.join("\n");
  const exported = (ir.hoisted ?? [])
    .filter((node) => node.kind === "Export")
    .map((node) => node.code);
  if (exported.length > 0) metadata.hoistedExports = exported;
  return metadata;
}

/** Records an authored default import so discovery can reuse it by path. */
export function registerAuthoredTemplateImport(ctx: Ctx, code: string): void {
  try {
    const declaration = markoBabel().parse(code, {
      sourceType: "module",
    }).program.body[0];
    if (declaration?.type !== "ImportDeclaration") return;
    const local = declaration.specifiers.find(
      (specifier: { type?: string }) =>
        specifier.type === "ImportDefaultSpecifier",
    )?.local?.name;
    const source = declaration.source?.value;
    if (typeof local !== "string" || typeof source !== "string") return;
    if (!(source.startsWith(".") || isAbsolute(source))) return;
    const path = isAbsolute(source)
      ? resolve(source)
      : resolve(dirname(ctx.filename), source);
    ctx.customTagImports ??= new Map();
    if (!ctx.customTagImports.has(path)) ctx.customTagImports.set(path, local);
  } catch {
    // `importBindings` already validated the statement as far as lowering
    // needs. A form this optional dedupe pass cannot parse is simply authored.
  }
}

function importSpecifier(caller: string, template: string): string {
  let specifier = relative(dirname(caller), template).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function generatedBinding(ctx: Ctx, tagName: string): string {
  const safe = tagName.replace(/[^A-Za-z0-9_$]/g, "_");
  const hint = /^[A-Za-z_$]/.test(safe) ? safe : `Tag_${safe}`;
  let binding: string;
  do {
    binding = `$mx_${hint[0]?.toUpperCase() ?? "T"}${hint.slice(1)}${++ctx.customTagGensym.n}`;
  } while (
    ctx.imports.has(binding) ||
    ctx.defines.has(binding) ||
    new RegExp(`(^|[^\\w$])${binding.replaceAll("$", "\\$")}([^\\w$]|$)`).test(
      ctx.source,
    )
  );
  return binding;
}

/**
 * The binding for a taglib-discovered tag's module (`tags/badge.marko`),
 * importing it on first use.
 *
 * Mirrors what Marko emits for such a tag: `import _badge from
 * "./tags/badge.marko"`, a default import with the extension kept, named with
 * Babel's `generateUid` rule (`_` + camelCased tag name, a numeric suffix on a
 * collision), one import per module.
 */
export function bindingForDiscoveredModule(
  ctx: Ctx,
  path: string,
  tagName: string,
  loc: TagCall["loc"],
): string {
  path = resolve(path);
  // A tag file calling itself already has its own function in scope.
  if (path === resolve(ctx.filename) && ctx.exportName) return ctx.exportName;

  ctx.customTagImports ??= new Map();
  const existing = ctx.customTagImports.get(path);
  if (existing) return existing;

  const camel = tagName
    .replace(/[^A-Za-z0-9_$]+(.)?/g, (_, c: string | undefined) =>
      c ? c.toUpperCase() : "",
    )
    .replace(/^[_$\d]+/, "");
  const base = `_${camel || "tag"}`;
  let binding = base;
  for (let n = 2; isTaken(ctx, binding); n++) binding = `${base}${n}`;

  const specifier = importSpecifier(ctx.filename, path);
  ctx.customTagImports.set(path, binding);
  ctx.imports.add(binding);
  ctx.customTagImportNodes ??= [];
  ctx.customTagImportNodes.push({
    kind: "Import",
    code: `import ${binding} from ${JSON.stringify(specifier)}`,
    bindings: [binding],
    loc,
    end: loc,
    synthesized: true,
    specifier,
    resolvedPath: path,
  });
  return binding;
}

function isTaken(ctx: Ctx, binding: string): boolean {
  return (
    ctx.imports.has(binding) ||
    ctx.defines.has(binding) ||
    new RegExp(`(^|[^\\w$])${binding.replaceAll("$", "\\$")}([^\\w$]|$)`).test(
      ctx.source,
    )
  );
}

function bindingForTemplate(ctx: Ctx, tag: TemplateTag, call: TagCall): string {
  const path = resolve(tag.filename);

  if (path === resolve(ctx.filename)) {
    // A tag calling *itself* already has the function in scope: it is the
    // declaration this module exports. Importing the file into itself is
    // legal ESM and does work, but it is a module importing a binding it
    // already has, and design invariant §7.5-7 rules it out — "the tag's
    // render function is a named declaration, so self-recursion needs no
    // import".
    if (ctx.exportName) return ctx.exportName;

    // Unless there is no declaration to call. A host module **region** is an
    // expression spliced into someone else's module, so it exports nothing
    // and has no name for a self-call to resolve to. Returning one anyway
    // emitted a reference to a binding nothing declares — valid-looking JSX
    // that fails at runtime with no diagnostic anywhere.
    throw new TranslateError(
      `\`<${call.name}>\` is this file's own tag, and a host module region (an expression spliced into another module) has no module scope to declare it in; call it from a file that compiles to a module, or move the markup into its own tag file`,
      call.loc.line,
      call.loc.column,
      call.loc.file,
    );
  }

  ctx.customTagImports ??= new Map();
  const existing = ctx.customTagImports.get(path);
  if (existing) return existing;

  const binding = generatedBinding(ctx, call.name);
  const specifier = importSpecifier(ctx.filename, path);
  ctx.customTagImports.set(path, binding);
  ctx.imports.add(binding);
  ctx.customTagImportNodes ??= [];
  ctx.customTagImportNodes.push({
    kind: "Import",
    code: `import ${binding} from ${JSON.stringify(specifier)}`,
    bindings: [binding],
    loc: call.loc,
    end: call.loc,
    synthesized: true,
    specifier,
    resolvedPath: path,
  });
  return binding;
}

function rejectReservedInputs(call: TagCall): void {
  for (const attr of call.attrs) {
    if (attr.kind === "spread" || attr.name !== "content") continue;
    throw new TranslateError(
      `\`<${call.name}>\`: \`content\` is reserved on a template tag; it names the body slot`,
      attr.loc.line,
      attr.loc.column,
      attr.loc.file,
    );
  }
  const contentTag = call.attributeTags.find((tag) => tag.name === "content");
  if (contentTag) {
    throw new TranslateError(
      `\`<@content>\` is reserved for the body of \`<${call.name}>\``,
      contentTag.loc.line,
      contentTag.loc.column,
      contentTag.loc.file,
    );
  }
}

/** Routes one discovered template tag through the ordinary component IR. */
export function routeTemplateCall(
  ctx: Ctx,
  definition: TemplateBackedTag,
  call: TagCall,
): IrNode[] {
  rejectReservedInputs(call);
  const tag = definition.template;
  const metadata = metadataForTemplate(ctx, tag);
  // A pending unit is mid-compile (this call is inside its own recursion, or
  // another route reached it first), so what it reads is not known yet. Both
  // warnings below are silent-drop reports, and reporting one off a
  // placeholder would accuse a template that does place the content.
  if (call.content && !metadata.readsContent && !metadata.pending) {
    warn(ctx, {
      message: `\`<${call.name}>\`: body content was dropped; ${tag.filename} has no \`<\${input.content}/>\` placeholder`,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }
  for (const attributeTag of call.attributeTags) {
    if (metadata.pending || metadata.readsAllInput) break;
    if (metadata.attributeTags.includes(attributeTag.name)) continue;
    warn(ctx, {
      message: `\`<${call.name}>\`: \`<@${attributeTag.name}>\` was dropped; ${tag.filename} does not read \`input.${attributeTag.name}\``,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }

  // `/var` binds what the unit returns, so a unit that returns nothing has
  // nothing to bind and the binding would read `undefined` at run time with
  // no diagnostic anywhere. A pending unit is mid-compile and its
  // `returnsValue` is a placeholder, so the call is let through rather than
  // accused: the same unit's own compile validates its `<return>`, and a
  // self-recursive call that binds its own result is legal.
  if (call.var && !metadata.returnsValue && !metadata.pending) {
    throw new TranslateError(
      `\`<${call.name}>\` does not return a value; add \`<return value=…/>\` to ${tag.filename} to bind it with \`/var\``,
      call.loc.line,
      call.loc.column,
      call.loc.file,
    );
  }

  const attributeTagTree =
    call.attributeTagTree ??
    call.attributeTags.map((attributeTag) => ({
      kind: "AttributeTag" as const,
      tag: attributeTag,
      loc: attributeTag.loc,
    }));
  const attrTagProps =
    call.attrTagProps ??
    [
      ...new Set(call.attributeTags.map((attributeTag) => attributeTag.name)),
    ].map((name) => ({
      name,
      cardinality:
        call.attributeTags.filter((attributeTag) => attributeTag.name === name)
          .length > 1
          ? ("array" as const)
          : ("single" as const),
      as: "data" as const,
      source: attributeTagTree.filter(
        (item) => item.kind === "AttributeTag" && item.tag.name === name,
      ),
    }));

  return [
    {
      kind: "Component",
      target: { kind: "name", name: bindingForTemplate(ctx, tag, call) },
      nameSpan: null,
      attrs: call.attrs,
      content: call.content,
      attributeTags: call.attributeTags,
      attributeTagTree,
      attrTagProps,
      args: [],
      // Carried to the emitters because the `{ value, output }` shape is
      // invisible at the call site: a host cannot compile the callee to find
      // out how to unwrap the result, and the answer is the same on all six.
      var: call.var,
      returnsValue: metadata.returnsValue === true,
      // The call routes to a generated binding, so a host reporting on this
      // call has to be able to name the tag as written.
      authoredName: call.name,
      loc: call.loc,
    },
  ];
}
