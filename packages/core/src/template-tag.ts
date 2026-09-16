/**
 * L1 custom tags: a `tags/icon.mx` template inlined at its call site.
 *
 * A template tag is, in one sentence, **a `<define>` that lives in another
 * file and is invoked by tag name** (report §II.5.3). The template is lowered
 * to ordinary IR by the same `lower()` every file goes through, and its roots
 * are spliced where the call was — so a host sees an `Element`, an `IfChain`
 * and a `For`, never a custom tag, and all six hosts render the same bytes
 * without one line of host code.
 *
 * ## What the call site becomes
 *
 * | Call-site construct | Template side | Mechanism |
 * |---|---|---|
 * | attributes | `input.name` | the attribute's own expression, substituted |
 * | body content | `<${input.content}/>` | the call's already-lowered `Block` spliced at the placeholder |
 * | `<@name>` tags | `input.name.content` | the same splice, keyed by name; repeats stay repeats |
 * | body params | `<${input.content}(a, b)/>` | `Block.params`, scoped by `shadowBindings` |
 *
 * `input` is **substituted**, not bound. The report sketched the opposite —
 * bind one synthetic `Const` holding the attributes and leave the template's
 * `input.x` reads alone — on the grounds that it is obviously correct and the
 * substitution is a later optimization. Measured against the six hosts, it is
 * not available: a `Const` is a statement, and the four JSX hosts emit a
 * template body as one expression, where a statement cannot go. See
 * `substituteInput` for the full note.
 *
 * ## Hygiene
 *
 * A template may not introduce a binding its caller can see. Every
 * render-scope name a template declares (`<const>`, `<define>`) is renamed to
 * a `gensym` name and its references rewritten with it, so the caller cannot
 * reach it and a caller that happens to use the same name is unaffected. The
 * module-level declarations a template makes (`import`, `static`, `export`)
 * are hoisted to the caller's *module*, which is where the template's helpers
 * have to live for its body to reach them.
 *
 * ## Positions — the third rule
 *
 * Nodes lowered from the template carry the **template file's** line and
 * column, tagged with that file through `Position.file`. A diagnostic raised
 * inside `tags/icon.mx` therefore points into `tags/icon.mx`; a diagnostic
 * about the call (a missing attribute, a bad value) keeps the caller's
 * position, because it is raised against the call's own nodes before the
 * template is ever lowered.
 */

import {
  type Ctx,
  markoBabel,
  type Node,
  TranslateError,
  warn,
} from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { AttributeTag, Block, IrNode, Position } from "./ir.ts";

/**
 * A tag backed by a template file.
 *
 * The scan (P2) produces these; a test registers one directly. `source` is the
 * template's text and `filename` its path — both are needed rather than just
 * the path, so a caller holding an unsaved editor buffer can expand it.
 */
export interface TemplateTag {
  filename: string;
  source: string;
  /**
   * The template's last-modified time, when the caller read it from disk.
   * Part of the resolved-IR cache key, so an edited template recompiles and an
   * unedited one is compiled once however many call sites it has.
   */
  mtimeMs?: number;
}

/** A `CustomTag` that carries a template, with or without sidecar hooks. */
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

/**
 * The placeholder a template writes to receive the call's body: `<${input.content}/>`.
 *
 * It is an ordinary dynamic-tag call in MX, so it needs no new syntax — which
 * is what the subset rule requires. Recognized by the *shape* of the resolved
 * expression rather than by its spelling, so `input.content` and
 * `input.header.content` are both matched by the same test.
 */
const CONTENT_SUFFIX = ".content";
const INPUT_PREFIX = "input.";

/** `input.content` -> the body; `input.header.content` -> that attribute tag. */
export function contentSlotOf(code: string): string | null {
  const trimmed = code.trim();
  if (trimmed === `${INPUT_PREFIX}content`) return "";
  if (!trimmed.startsWith(INPUT_PREFIX) || !trimmed.endsWith(CONTENT_SUFFIX)) {
    return null;
  }
  const middle = trimmed.slice(
    INPUT_PREFIX.length,
    trimmed.length - CONTENT_SUFFIX.length,
  );
  return /^[A-Za-z_$][\w$]*$/.test(middle) ? middle : null;
}

/**
 * Stamps every position produced by lowering a template with its file.
 *
 * The walk is over the lowered IR rather than the Marko tree: positions are
 * shared objects in Marko's own tree (see `fragment.ts`), and the IR's `loc`
 * values may well be those same objects, so it dedupes by identity for the
 * same reason — a position visited twice must not be tagged twice, and more
 * importantly a position shared with the *caller's* tree must never be tagged
 * at all. Lowering a template uses its own `Ctx` over its own source, so no
 * caller position can be reached from here.
 */
