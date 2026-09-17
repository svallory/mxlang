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
import type { Ctx } from "./core.ts";
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
    // Deleted before being re-set so insertion order is true recency: `set` on
    // an existing key keeps its original ordinal, which would let the eviction
    // below drop the entry just computed.
    templateCache.delete(tag.filename);
    templateCache.set(tag.filename, {
      mtimeMs: tag.mtimeMs,
      source: tag.source,
      metadata,
    });
    while (templateCache.size > MAX_CACHED_TEMPLATES) {
      const oldest = templateCache.keys().next();
      // Never evict the entry this call just produced, even at the bound.
      if (oldest.done || oldest.value === tag.filename) break;
      templateCache.delete(oldest.value);
    }
    return metadata;
  } catch (error) {
    templateCache.delete(tag.filename);
    if (error instanceof TranslateError && error.file === undefined) {
      throw new TranslateError(
        error.message,
        error.line,
        error.column,
        tag.filename,
      );
    }
    throw error;
  }
}

function inputMember(code: string): string | null {
  const match = code.trim().match(/^input\.([A-Za-z_$][\w$]*)(?:\.content)?$/);
  return match?.[1] ?? null;
}

/** Computes the public metadata of one already-lowered tag unit. */
export function metadataOfIr(
  ir: Pick<Ir, "body"> & Partial<Pick<Ir, "returnValue">>,
): TemplateMetadata {
  let readsContent = false;
  const attributeTags = new Set<string>();
  const seen = new Set<object>();

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
        const member = inputMember(component.target.expr.code);
        if (member === "content") readsContent = true;
        else if (member) attributeTags.add(member);
      }
    }
    if (node.kind === "Interpolation") {
      const interpolation = node as Extract<IrNode, { kind: "Interpolation" }>;
      const member = inputMember(interpolation.expr.code);
      if (member === "content") readsContent = true;
      else if (member) attributeTags.add(member);
    }
    if (node.kind === "HostTag") {
      const data = (node as Extract<IrNode, { kind: "HostTag" }>).tag.data as
        | { kind?: string; expr?: { code?: string } }
        | undefined;
      if (data?.kind === "dynamic" && typeof data.expr?.code === "string") {
        const member = inputMember(data.expr.code);
        if (member === "content") readsContent = true;
        else if (member) attributeTags.add(member);
      }
    }
    if ((value as { kind?: string }).kind === "dynamic") {
      const expr = (value as { expr?: { code?: string } }).expr;
      if (typeof expr?.code === "string") {
        const member = inputMember(expr.code);
        if (member === "content") readsContent = true;
        else if (member) attributeTags.add(member);
      }
    }
    if (typeof node.code === "string") {
      if (/\binput\.content\b/.test(node.code)) readsContent = true;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "node") visit(child);
    }
  };

  visit(ir.body);
  const metadata: TemplateMetadata = {
    readsContent,
    attributeTags: [...attributeTags],
  };
  // Only when there is one: the field's absence is what every existing
  // caller (and every cached entry written before `<return>` shipped) reads
  // as "this unit returns output only".
  if (ir.returnValue) {
    metadata.returnsValue = true;
    metadata.returnValueCode = ir.returnValue.code;
  }
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

    // Unless there is no declaration to call. A `.solid.mx` **region** is an
    // expression spliced into someone else's module, so it exports nothing
    // and has no name for a self-call to resolve to. Returning one anyway
    // emitted a reference to a binding nothing declares — valid-looking JSX
    // that fails at runtime with no diagnostic anywhere.
    throw new TranslateError(
      `\`<${call.name}>\` is this file's own tag, and a \`.solid.mx\` region has no module scope to declare it in; call it from a file that compiles to a module, or move the markup into its own tag file`,
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
    if (metadata.pending) break;
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

  return [
    {
      kind: "Component",
      target: { kind: "name", name: bindingForTemplate(ctx, tag, call) },
      nameSpan: null,
      attrs: call.attrs,
      content: call.content,
      attributeTags: call.attributeTags,
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