function tagPositions(value: unknown, file: string, seen: Set<object>): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) tagPositions(item, file, seen);
    return;
  }
  if (value instanceof Map) {
    for (const [key, child] of value) {
      tagPositions(key, file, seen);
      tagPositions(child, file, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const child of value) tagPositions(child, file, seen);
    return;
  }
  // An `Expr` carries no `loc` of its own — consumers read the position off
  // the Marko/Babel `node` it came from — so the file is recorded on the
  // expression itself. The TypeScript plugin's mapping pass asks exactly this
  // question of exactly these two shapes, and an expression whose source text
  // lives in another file is the main thing it must not map.
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && "shape" in record) {
    if (record.file === undefined) record.file = file;
  }

  for (const [key, child] of Object.entries(record)) {
    // `node` is the Marko/Babel node an expression came from. Its positions
    // belong to the template too, but they are the parser's own shared
    // objects — shared with sibling nodes, as `fragment.ts` measured — and a
    // `file` written onto one would reach nodes this walk never visited.
    if (key === "node") continue;
    if ((key === "loc" || key === "end") && isPosition(child)) {
      if (child.file === undefined) child.file = file;
      continue;
    }
    tagPositions(child, file, seen);
  }
}

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Position>;
  return (
    typeof candidate.line === "number" && typeof candidate.column === "number"
  );
}

/** The resolved IR of one template file, before any call's inputs are applied. */
interface CompiledTemplate {
  body: IrNode[];
  /** Module-level nodes the template declared, hoisted into the caller's module. */
  module: IrNode[];
  /** Calls nested anywhere in this template, including nested templates. */
  customTagCalls: Map<string, TagCall[]>;
  /** Custom tags used anywhere in this template, including nested templates. */
  customTagsUsed: Set<string>;
}

interface CacheEntry extends CompiledTemplate {
  mtimeMs: number | undefined;
  source: string;
}

/**
 * Resolved template IR, keyed by path and mtime.
 *
 * Process-wide and deliberately so: two call sites in one file, and two files
 * in one build, both compile a shared `tags/icon.mx` once. The value is only
 * ever read through `structuredCloneIr`, so a cached entry cannot be mutated
 * by the expansion that borrowed it.
 */
const templateCache = new Map<string, CacheEntry>();

/**
 * How many template files the cache keeps.
 *
 * The cache is process-wide, and a language server compiling an edited file
 * over and over is a long-lived process, so an unbounded map is a leak with no
 * upper bound but the number of distinct tag files a session ever touches.
 * The map is insertion-ordered, so the oldest key is the first one `keys()`
 * yields and eviction is exact LRU on *insertion*, not on use — a bound, not a
 * tuned policy. 256 is far above any plausible tag-directory size, so a real
 * project never evicts and the cap only catches pathology.
 *
 * This matches the discipline P2's own scan cache is required to keep (see
 * `AGENTS.md` on the injected-taglib id's lifetime).
 */
const MAX_CACHED_TEMPLATES = 256;

/** Test seam: how many times a template file was actually lowered. */
let compileCount = 0;

export function templateCompileCount(): number {
  return compileCount;
}

export function resetTemplateCache(): void {
  templateCache.clear();
  compileCount = 0;
}

/**
 * Deep-copies resolved template IR so each call site owns its nodes.
 *
 * Every expansion splices the call's own content into the template's tree and
 * carries the call's own `Const`, so sharing nodes between two call sites
 * would let the second expansion see the first one's body. `node` (the Marko
 * node an expression came from) is shared by reference on purpose: it is read
 * for its shape and its `loc`, never written.
 */
function cloneIr<T>(value: T, seen = new Map<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneIr(item, seen));
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) {
    copy[key] = key === "node" ? child : cloneIr(child, seen);
  }
  return copy as T;
}

/**
 * Lowers one template file to IR, once per (path, mtime, source).
 *
 * The template gets its **own `Ctx`**, over its own source text, with the
 * caller's host declarations and lookup. That is what makes the third position
 * rule fall out rather than being bolted on: every `fail()` inside the
 * template's own lowering already measures against the template's source, so
 * only the file name has to be attached afterwards. It is also the hygiene
 * boundary — the template's `ctx.bindings`, `ctx.defines` and `ctx.imports`
 * are its own, so a `<define>` or an `import` binding it declares is invisible
 * to the caller.
 */
function compileTemplate(
  ctx: Ctx,
  tag: TemplateTag,
  lowerFile: LowerFile,
): CompiledTemplate {
  const key = tag.filename;
  const cached = templateCache.get(key);
  if (
    cached &&
    cached.mtimeMs === tag.mtimeMs &&
    // An unsaved buffer has no mtime to change, so compare the text as well:
    // without it an editor's every keystroke would reuse the first expansion.
    cached.source === tag.source
  ) {
    replayCustomTagMetadata(ctx, cached);
    return cached;
  }

  compileCount++;
  const compiled = lowerFile(ctx, tag);
  tagPositions(compiled, tag.filename, new Set());
  replayCustomTagMetadata(ctx, compiled);
  // An analyze-only lower deliberately suppresses every transform, so its IR
  // is scratch output rather than a valid expansion. It may discover nested
  // calls, but it must not poison the process-wide template cache that the
  // real walk consults immediately afterward.
  if (ctx.customTagAnalyzePass) return compiled;
  // A miss means this key's entry is stale or absent, so a stale one goes
  // whether or not the file still exists; and a file that has been deleted
  // cannot be compiled again, so its entry is dropped rather than kept
  // against a path that no longer resolves.
  templateCache.delete(key);
  templateCache.set(key, {
    ...compiled,
    mtimeMs: tag.mtimeMs,
    source: tag.source,
  });
  while (templateCache.size > MAX_CACHED_TEMPLATES) {
    const oldest = templateCache.keys().next();
    if (oldest.done) break;
    templateCache.delete(oldest.value);
  }
  return compiled;
}

/** Replays one template's transitive custom-tag facts into its caller. */
function replayCustomTagMetadata(ctx: Ctx, compiled: CompiledTemplate): void {
  for (const name of compiled.customTagsUsed) {
    ctx.customTagsUsed ??= new Set();
    ctx.customTagsUsed.add(name);
  }

  const destinations = [
    ctx.customTagTemplateCalls,
    ctx.customTagAnalyzePass?.calls,
  ].filter(
    (calls, index, all): calls is Map<string, TagCall[]> =>
      calls !== undefined && all.indexOf(calls) === index,
  );
  for (const destination of destinations) {
    for (const [name, calls] of compiled.customTagCalls) {
      const recorded = destination.get(name);
      const copies = calls.map((call) => cloneIr(call));
      if (recorded) recorded.push(...copies);
      else destination.set(name, copies);
    }
  }
}

/**
 * Parses and lowers a template file, supplied by `lower.ts`.
 *
 * Injected rather than imported: `lower.ts` already imports this module for
 * the expansion itself, and importing it back would be a cycle.
 */
export type LowerFile = (ctx: Ctx, tag: TemplateTag) => CompiledTemplate;

let lowerFile: LowerFile | null = null;

export function registerTemplateLowerer(lower: LowerFile): void {
  lowerFile = lower;
}

/**
 * Replaces every `<${input.content}/>` placeholder with the call's own blocks.
 *
 * Returns whether each slot was consumed, so the caller can warn about content
 * a template was handed and never wrote — the silent-drop class the spec's
 * test plan names explicitly.
 */
function spliceContent(
  nodes: IrNode[],
  call: TagCall,
  consumed: Set<string>,
): IrNode[] {
  const out: IrNode[] = [];
  for (const node of nodes) {
    const slot = contentSlotFor(node);
    if (slot !== null) {
      consumed.add(slot);
      out.push(...blocksFor(slot, call));
      continue;
    }
    out.push(spliceInside(node, call, consumed));
  }
  return out;
}

/**
 * The slot name a node is a placeholder for, or null when it is not one.
 *
 * Two IR shapes, because Marko produces two for the same authored syntax. A
 * placeholder written with a body or params (`<${input.content}|row|/>`) is a
 * dynamic `Component`; one written bare is an `Interpolation`, because a tag
 * whose name is an expression and which has no attributes and no body *is*
 * Marko's placeholder — the concise-mode rule AGENTS.md records. Matching only
 * the `Component` shape found neither the common `<${input.content}/>` nor
 * `${input.content}`, so the body silently vanished: exactly the class of drop
 * the warning below exists to report.
 */
function contentSlotFor(node: IrNode): string | null {
  if (node.kind === "Interpolation") return contentSlotOf(node.expr.code);
  if (node.kind === "Component" && node.target.kind === "dynamic") {
    return contentSlotOf(node.target.expr.code);
  }
  return null;
}

/**
 * The blocks that fill one slot, as IR nodes.
 *
 * A placeholder with tag params (`<${input.content}|row|/>`) is how a template
 * passes values *into* the caller's body, exactly as a component's render prop
 * does. The params are the block's own — `Block.params` already carries them
 * and `lowerBlock` already shadowed them while the body was lowered — so the
 * splice is structural and the binding work was done at the call site.
 */
function blocksFor(slot: string, call: TagCall): IrNode[] {
  if (slot === "") {
    return call.content ? [...call.content.children] : [];
  }
  const matching = call.attributeTags.filter((tag) => tag.name === slot);
  // Repeats stay repeats: two `<@item>` tags put two bodies here, in source
  // order, which is what lets a template write one placeholder and receive a
  // list.
  return matching.flatMap((tag) => tag.block.children);
}

/** Recurses into a node's child lists so a placeholder nested in one is found. */
function spliceInside(
  node: IrNode,
  call: TagCall,
  consumed: Set<string>,
): IrNode {
  switch (node.kind) {
    case "Element":
    case "For":
    case "Define":
      return {
        ...node,
        children: spliceContent(node.children, call, consumed),
      };
    case "IfChain":
      return {
        ...node,
        branches: node.branches.map((branch) => ({
          ...branch,
          children: spliceContent(branch.children, call, consumed),
        })),
      };
    case "Component":
      return {
        ...node,
        content: node.content
          ? spliceBlock(node.content, call, consumed)
          : null,
        attributeTags: node.attributeTags.map((tag) => ({
          ...tag,
          block: spliceBlock(tag.block, call, consumed),
        })),
      };
    case "HostTag":
      return {
        ...node,
        tag: {
          ...node.tag,
          children: spliceContent(node.tag.children, call, consumed),
          attributeTags: node.tag.attributeTags.map((tag) => ({
            ...tag,
            block: spliceBlock(tag.block, call, consumed),
          })),
        },
      };
    default:
      return node;
  }
}

function spliceBlock(
  block: Block,
  call: TagCall,
  consumed: Set<string>,
): Block {
  return { ...block, children: spliceContent(block.children, call, consumed) };
}

/**
 * Expands one template-backed custom tag call into ordinary IR.
 *
 * This is what `ctx.build.template(call)` calls, and what an L1-only tag (a
 * template with no sidecar, or a declaration-only sidecar with no `transform`)
 * gets implicitly. A sidecar with a `transform` wins: it may call this to use
 * the template as raw material, or ignore the template entirely and build its
 * own IR — which is what makes composition a choice the tag author makes
 * rather than one the core makes for them.
 */
export function expandTemplate(
  ctx: Ctx,
  definition: TemplateBackedTag,
  call: TagCall,
): IrNode[] {
  if (!lowerFile) {
    throw new Error(
      "@mxlang/core: the template lowerer was not registered; import `lower.ts` before expanding a template tag",
    );
  }

  checkReservedAttrs(call);

  const tag = definition.template;
  ctx.templateStack ??= [];
  const stack = ctx.templateStack;
  const cycleAt = stack.indexOf(tag.filename);
  if (cycleAt >= 0) {
    // Reported on the call that closes the cycle, naming the whole path, so an
    // author sees `a.mx -> b.mx -> a.mx` rather than only the file they are
    // looking at.
    const cycle = [...stack.slice(cycleAt), tag.filename].join(" -> ");
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag templates form a cycle: ${cycle}`,
      call.loc.line,
      call.loc.column,
      call.loc.file,
    );
  }

  stack.push(tag.filename);
  let compiled: CompiledTemplate;
  try {
    compiled = compileTemplate(ctx, tag, lowerFile);
  } catch (error) {
    // A diagnostic raised while lowering the template already measures
    // against the template's own source (it was lowered with its own `Ctx`),
    // so all that is missing is which file those numbers belong to. Attached
    // here, where the template's name is in hand, and only when the error
    // does not already name a file — a cycle two templates deep must keep the
    // innermost file, not be relabelled by each frame it unwinds through.
    if (error instanceof TranslateError && error.file === undefined) {
      throw new TranslateError(
        error.message,
        error.line,
        error.column,
        tag.filename,
      );
    }
    throw error;
  } finally {
    stack.pop();
  }

  const body = cloneIr(compiled.body);
  const consumed = new Set<string>();
  const spliced = spliceContent(body, call, consumed);

  // The silent-drop guard. Content the caller wrote and the template never
  // placed would simply vanish, which is exactly the class of bug the whole
  // policy table exists to prevent — so it is reported, loudly, naming the
  // template that should have carried a placeholder.
  if (call.content && !consumed.has("")) {
    warn(ctx, {
      message: `\`<${call.name}>\`: body content was dropped; ${tag.filename} has no \`<\${input.content}/>\` placeholder`,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }
  for (const attributeTag of uniqueNames(call.attributeTags)) {
    if (consumed.has(attributeTag)) continue;
    warn(ctx, {
      message: `\`<${call.name}>\`: \`<@${attributeTag}>\` was dropped; ${tag.filename} has no \`<\${input.${attributeTag}.content}/>\` placeholder`,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }

  // The template's own module-level statements (`import`, `static`, `export`)
  // belong to the caller's module, not to its render scope — that is where the
  // template's helpers have to live for its body to reach them, and module
  // scope is also why they cannot collide with the caller's render bindings.
  const module = dedupeImports(ctx, cloneIr(compiled.module), tag, call);

  // Hygiene. A template's render-scope declarations (`<const>`, `<define>`)
  // emit a flat `const name = …` into the *caller's* render function, where a
  // caller using the same name would silently pick up the template's binding —
  // the spec's rule that a tag may not introduce a binding the caller can see.
  // Each is renamed to a `gensym` name; the references follow in the one AST
  // pass below.
  const renames = new Map<string, string>();
  for (const declared of declaredNames(spliced)) {
    renames.set(declared, gensymFor(ctx, `${call.name}_${declared}`));
  }
  for (const node of spliced) {
    if (
      (node.kind === "Const" || node.kind === "Define") &&
      renames.has(node.name)
    ) {
      node.name = renames.get(node.name) as string;
    }
  }

  // `input` is substituted, not bound.
  //
  // The report's first sketch bound the call's attributes to one synthetic
  // `Const` and left the template's `input.x` reads alone, on the grounds that
  // it is obviously correct and the substitution is a later optimization. It
  // is not available here: a `Const` is a *statement*, and four of the six
  // hosts (Preact, React, Hono, Solid) emit a template body as a single JSX
  // expression, where a statement cannot go — all four reject a `<const>`
  // nested in markup outright, and a call site inside a `<for>` or an `<if>`
  // is exactly that position. Binding would therefore have made a template tag
  // work on two hosts and fail on four, which decision 80 forbids: one
  // definition must work on every host.
  //
  // Substituting the expressions is host-independent by construction, because
  // it produces no node a host has to be able to emit — only ordinary
  // expressions in the places the template already had them.
  //
  // **The one inherent limit: N reads are N evaluations.** A template that
  // reads `input.size` twice evaluates the caller's `size=` expression twice,
  // so a template must not read a side-effecting attribute more than once.
  // Binding would have avoided this; it is the price of the four hosts above.
  rewriteExpansion(spliced, call, renames, valuesOf(call), slotsOf(call));

  return [...module, ...spliced];
}

/**
 * Drops a template `import` the caller's module already has, and refuses an
 * ambiguous one.
 *
 * Every expansion carries its template's module statements, so without this a
 * template called three times contributes three identical `import` lines, and
 * two templates importing different modules under one local name both hoist —
 * leaving two `const`-like bindings of the same name and both bodies reading
 * whichever won, with no diagnostic.
 *
 * Identical `(binding, statement)` pairs are deduped. A collision — the same
 * local name from a different statement — is a positioned error naming both
 * files, because neither answer is right: dropping the second silently
 * miscompiles that template, and renaming it would have to rewrite an
 * arbitrary import form.
 *
 * **Why imports are not `gensym`-renamed** the way `<const>`/`<define>` are:
 * a render-scope binding is rewritten by the same AST pass that rewrites its
 * references, which is cheap because both live in the expansion. An import
 * binding is referenced from the template body *and* names a module the author
 * wrote, so renaming means rewriting the statement's own syntax (default,
 * named, aliased, namespace) as well. Deduping covers the common case — the
 * same helper imported by the same template — and the collision is rare,
 * diagnosable and actionable ("rename one of them"), so it is reported rather
 * than worked around.
 */
function dedupeImports(
  ctx: Ctx,
  module: IrNode[],
  tag: TemplateTag,
  call: TagCall,
): IrNode[] {
  ctx.templateImports ??= new Map();
  const seen = ctx.templateImports;
  const out: IrNode[] = [];

  for (const node of module) {
    if (node.kind !== "Import") {
      out.push(node);
      continue;
    }
    let duplicate = false;
    for (const binding of node.bindings) {
      const previous = seen.get(binding);
      if (!previous) {
        seen.set(binding, { code: node.code, file: tag.filename });
        continue;
      }
      if (previous.code === node.code) {
        duplicate = true;
        continue;
      }
      throw new TranslateError(
        `\`<${call.name}>\`: tag template \`${tag.filename}\` imports \`${binding}\` from a different module than ${previous.file ? `\`${previous.file}\`` : "the calling file"} already did; rename one of them`,
        call.loc.line,
        call.loc.column,
        call.loc.file,
      );
    }
    if (!duplicate) out.push(node);
  }
  return out;
}

/**
 * Mints the hygienic name for one binding a template declared.
 *
 * Shares `ctx.customTagGensym` with `TransformContext.gensym`, so an L1
 * expansion and an L2 transform in the same file can never mint the same name.
 */
function gensymFor(ctx: Ctx, hint: string): string {
  ctx.customTagGensym = (ctx.customTagGensym ?? 0) + 1;
  const safe = hint.replace(/[^A-Za-z0-9_]/g, "_");
  return `$mx_${safe}_${ctx.customTagGensym}`;
}

/**
 * The attribute values a template's `input.<name>` reads resolve to.
 *
 * A name the call supplies nothing for is deliberately absent rather than
 * mapped to `undefined`: the rewrite distinguishes "omitted" (emit
 * `undefined`, which is what a real input object would have given, and what
 * makes `input.size ?? 24` work) from "supplied".
 */
function valuesOf(call: TagCall): Map<string, string> {
  const values = new Map<string, string>();
  for (const attr of call.attrs) {
    switch (attr.kind) {
      case "static":
        values.set(attr.name, JSON.stringify(attr.value));
        break;
      case "boolean":
        values.set(attr.name, "true");
        break;
      case "dynamic":
      case "bound":
        values.set(attr.name, attr.value.code);
        break;
      case "spread":
        // A spread's keys are only known at run time, so no read can be
        // resolved statically. Refused rather than silently resolved to
        // `undefined`, which would drop the author's values without a word.
        throw new TranslateError(
          `\`<${call.name}>\`: a spread attribute cannot be passed to a tag template, whose \`input\` reads are substituted at compile time`,
          attr.loc.line,
          attr.loc.column,
          attr.loc.file,
        );
    }
  }
  return values;
}

/** The structural slot names: the body, and every attribute tag the call wrote. */
function slotsOf(call: TagCall): Set<string> {
  const slots = new Set<string>(["content"]);
  for (const tag of call.attributeTags) slots.add(tag.name);
  return slots;
}

/**
 * Rejects a caller attribute named `content`.
 *
 * `content` names the body slot, which is spliced as IR rather than passed as
 * a value, so an attribute of that name has nowhere to go: the template's
 * `input.content` reads the slot and the attribute is dropped without a word.
 * An error rather than a precedence rule, because either precedence loses
 * something the author wrote.
 *
 * Only `content`. An attribute colliding with an **attribute tag** the call
 * also wrote is already refused upstream by `validateAttributeTagShape`, in
 * Marko's own terms ("attribute tag `@header` collides with attribute
 * `header`") and before a template is involved at all — so a second check here
 * would either be dead or would shadow the better message with a worse one.
 */
function checkReservedAttrs(call: TagCall): void {
  for (const attr of call.attrs) {
    if (attr.kind === "spread" || attr.name !== "content") continue;
    throw new TranslateError(
      `\`<${call.name}>\`: \`content\` is reserved on a template tag; it names the body slot`,
      attr.loc.line,
      attr.loc.column,
      attr.loc.file,
    );
  }
}

/**
 * The render-scope names a template's own expansion declares.
 *
 * Only the expansion's top level: a `<const>` inside a `<for>` or an `<if>` is
 * confined to that block by the emitted JS itself, so it was never reachable
 * from the caller and renaming it would be noise.
 */
function declaredNames(nodes: IrNode[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    if (node.kind === "Const" || node.kind === "Define") {
      if (!names.includes(node.name)) names.push(node.name);
    }
  }
  return names;
}

/**
 * Names bound by the IR itself rather than by any one expression.
 *
 * A `<for>` param and a `<define>` param are in scope for a whole subtree, but
 * each expression in that subtree is parsed on its own, so Babel's scope
 * analysis inside one expression cannot see them — it would treat such a
 * reference as free and rename it, pointing the loop body at the template's
 * outer binding instead of at the row. Collected here and excluded from
 * renaming for the subtree they cover.
 */
/**
 * The name a node declares for the siblings after it in its own block.
 *
 * Separate from `irBoundNames`, which answers a different question: that one
 * gives the names a node binds *inside* its own subtree (a `<for>`'s params
 * over its body), this one gives the name a node binds for the rest of the
 * list it sits in. A `<const>` nested in an `<if>` is the case that motivates
 * it — without this the inner declaration is emitted dead and the following
 * read resolves to the template's renamed outer binding, rendering the wrong
 * value with no diagnostic.
 */
function blockDeclaredName(node: IrNode): string | null {
  if (node?.kind === "Const" || node?.kind === "Define") return node.name;
  return null;
}

function irBoundNames(node: IrNode): string[] {
  if (node.kind === "For") return node.bindings;
  if (node.kind === "Define") return node.params;
  return [];
}

/**
 * Applies one rewrite to every `Expr.code` in a tree.
 *
 * Carries two things down the walk: the nearest node position, so a rewrite
 * can raise a positioned error, and the set of names bound by the IR above
 * this point (`<for>` and `<define>` params). The second is why this is a
 * hand-written walk rather than a flat scan — a `<for>` param shadows a
 * template binding for its whole body, and no single expression's parse can
 * see that.
 */
export function rewriteCodes(
  nodes: unknown,
  rewrite: (
    code: string,
    loc: Position,
    shadowed: ReadonlySet<string>,
  ) => string,
): void {
  const seen = new Set<object>();
  const visit = (
    value: unknown,
    loc: Position,
    shadowed: ReadonlySet<string>,
  ): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      // A child list is a JS block: a `<const>` or `<define>` in it binds for
      // the siblings that *follow* it. Accumulated as the list is walked, so a
      // declaration shadows the template's outer binding of the same name from
      // its own position onward — and not before it, where the outer binding
      // is still the one in scope (and where an initializer like
      // `<const/x=x + 1/>` legitimately reads it).
      let scope = shadowed;
      for (const item of value) {
        visit(item, loc, scope);
        const declared = blockDeclaredName(item as IrNode);
        if (declared && !scope.has(declared)) {
          scope = new Set<string>([...scope, declared]);
        }
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const here = isPosition(record.loc) ? record.loc : loc;
    if (typeof record.code === "string" && "shape" in record) {
      record.code = rewrite(record.code, here, shadowed);
      return;
    }

    const bound = irBoundNames(record as unknown as IrNode);
    const inner =
      bound.length === 0 ? shadowed : new Set<string>([...shadowed, ...bound]);
    for (const [key, child] of Object.entries(record)) {
      if (key === "node") continue;
      // A `<for>`'s own source (`of=`, `from=`) is evaluated *outside* the
      // loop, so its params do not shadow there.
      const scope = key === "source" ? shadowed : inner;
      visit(child, here, scope);
    }
  };
  visit(nodes, { line: 0, column: 0 }, new Set());
}

/**
 * The one AST pass over an expansion's expressions.
 *
 * Rewrites three things at once, because all three are the same question —
 * "is this identifier a free reference to a name the expansion owns?" — and
 * asking it once means one parse and one reprint per expression:
 *
 * 1. **Substitute `input.<name>`** with the call's own attribute expression.
 * 2. **Rename** a binding the template declared at render scope, so the caller
 *    cannot see it (hygiene).
 * 3. **Reject a surviving bare `input`**, which after (1) can only be a use
 *    this strategy cannot express.
 *
 * ## Why an AST and not a regex
 *
 * The first implementation ran two regexes over the printed text. Every one of
 * these is an ordinary MX expression and every one came out wrong, silently:
 *
 * | Input (rename `x` -> `XX`) | Regex gave | Correct |
 * |---|---|---|
 * | `x?x:x` | `XX?x:x` | `XX?XX:XX` |
 * | `cond ? x : y` | unchanged | `cond ? XX : y` |
 * | `'x' + x` | `'XX' + XX` | `'x' + XX` |
 * | `` `size ${x}` `` | rewrote the literal too | only the interpolation |
 * | `class X { x() {} }` | renamed the method | unchanged |
 *
 * The `?:` cases are the worst of them: the consequent keeps the *caller's*
 * `x`, which is precisely the leak hygiene exists to prevent. A rewrite of
 * JavaScript needs a JavaScript parser, and this repo already vendors one —
 * the same `@marko/compiler/internal/babel` instance these nodes came from.
 *
 * Scope is Babel's: `isReferencedIdentifier()` excludes member properties,
 * non-shorthand object keys, labels and `case` clauses, and
 * `path.scope.getBinding(name)` excludes a name an inner scope rebinds — so an
 * arrow parameter or a `<for>` param shadowing `x` is left alone, as it must
 * be.
 */
function rewriteExpansion(
  nodes: IrNode[],
  call: TagCall,
  renames: ReadonlyMap<string, string>,
  values: ReadonlyMap<string, string>,
  slots: ReadonlySet<string>,
): void {
  if (renames.size === 0 && values.size === 0 && slots.size === 0) return;
  rewriteCodes(nodes, (code, loc, shadowed) =>
    rewriteExpressionCode(code, call, renames, values, slots, loc, shadowed),
  );
}

/**
 * Whether a substituted expression must be parenthesized where it lands.
 *
 * Anything that binds looser than a member access can change meaning — or
 * fail to parse — when grafted into a surrounding operator. Atoms cannot.
 */
function needsParens(node: Node): boolean {
  switch (node?.type) {
    case "Identifier":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "BigIntLiteral":
    case "RegExpLiteral":
    case "TemplateLiteral":
    case "ThisExpression":
    case "ArrayExpression":
    case "ObjectExpression":
    case "CallExpression":
    case "NewExpression":
    case "MemberExpression":
    case "OptionalCallExpression":
    case "OptionalMemberExpression":
      return false;
    default:
      return true;
  }
}

/** Parses one expression, applies the three rewrites, and reprints it. */
export function rewriteExpressionCode(
  code: string,
  call: TagCall,
  renames: ReadonlyMap<string, string>,
  values: ReadonlyMap<string, string>,
  slots: ReadonlySet<string>,
  loc: Position,
  /** Names bound by the IR above this expression (`<for>`/`<define>` params). */
  shadowed: ReadonlySet<string> = new Set(),
): string {
  const { parseExpression, traverse, types, generator } = markoBabel();

  let parsed: Node;
  try {
    parsed = parseExpression(code, { plugins: [["typescript", {}]] });
  } catch {
    // An expression the vendored parser cannot read is left exactly as it was.
    // It reached here already printed by the lowerer, so passing it through
    // unchanged is what the old text passes did for everything; failing the
    // compile on a parse the *emitter* would have accepted would be a
    // regression in its own right.
    return code;
  }

  const file = types.file(
    types.program([types.expressionStatement(parsed as Node)]),
  );

  traverse(file, {
    // biome-ignore lint/style/useNamingConvention: a Babel visitor key is a node type
    MemberExpression(path: Node) {
      const object = path.node.object;
      if (object?.type !== "Identifier" || object.name !== "input") return;
      if (path.scope.getBinding("input")) return;

      // `input["size"]` reads the same property as `input.size`, so it is
      // resolved the same way; anything genuinely dynamic is not a name this
      // pass can know and falls through to the bare-`input` error below.
      const property = path.node.property;
      const name = path.node.computed
        ? property?.type === "StringLiteral"
          ? property.value
          : null
        : property?.type === "Identifier"
          ? property.name
          : null;
      if (name === null) return;

      // A slot (`input.content`, `input.<tag>.content`) is structural: it was
      // spliced as IR, and its own `input.x` prefix must not be substituted
      // out from under the splice.
      if (slots.has(name)) {
        path.skip();
        return;
      }

      const value = values.get(name);
      if (value === undefined) {
        path.replaceWith(types.identifier("undefined"));
        path.skip();
        return;
      }
      const replacement = parseExpression(value, {
        plugins: [["typescript", {}]],
      });
      // A compound expression is parenthesized, because it is grafted into
      // whatever operator surrounded the read and Babel's generator does not
      // re-derive precedence for a node it did not parse in that position.
      // Measured: `size=a ?? b` read as `input.size ?? 24` printed
      // `a ?? b ?? 24` — not merely wrong precedence, but a syntax error, so
      // the emitted module would not have parsed at all.
      //
      // An atom (a literal, an identifier, a call, a member) needs no parens
      // and reads better without them, and the emitted code is something an
      // author debugs.
      path.replaceWith(
        needsParens(replacement)
          ? types.parenthesizedExpression(replacement)
          : replacement,
      );
      path.skip();
    },

    // biome-ignore lint/style/useNamingConvention: a Babel visitor key is a node type
    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      const name = path.node.name;
      // A name an inner scope rebinds is that scope's, not the expansion's.
      if (path.scope.getBinding(name)) return;

      if (name === "input") {
        // Every resolvable `input.<name>` was replaced above, so a surviving
        // reference is a use substitution cannot express: bare `input`,
        // `typeof input`, `input?.size`, a spread, a destructure. Left alone
        // it would emit an unbound identifier and fail at run time with no
        // diagnostic, which is the silent class this codebase guards against.
        throw new TranslateError(
          `\`<${call.name}>\`: \`input\` can only be read as \`input.<name>\` inside a tag template`,
          loc.line,
          loc.column,
          loc.file,
        );
      }

      // A name the IR binds above this expression belongs to that construct,
      // not to the template's own declaration of the same name.
      if (shadowed.has(name)) return;
      const renamed = renames.get(name);
      if (renamed) path.node.name = renamed;
    },
  });

  return generator(file.program.body[0].expression, { concise: true }).code;
}

function uniqueNames(tags: readonly AttributeTag[]): string[] {
  const names: string[] = [];
  for (const tag of tags) if (!names.includes(tag.name)) names.push(tag.name);
  return names;
}
