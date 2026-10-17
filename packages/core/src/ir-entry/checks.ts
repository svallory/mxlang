/**
 * The IR entry point's checks: what `lowerSource` verifies on
 * the IR before it hands it out. Moved from `@mxlang/data`'s tree projection
 * (`build.ts`), minus the projection: the same walk, in the same order, with
 * the same messages, so every diagnostic keeps its text and position.
 *
 * The rejects:
 *
 * - a tag variable (`<x/v>`): a binding means nothing without evaluation;
 * - a dynamic tag (`<${expr}>`): a static tree needs a name;
 * - a `Component` (a call of a tag that has a template: a capitalized
 *   import call already failed in `declarations.ts`'s `rejectComponentTag`;
 *   a lowercase name reaches here only when `customTags` holds an entry with
 *   a template, as a `getCustomTags` map does for a `tags/` file);
 * - `<!doctype>`: means nothing in a data file;
 * - an unusable tag name, a spanless shorthand `id`/`class`.
 *
 * With `structural: "reject"` the pass-through structural constructs (text,
 * `${}`, `<if>`/`<for>`/`<const>`, `import`/`export`/`static`) each become a
 * positioned error, "Data files are static, so they do not evaluate `<if>`".
 * With `unknownTags: "reject"` every authored tag with no contract is one.
 *
 * The span guarantee is checked in the same walk: a node, attribute or
 * expression the returned IR promises a span for (`SpannedIr`) and that has
 * none is an `@mxlang/core: IR invariant broken` error, which `lowerSource`
 * reports under its `internal error: ` prefix, with no IR.
 */

import { codedError, isTranslateError, type TranslateError } from "../core.ts";
import {
  DIALECT_HOOK_ERROR_CODE,
  INTERNAL_ERROR_CODE,
  type MxDiagnosticCode,
  NOT_IN_DATA_FILE_CODE,
  STRUCTURAL_CONSTRUCT_CODE,
  UNKNOWN_TAG_CODE,
} from "../diagnostic-codes.ts";
import { nearestName } from "../did-you-mean.ts";
import type {
  Attr,
  AttributeTag,
  AttributeTagNode,
  Branch,
  DelegatedTag,
  Expr,
  ForHead,
  Ir,
  IrNode,
  Position,
  TagTrigger,
} from "../ir.ts";
import type { SourceSpan } from "../mapping.ts";
import {
  MX_VOICE,
  mxSpelling,
  structuralMessage,
  type Voice,
  VoiceHookError,
} from "../message-vocabulary.ts";
import { lineStartsOf } from "./diagnostics.ts";
import {
  type Explainer,
  enterTag,
  ROOT_FRAME,
  type ViewFrame,
} from "./unknown-tag-view.ts";

export interface CheckOptions {
  structural: "pass" | "reject";
  /** Absent: the `structural` value decides `import`s too. */
  imports?: "pass" | "reject";
  /**
   * With `"reject"`, a tag whose name is not in `declaredTags` is an error.
   * `declaredTags` is the built-in `object` plus the key set of `customTags`.
   */
  unknownTags: "allow" | "reject";
  declaredTags: ReadonlySet<string>;
  /** The id of the file's dialect, when it has one: the error names it. */
  dialectId?: string;
  /**
   * Names whose every call already carries its own error (a refused
   * `customTags` definition: `MX_RESERVED_TAG` at each call site). Such a call
   * is not also reported unknown, and the dialect is not asked about it: one
   * diagnostic per occurrence.
   */
  exemptTags?: ReadonlySet<string>;
  /**
   * The file's dialect's `explainUnknownTag`. Given, the walk for unknown tags
   * runs in every mode: an explained tag is the dialect's error, in `"allow"`
   * too; one the dialect leaves alone is core's error in `"reject"` only.
   */
  explainer?: Explainer;
  /**
   * The words the file's dialect uses in these messages (`Dialect.messageVocabulary`).
   * Absent: MX's own.
   */
  voice?: Voice;
}

/** The dynamic-tag reject, shared by `Component` and an unusable tag name. */
function dynamicTagMessage(voice: Voice, source: string): string {
  return `a dynamic tag (${voice.dynamicTag(source, undefined, "expr")}) has no name; ${voice.files} are static, so they need one`;
}

/**
 * The dynamic-tag reject for a capitalized tag a file-local binding names
 * (`<Task>` with `import { Task }`): it names the tag and the way out. The
 * dialect's flag is offered only when the file has a dialect to set it on.
 */
function boundDynamicTagMessage(
  name: string,
  voice: Voice,
  dialectId?: string,
  trigger?: TagTrigger,
): string {
  const base = `${voice.tag(name, trigger)} is bound in this file, so it is a dynamic tag; ${voice.files} are static, so they need a name. Rename the binding (for an import, \`import { ${name} as ${name}Ref }\`)`;
  return dialectId === undefined
    ? base
    : `${base} or set \`bindingsCallTags: false\` in the dialect`;
}

/**
 * `fn`'s message, or, when the dialect's `formatTag` broke its contract while
 * spelling it, the hook error at `at`: the message being built is replaced by
 * the error about the hook.
 */
function voiced(at: Position, end: BlameEnd, fn: () => string): string {
  try {
    return fn();
  } catch (error) {
    if (error instanceof VoiceHookError) {
      fail(DIALECT_HOOK_ERROR_CODE, error.message, at, end);
    }
    throw error;
  }
}

/**
 * Where a rejected construct ends (exclusive), as a position: the end of the
 * name a whole-tag reject blames (`<name`), never the element's close. Without
 * one the error is a point, ending where it starts.
 */
type BlameEnd = { line: number; column: number } | undefined;

function fail(
  code: MxDiagnosticCode,
  message: string,
  at: Position,
  end?: BlameEnd,
): never {
  throw errorAt(code, message, at, end);
}

function errorAt(
  code: MxDiagnosticCode,
  message: string,
  at: Position,
  end?: BlameEnd,
): TranslateError {
  const error = codedError(code, message, at.line, at.column, at.file);
  error.end = end ?? { line: at.line, column: at.column };
  return error;
}

/** The end of a node's span, when core gave a finite one. */
function spanEndOf(span: SourceSpan | undefined): BlameEnd {
  return span && Number.isFinite(span.sourceEnd)
    ? positionOfOffset(span.sourceEnd)
    : undefined;
}

/** The end of a tag's `<name`: its name span's end, when core gave a finite one. */
function nameEndOf(tag: { nameSpan?: SourceSpan | null }): BlameEnd {
  const span = tag.nameSpan;
  return span && Number.isFinite(span.sourceEnd)
    ? positionOfOffset(span.sourceEnd)
    : undefined;
}

/**
 * The end of the `name` a construct opens with at `at` (`<if`, `<for`, `<const`,
 * `<!doctype`, or a statement's `import`), read off the source because the IR
 * keeps no span for a keyword. `undefined` when the source does not say `name`
 * there, so the error stays a point.
 */
function keywordEnd(at: Position, name: string): BlameEnd {
  let offset = offsetOfPosition(at.line, at.column);
  if (activeSource[offset] === "<") offset += 1;
  const written = activeSource.slice(offset, offset + name.length);
  return written.toLowerCase() === name
    ? positionOfOffset(offset + name.length)
    : undefined;
}

/**
 * The end of a dynamic tag's `<${expr}`: the `}` that closes the placeholder,
 * read off the source after the expression's span (the IR keeps no span for
 * the braces). `undefined` when the expression has no span or the source does
 * not close it there (a comment before the `}` is not read past), so the
 * error stays a point.
 */
function dynamicTagEnd(expr: { span?: SourceSpan }): BlameEnd {
  const to = expr.span?.sourceEnd;
  if (to === undefined || !Number.isFinite(to)) return undefined;
  let offset = to;
  while (/[\s)]/.test(activeSource[offset] ?? "")) offset += 1;
  return activeSource[offset] === "}"
    ? positionOfOffset(offset + 1)
    : undefined;
}

/**
 * Every error the walk met, in the order met. The walk recovers per node, per
 * attribute and per argument: a reject there is recorded here and the walk
 * goes on, so one file reports every independent mistake. A non-positioned
 * `Error` (an internal invariant) is recorded too; `lowerSource` reports it
 * with its own prefix. Set per `checkIr` call, like the line tables.
 */
let problems: unknown[] = [];

/** `fn`'s result, or `undefined` after recording what it threw. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    problems.push(error);
    return undefined;
  }
}

/** `fn` over every item, each throw recorded and the walk continued. */
function each<T>(items: readonly T[], fn: (item: T, index: number) => void) {
  items.forEach((item, index) => {
    attempt(() => fn(item, index));
  });
}

function requiredSpan(span: SourceSpan | undefined, what: string): SourceSpan {
  if (!span) {
    throw new Error(
      `@mxlang/core: IR invariant broken — ${what} carries no span`,
    );
  }
  return span;
}

/** A span with finite offsets (no `NaN`). */
function finiteSpan(span: SourceSpan | undefined, what: string): SourceSpan {
  const checked = requiredSpan(span, what);
  if (
    !Number.isFinite(checked.sourceStart) ||
    !Number.isFinite(checked.sourceEnd)
  ) {
    throw new Error(
      `@mxlang/core: IR invariant broken — ${what} carries a non-finite span`,
    );
  }
  return checked;
}

function checkExpr(expr: Expr, what: string): void {
  requiredSpan(expr.span, what);
}

/** Every attribute kind but the spread, which has no name. */
type NamedAttr = Exclude<Attr, { kind: "spread" }>;

/** An attribute's `nameSpan`, or `undefined` when core has none or a non-finite one. */
function optionalNameSpan(attr: NamedAttr): SourceSpan | undefined {
  const span = attr.nameSpan as SourceSpan | null | undefined;
  if (!span) return undefined;
  return Number.isFinite(span.sourceStart) && Number.isFinite(span.sourceEnd)
    ? span
    : undefined;
}

function requiredNameSpan(attr: NamedAttr, what: string): void {
  if (!optionalNameSpan(attr)) {
    throw new Error(
      `@mxlang/core: IR invariant broken — ${what} carries no name span`,
    );
  }
}

/**
 * A tag name a static tree cannot carry.
 *
 * The rule is deliberately narrow, and it is about *what a name can be*, not
 * about what is idiomatic: a concise `$!{x}` line parses as a tag called
 * `$!{x}` and a `$const x = 1` scriptlet as a tag called `$const`; MX has no
 * scriptlets and no placeholder can name a tag, so those two
 * shapes are rejected and everything else is a name, XML-style namespaced
 * (`svg:rect`) and non-ASCII names included.
 */
function unusableTagName(name: string): boolean {
  return (
    name.startsWith("$") ||
    name.startsWith("!") ||
    name.includes("{") ||
    name.includes("}") ||
    /\s/.test(name)
  );
}

function checkTagName(
  name: string,
  tag: { loc: Position; nameSpan?: SourceSpan | null },
): void {
  if (!unusableTagName(name)) return;
  if (name.startsWith("$") && name.includes("{")) {
    fail(
      NOT_IN_DATA_FILE_CODE,
      voiced(tag.loc, nameEndOf(tag), () =>
        dynamicTagMessage(activeVoice, name.replace(/^\$\{|\}$/g, "")),
      ),
      tag.loc,
      nameEndOf(tag),
    );
  }
  fail(
    NOT_IN_DATA_FILE_CODE,
    `\`${name}\` is not a tag name ${activeVoice.aFile} can use: it must not start with \`$\` or \`!\`, or contain \`{\`, \`}\` or whitespace — those are a \`$…\` scriptlet or a \`\${…}\` placeholder, which ${activeVoice.aFile} does not have`,
    tag.loc,
    nameEndOf(tag),
  );
}

/**
 * A shorthand class written next to an authored `class` attribute.
 *
 * `<x.a class="b"/>` is valid Marko, and core merges the two into one
 * synthesized `class` expression that has **no span**: there is no single
 * source range for a value the author wrote twice, in two syntaxes. The IR
 * cannot promise a span for it, so it is one positioned diagnostic at the
 * tag. A shorthand `class` alone is fine: core gives that one a real
 * `valueSpan` and `nameSpan`. TODO `core-shorthand-attr-spans`.
 */
function mergedShorthandClass(voice: Voice): string {
  return `a shorthand class (\`.a\`) together with a \`class\` ${voice.attribute} is not supported in ${voice.aFile}: write every class in the \`class\` ${voice.attribute}`;
}

/**
 * The reject for a shorthand `class` whose value has no source span.
 *
 * A shorthand with a placeholder (`#a${x}`, `.${x}-b`) is a template literal
 * Core builds over the authored word, and the value's span covers that word.
 * The one spanless shorthand value left is the merged one (`<x.a
 * class="b"/>`; the name span then starts at the authored `class`), which
 * only `class` produces: core rejects a shorthand `#id` beside an authored
 * `id` itself.
 */
function rejectSpanlessShorthand(
  attrs: Attr[],
  tag: { loc: Position; nameSpan?: SourceSpan | null },
): void {
  const at = tag.loc;
  for (const attr of attrs) {
    if (attr.kind === "spread" || attr.name !== "class") continue;
    const span =
      attr.kind === "static"
        ? attr.valueSpan
        : attr.kind === "boolean"
          ? undefined
          : attr.value.span;
    if (span) continue;
    fail(
      DIALECT_HOOK_ERROR_CODE,
      mergedShorthandClass(activeVoice),
      at,
      nameEndOf(tag),
    );
  }
}

function checkAttr(attr: Attr): void {
  checkAttrValue(attr);
  if (attr.kind !== "spread" && attr.args) {
    each(attr.args, (arg, i) =>
      checkExpr(arg, `argument ${i + 1} of attribute \`${attr.name}\``),
    );
  }
  requiredSpan(
    attr.span,
    attr.kind === "spread" ? "spread attribute" : `attribute \`${attr.name}\``,
  );
}

function checkAttrValue(attr: Attr): void {
  switch (attr.kind) {
    case "static":
      // An atom's and a member's value is a positioned literal too, so every
      // static attribute has a `valueSpan` (`SpannedIr` requires it).
      requiredSpan(attr.valueSpan, `static attribute \`${attr.name}\``);
      return;
    case "boolean":
      requiredNameSpan(attr, `attribute \`${attr.name}\``);
      return;
    case "bound":
      checkExpr(attr.value, `bound attribute \`${attr.name}\``);
      requiredNameSpan(attr, `bound attribute \`${attr.name}\``);
      if (attr.refinement) {
        checkExpr(
          attr.refinement,
          `refinement of bound attribute \`${attr.name}\``,
        );
      }
      return;
    case "spread":
      checkExpr(attr.value, "spread attribute");
      return;
    // `dynamic`, and `event` as a fallback: an `on*` attribute is only
    // rewritten to the `event` kind on an element, and the entry point's
    // declarations declare no elements, so a delegated tag's `onClick`
    // arrives as `dynamic`.
    default:
      checkExpr(attr.value, `attribute \`${attr.name}\``);
      requiredNameSpan(attr, `attribute \`${attr.name}\``);
  }
}

function checkForHead(head: ForHead, what: string): void {
  const { source } = head;
  if (source.kind === "of") checkExpr(source.list, `${what} \`of\``);
  else if (source.kind === "in") checkExpr(source.object, `${what} \`in\``);
  else {
    if (source.from) checkExpr(source.from, `${what} \`from\``);
    checkExpr(source.bound, `${what} \`to\`/\`until\``);
    if (source.step) checkExpr(source.step, `${what} \`step\``);
  }
  if (head.key) checkExpr(head.key, `${what} \`by\``);
}

/** One of a tag's two child lists, tagged so a walk can interleave them. */
type Part =
  | { side: "attr"; node: AttributeTagNode }
  | { side: "child"; node: IrNode };

/**
 * Where a node opens, as an offset: its span when core gave it a finite one,
 * else its `loc`. A `Text` node's `loc` points at the line above (see
 * `textPosition`), so it relies on its span, which core gives every `Text`;
 * the `loc` fallback is only a guard.
 */
function openOffset(part: Part): number {
  const node = part.node;
  const tag =
    node.kind === "DelegatedTag" || node.kind === "AttributeTag"
      ? node.tag
      : undefined;
  // An attribute-tag `<if>`/`<for>` opens where its `loc` says: the walk
  // orders by `loc` there, as before those nodes had a span.
  const span = tag
    ? tag.span
    : "span" in node &&
        node.kind !== "AttributeTagIf" &&
        node.kind !== "AttributeTagFor"
      ? node.span
      : undefined;
  if (span && Number.isFinite(span.sourceStart)) return span.sourceStart;
  const at = tag ? tag.loc : node.loc;
  if (!at) {
    throw new Error(
      `@mxlang/core: IR invariant broken — a \`${node.kind}\` node carries neither a span nor a loc`,
    );
  }
  return offsetOfPosition(at.line, at.column);
}

/**
 * A tag's attribute tags and children as one list in source order.
 *
 * Core keeps the two apart (`attributeTagTree` and `children`), so a walk of
 * one then the other visits `<@meta>` before a child written above it. Every
 * walk that reports "the first" hit goes through here, so the first it meets
 * is the earliest in the file. The sort is stable.
 */
function inSourceOrder(
  attrTags: AttributeTagNode[],
  children: IrNode[],
): Part[] {
  const parts: Part[] = [
    ...attrTags.map((node): Part => ({ side: "attr", node })),
    ...children.map((node): Part => ({ side: "child", node })),
  ];
  return parts
    .map((part) => ({ part, at: openOffset(part) }))
    .sort((a, b) => a.at - b.at)
    .map(({ part }) => part);
}

function checkTag(tag: DelegatedTag<unknown>): void {
  attempt(() => checkTagName(tag.name, tag));
  // A merged class has no span, so checking that tag's attributes would add an
  // internal "no span" error that is only the same mistake again: skip them.
  const attrsCheckable = attempt(() => {
    rejectSpanlessShorthand(tag.attrs, tag);
    return true;
  });
  if (tag.var !== null) {
    attempt(() =>
      fail(
        NOT_IN_DATA_FILE_CODE,
        voiced(
          tag.loc,
          nameEndOf(tag),
          () =>
            `tag variable \`/${tag.var}\` on ${activeVoice.tag(tag.name, tag.trigger)}: ${activeVoice.files} are static, so a binding without evaluation means nothing`,
        ),
        tag.loc,
        nameEndOf(tag),
      ),
    );
  }
  if (attrsCheckable) each(tag.attrs, checkAttr);
  each(tag.args ?? [], (arg, i) =>
    checkExpr(arg, `argument ${i + 1} of \`<${tag.name}>\``),
  );
  checkParts(tag.attributeTagTree, tag.children);
  requiredSpan(tag.nameSpan, `tag \`<${tag.name}>\`'s name`);
  requiredSpan(tag.span, `tag \`<${tag.name}>\``);
  if (tag.alias) requiredSpan(tag.alias.span, `tag \`<${tag.name}>\`'s alias`);
}

/**
 * Checks a tag's attribute tags and children in source order, so a reject is
 * the earliest one in the file.
 */
function checkParts(attrTagNodes: AttributeTagNode[], childNodes: IrNode[]) {
  for (const part of inSourceOrder(attrTagNodes, childNodes)) {
    if (part.side === "attr") attempt(() => checkAttrTagNode(part.node));
    else attempt(() => checkNode(part.node));
  }
}

function checkAttrTag(tag: AttributeTag): void {
  attempt(() => checkTagName(tag.name, tag));
  const attrsCheckable = attempt(() => {
    rejectSpanlessShorthand(tag.attrs, tag);
    return true;
  });
  if (attrsCheckable) each(tag.attrs, checkAttr);
  checkParts(tag.attributeTagTree, tag.block.children);
  // The spans are the last thing read, so a tag with a bad name or attribute
  // still has its body walked (and its inner errors recorded) before an
  // internal span invariant stops this one tag.
  finiteSpan(tag.nameSpan, `attribute tag \`<@${tag.name}>\`'s name`);
  requiredSpan(tag.span, `attribute tag \`<@${tag.name}>\``);
}

function checkAttrTagNode(node: AttributeTagNode): void {
  switch (node.kind) {
    case "AttributeTag":
      checkAttrTag(node.tag);
      return;
    case "AttributeTagIf":
      each(node.branches, (branch) => {
        if (branch.test) {
          checkExpr(branch.test, "attribute-tag `<if>` condition");
        }
        each(branch.nodes, checkAttrTagNode);
      });
      requiredSpan(node.span, "attribute-tag `<if>`");
      return;
    case "AttributeTagFor":
      checkForHead(node.loop, "attribute-tag `<for>`");
      each(node.nodes, checkAttrTagNode);
      requiredSpan(node.span, "attribute-tag `<for>`");
      return;
  }
}

// Line tables convert between offsets and positions: a statement's
// structural-reject position is derived from its span. Set per `checkIr`
// call (compiles are synchronous and single-threaded, same as core's own
// `current` handle).
let activeLineStarts: number[] = [0];
let activeSourceLength = 0;
/** The source itself, for the checks that need its text. */
let activeSource = "";
/** The id of the file's dialect, when it has one. */
let activeDialectId: string | undefined;
/** The words of the file's dialect in the messages; MX's own without one. */
let activeVoice: Voice = MX_VOICE;

function positionOfOffset(offset: number): { line: number; column: number } {
  let low = 0;
  let high = activeLineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((activeLineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (activeLineStarts[low] as number) };
}

function offsetOfPosition(line: number, column: number): number {
  const start = activeLineStarts[line - 1];
  if (start === undefined) return activeSourceLength;
  return Math.min(start + column, activeSourceLength);
}

/**
 * The position a `structural: "reject"` reports for a text node.
 *
 * `Text.loc` points at the *end of the line above* whenever the node carries
 * leading whitespace, because the parser keeps the line terminator and the
 * indentation inside the text (`"\\n  text"` for the value `" text"`). The
 * position comes from the span instead, advanced past the leading whitespace
 * the span itself carries, so it is the first character of the text itself.
 */
function textPosition(span: SourceSpan | undefined, fallback: Position) {
  if (!span) return fallback;
  let start = span.sourceStart;
  while (start < span.sourceEnd) {
    const code = activeSource.charCodeAt(start);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    start += 1;
  }
  // A text node that is *only* whitespace ran the loop to `sourceEnd`, which
  // is the character after the text — the `<` of the close tag for
  // `<pre>  </pre>`. Report where the text starts instead.
  return positionOfOffset(start === span.sourceEnd ? span.sourceStart : start);
}

function checkBranch(branch: Branch): void {
  if (branch.condition) checkExpr(branch.condition, "`<if>` condition");
  checkNodes(branch.children);
  requiredSpan(branch.span, "an `<if>` branch");
}

function checkNode(node: IrNode): void {
  switch (node.kind) {
    case "DelegatedTag":
      checkTag(node.tag);
      return;
    case "Text":
      requiredSpan(node.span, "text");
      return;
    case "Interpolation":
      checkExpr(node.expr, "interpolation");
      requiredSpan(node.span, "interpolation");
      return;
    case "Comment":
      requiredSpan(node.span, "comment");
      return;
    case "IfChain":
      each(node.branches, checkBranch);
      requiredSpan(node.span, "`<if>`");
      return;
    case "For":
      checkForHead(node, "`<for>`");
      checkNodes(node.children);
      requiredSpan(node.span, "`<for>`");
      return;
    case "Const":
      checkExpr(node.init, "`<const>`");
      requiredSpan(node.span, "`<const>`");
      return;
    case "Component": {
      if (node.target.kind === "dynamic") {
        const target = node.target;
        const end = dynamicTagEnd(target.expr);
        fail(
          NOT_IN_DATA_FILE_CODE,
          voiced(node.loc, end, () =>
            target.valueImportBinding
              ? boundDynamicTagMessage(
                  target.valueImportBinding,
                  activeVoice,
                  activeDialectId,
                  node.trigger,
                )
              : dynamicTagMessage(activeVoice, target.expr.code),
          ),
          node.loc,
          end,
        );
      }
      const calledName = node.authoredName ?? node.target.name;
      fail(
        NOT_IN_DATA_FILE_CODE,
        voiced(
          node.loc,
          nameEndOf(node),
          () =>
            `${activeVoice.tag(calledName, node.trigger)} calls a template tag; ${activeVoice.aFile} cannot call a template tag`,
        ),
        node.loc,
        nameEndOf(node),
      );
      break;
    }
    case "DocumentType":
      fail(
        NOT_IN_DATA_FILE_CODE,
        voiced(
          node.loc,
          keywordEnd(node.loc, "!doctype"),
          () =>
            `${activeVoice.tag("!doctype")} means nothing in ${activeVoice.aFile}; ${activeVoice.files} describe tags and data, not a page`,
        ),
        node.loc,
        keywordEnd(node.loc, "!doctype"),
      );
      break;
    default:
      // `Define` cannot appear (the declarations reject `<define>` before it
      // lowers); `Import`/`Static`/`Export`/`InputInterface`/`Hoisted` live
      // on the Ir's statement lists, never in a body. `Element` cannot
      // appear (the declarations declare no elements).
      throw new Error(
        `@mxlang/core: unexpected IR node kind \`${node.kind}\` in a body`,
      );
  }
}

function checkNodes(nodes: IrNode[]): void {
  each(nodes, checkNode);
}

/** A module statement: its kind as the structural reject names it, and its span. */
interface Statement {
  kind: "import" | "static" | "export";
  span: SourceSpan;
}

/** The authored statements, in file order, their spans checked. */
function statements(ir: Ir): Statement[] {
  const out: Statement[] = [];
  for (const node of ir.imports) {
    // A synthesized import exists only to back a `Component` the checks
    // reject; it is not an authored statement.
    if (node.synthesized) continue;
    // `SpannedIr` requires both: lowering refuses an authored `import` that is
    // not one ES import declaration, and reads both from that declaration.
    if (node.from === undefined || node.names === undefined) {
      throw new Error(
        "@mxlang/core: IR invariant broken — an `import` statement carries no `from`/`names`",
      );
    }
    out.push({
      kind: "import",
      span: requiredSpan(node.span, "`import` statement"),
    });
  }
  for (const node of ir.hoisted) {
    out.push({
      kind: node.kind === "Static" ? "static" : "export",
      span: requiredSpan(node.span, `\`${node.kind.toLowerCase()}\` statement`),
    });
  }
  if (ir.inputInterface) {
    out.push({
      kind: "export",
      span: requiredSpan(
        ir.inputInterface.span,
        "`export interface Input` statement",
      ),
    });
  }
  // Core splits statements out of the body into separate lists and loses
  // their cross-list order; the document order is recovered by span.
  out.sort((a, b) => a.span.sourceStart - b.span.sourceStart);
  return out;
}

/**
 * The error text for an authored tag whose name has no contract, built here
 * for every place that reports one. A dialect's file names the dialect (its
 * id): its vocabulary is the dialect's contracts, its tag directories and
 * whatever the caller handed over, and the tag is in none of them. Any other
 * file names no source, because a lowering is handed its contracts and cannot
 * tell where the caller found them.
 */
export function unknownTagMessage(
  name: string,
  declaredTags: ReadonlySet<string>,
  dialectId?: string,
  voice: Voice = MX_VOICE,
  trigger?: TagTrigger,
): string {
  const near = nearestName(name, declaredTags);
  const where =
    dialectId === undefined
      ? ": no contract for it was given"
      : ` in the \`${dialectId}\` dialect`;
  return `${voice.tag(name, trigger)} is not a known tag${where}${near ? `; did you mean ${voice.tag(near)}?` : ""}`;
}

/**
 * {@link unknownTagMessage} with its code: the dialect's `formatTag` breaking
 * its contract while spelling the tag is `MX_DIALECT_HOOK_ERROR` instead,
 * with the hook's own message.
 */
export function unknownTagReport(
  name: string,
  declaredTags: ReadonlySet<string>,
  dialectId: string | undefined,
  voice: Voice,
  trigger?: TagTrigger,
): { message: string; code: MxDiagnosticCode } {
  try {
    return {
      message: unknownTagMessage(name, declaredTags, dialectId, voice, trigger),
      code: UNKNOWN_TAG_CODE,
    };
  } catch (error) {
    if (error instanceof VoiceHookError) {
      return { message: error.message, code: DIALECT_HOOK_ERROR_CODE };
    }
    throw error;
  }
}

/** An unknown authored tag, for `unknownTags: "reject"`. */
interface UnknownTagHit {
  name: string;
  trigger?: TagTrigger;
  message: string;
  code: MxDiagnosticCode;
  at: Position;
  /** Where the tag's element ends, to label the errors inside it. */
  end?: Position;
  /** Where the error's range ends: the end of the tag's `<name`. */
  blameEnd?: BlameEnd;
  /** The dialect's error for this tag, when it explained it: it replaces core's. */
  explained?: TranslateError;
}

/**
 * Every authored tag, in document order, with no contract in `declaredTags`.
 *
 * Document order is parent first: a tag's opening precedes everything inside
 * it, so an unknown parent is listed before anything in its body. A tag a
 * declared tag's `transform` emitted has no `nameSpan` (core's marker,
 * `DelegatedTag.nameSpan`): it is the dialect author's output, not a name the
 * file's author wrote, so it is skipped. `<@name>` is never checked.
 */
function allUnknownTags(
  ir: Ir,
  declaredTags: ReadonlySet<string>,
  exemptTags: ReadonlySet<string> | undefined,
  explainer: Explainer | undefined,
  dialectId: string | undefined,
): UnknownTagHit[] {
  const found: UnknownTagHit[] = [];
  const visitTag = (tag: DelegatedTag<unknown>, frame: ViewFrame) => {
    const written = tag.alias?.authored ?? tag.name;
    const nameSpan = tag.nameSpan;
    if (
      tag.nameSpan !== undefined &&
      // A wildcard child (`alias`) was claimed by its parent's contract: known.
      tag.alias === undefined &&
      !declaredTags.has(tag.name) &&
      !exemptTags?.has(tag.name)
    ) {
      const explained = explainer?.explain({
        name: tag.name,
        nameSpan: tag.nameSpan,
        span: tag.span ?? tag.nameSpan,
        ancestors: frame.ancestors,
      });
      found.push({
        name: tag.name,
        ...(tag.trigger ? { trigger: tag.trigger } : {}),
        ...unknownTagReport(
          tag.name,
          declaredTags,
          dialectId,
          activeVoice,
          tag.trigger,
        ),
        at: tag.loc,
        blameEnd: nameEndOf(tag),
        ...(tag.span && Number.isFinite(tag.span.sourceEnd)
          ? { end: positionOfOffset(tag.span.sourceEnd) }
          : {}),
        ...(explained ? { explained } : {}),
      });
    }
    // A tag a `transform` emitted has no authored name: it is not an ancestor
    // (the parse-only scan never sees it either). A dynamic tag is not here:
    // `lowerSource` lowers it to a `Component`, which this walk does not enter.
    const inner =
      explainer && nameSpan
        ? enterTag(explainer.env, frame, {
            node: tag,
            written,
            name: tag.name,
            nameSpan,
            claimed: tag.alias !== undefined,
          })
        : frame;
    visitAttrTagNodes(tag.attributeTagTree, inner);
    visitNodes(tag.children, inner);
  };
  const visitAttrTagNodes = (nodes: AttributeTagNode[], frame: ViewFrame) => {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") {
        const inner = explainer
          ? enterTag(explainer.env, frame, {
              node: node.tag,
              written: `@${node.tag.name}`,
              name: `@${node.tag.name}`,
              nameSpan: node.tag.nameSpan,
              claimed: false,
            })
          : frame;
        visitAttrTagNodes(node.tag.attributeTagTree, inner);
        visitNodes(node.tag.block.children, inner);
      } else if (node.kind === "AttributeTagIf") {
        for (const branch of node.branches)
          visitAttrTagNodes(branch.nodes, frame);
      } else {
        visitAttrTagNodes(node.nodes, frame);
      }
    }
  };
  const visitNodes = (nodes: IrNode[], frame: ViewFrame) => {
    for (const node of nodes) {
      if (node.kind === "DelegatedTag") visitTag(node.tag, frame);
      else if (node.kind === "IfChain") {
        for (const branch of node.branches) visitNodes(branch.children, frame);
      } else if (node.kind === "For") visitNodes(node.children, frame);
    }
  };
  visitNodes(ir.body, ROOT_FRAME);
  return found;
}

/** A structural construct, for `structural: "reject"`. */
interface StructuralHit {
  /** The construct as written, backticked; unset for a tag keyword. */
  construct?: string;
  /** A tag keyword (`if`, `for`, `const`): spelled through the voice. */
  keyword?: "if" | "for" | "const";
  at: Position;
  /** Where the error's range ends; a point when unset. */
  blameEnd?: BlameEnd;
}

/** Every structural construct among a tag's attribute tags and children. */
function structuralInParts(
  attrTags: AttributeTagNode[],
  children: IrNode[],
  out: StructuralHit[],
): void {
  for (const part of inSourceOrder(attrTags, children)) {
    if (part.side === "attr") structuralInAttrTagNodes([part.node], out);
    else structuralInNodes([part.node], out);
  }
}

function structuralInAttrTagNodes(
  nodes: AttributeTagNode[],
  out: StructuralHit[],
): void {
  for (const node of nodes) {
    if (node.kind === "AttributeTagIf") {
      out.push({
        keyword: "if",
        at: node.loc,
        blameEnd: keywordEnd(node.loc, "if"),
      });
    } else if (node.kind === "AttributeTagFor") {
      out.push({
        keyword: "for",
        at: node.loc,
        blameEnd: keywordEnd(node.loc, "for"),
      });
    } else {
      structuralInParts(
        node.tag.attributeTagTree,
        node.tag.block.children,
        out,
      );
    }
  }
}

/**
 * Every structural construct in `nodes`. A construct is one hit: what is
 * written inside an `<if>` or `<for>` body is not walked, since the whole
 * construct is the thing the consumer does not evaluate.
 */
function structuralInNodes(nodes: IrNode[], out: StructuralHit[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "Text":
        out.push({
          construct: "text",
          at: textPosition(node.span, node.loc),
          blameEnd: spanEndOf(node.span),
        });
        break;
      case "Interpolation":
        out.push({
          construct: `\`\${}\``,
          at: node.loc,
          blameEnd: spanEndOf(node.span),
        });
        break;
      case "IfChain":
        out.push({
          keyword: "if",
          at: node.loc,
          blameEnd: keywordEnd(node.loc, "if"),
        });
        break;
      case "For":
        out.push({
          keyword: "for",
          at: node.loc,
          blameEnd: keywordEnd(node.loc, "for"),
        });
        break;
      case "Const":
        out.push({
          keyword: "const",
          at: node.loc,
          blameEnd: keywordEnd(node.loc, "const"),
        });
        break;
      case "DelegatedTag":
        structuralInParts(node.tag.attributeTagTree, node.tag.children, out);
        break;
    }
  }
}

/** How a top-level `import` is treated: `imports`, else the effective `structural`. */
function importsMode(options: CheckOptions): "pass" | "reject" {
  return options.imports ?? options.structural ?? "pass";
}

/** Every structural construct, as a position and message. */
function allStructural(
  ir: Ir,
  stmts: Statement[],
  options: CheckOptions,
): {
  message: string;
  at: Position;
  code: MxDiagnosticCode;
  blameEnd?: BlameEnd;
}[] {
  const hits: StructuralHit[] = [];
  if (options.structural === "reject") structuralInNodes(ir.body, hits);
  for (const stmt of stmts) {
    // `imports` decides an `import` on its own; the rest follow `structural`.
    if (stmt.kind === "import") {
      if (importsMode(options) !== "reject") continue;
    } else if (options.structural !== "reject") {
      continue;
    }
    const at = positionOfOffset(stmt.span.sourceStart);
    hits.push({
      construct: `\`${stmt.kind}\``,
      at,
      blameEnd: keywordEnd(at, stmt.kind),
    });
  }
  return hits.map((found) => {
    const blame = found.blameEnd ? { blameEnd: found.blameEnd } : {};
    try {
      const construct = found.keyword
        ? activeVoice.tag(found.keyword)
        : (found.construct ?? "");
      return {
        message: structuralMessage(construct, activeVoice),
        at: found.at,
        code: STRUCTURAL_CONSTRUCT_CODE,
        ...blame,
      };
    } catch (error) {
      if (!(error instanceof VoiceHookError)) throw error;
      return {
        message: error.message,
        at: found.at,
        code: DIALECT_HOOK_ERROR_CODE,
        ...blame,
      };
    }
  });
}

/** An unknown tag's element: where it opens and (when known) closes. */
export interface UnknownTagRange {
  name: string;
  /** The trigger that made the tag, when one did. */
  trigger?: TagTrigger;
  at: Position;
  end?: Position;
}

const NONE: ReadonlySet<unknown> = new Set();

/** The suffix of an error that sits inside an unknown tag's element. */
function insideUnknownTagLabel(range: UnknownTagRange, voice: Voice): string {
  // The tag's own error already reports a `formatTag` that breaks its
  // contract; the label falls back to MX's spelling rather than lose the
  // error it labels.
  let spelled: string;
  try {
    spelled = voice.tag(range.name, range.trigger);
  } catch (error) {
    if (!(error instanceof VoiceHookError)) throw error;
    spelled = `\`${mxSpelling({ name: range.name, form: "tag" })}\``;
  }
  return ` (inside the unknown tag ${spelled}; may resolve once it is declared)`;
}

/**
 * Labels, never drops, the errors strictly inside an unknown tag's element
 * (no diagnostic is dropped). An unknown tag has no contract, so
 * what is reported inside it (its children's own unknown names, a `parents`/
 * `children` error that is only the symptom of the typo) may disappear once the
 * tag is declared, while an independent mistake (a `/var`, a `<!doctype>`, a
 * structural `<if>`, an unknown attribute on a declared tag) stays; the label
 * tells an agent which is which without hiding either. The innermost enclosing
 * unknown tag names the label. An error with no position, or positioned in
 * another file, is not inside this file's element and is left as is.
 */
export function labelInside(
  errors: unknown[],
  unknown: readonly UnknownTagRange[],
  except: ReadonlySet<unknown> = NONE,
  voice: Voice = MX_VOICE,
): unknown[] {
  const inside = (at: Position, tag: UnknownTagRange) =>
    tag.end !== undefined &&
    at.file === undefined &&
    (at.line > tag.at.line ||
      (at.line === tag.at.line && at.column > tag.at.column)) &&
    (at.line < tag.end.line ||
      (at.line === tag.end.line && at.column < tag.end.column));
  return errors.map((error) => {
    // A dialect's explanation of an unknown tag sits on the tag's own name:
    // it is what the label would point at, not an error inside it.
    if (except.has(error)) return error;
    const at = positionOf(error);
    if (!at) return error;
    let innermost: UnknownTagRange | undefined;
    for (const tag of unknown) {
      if (!inside(at, tag)) continue;
      if (
        !innermost ||
        tag.at.line > innermost.at.line ||
        (tag.at.line === innermost.at.line &&
          tag.at.column > innermost.at.column)
      ) {
        innermost = tag;
      }
    }
    if (!innermost) return error;
    // The label is prose; the code of the error it labels stays (an uncoded
    // one is MX's bug, as the funnel would say).
    const labelled = codedError(
      INTERNAL_ERROR_CODE,
      `${(error as TranslateError).message}${insideUnknownTagLabel(innermost, voice)}`,
      at.line,
      at.column,
      at.file,
    );
    const code = (error as TranslateError).diagnosticCode;
    if (code !== undefined) labelled.diagnosticCode = code;
    const end = (error as TranslateError).end;
    if (end !== undefined) labelled.end = end;
    const fixes = (error as TranslateError).fixes;
    if (fixes !== undefined) labelled.fixes = fixes;
    return labelled;
  });
}

/** An error's source position, or `null` for one with none (an internal bug). */
function positionOf(error: unknown): Position | null {
  return isTranslateError(error)
    ? { line: error.line, column: error.column, file: error.file }
    : null;
}

/**
 * Every error of one check, earliest first.
 *
 * The rejects, the structural hits and the unknown tags are three independent
 * walks of the IR; their errors are merged by file, line and column (discovery
 * order on a tie, so two different errors at one position both stay) and only
 * a truly identical error — the same file, position and message — appears
 * once. An error with no position (an internal invariant) goes last.
 */
function sortedProblems(all: unknown[]): unknown[] {
  const keyed = all.map((error, index) => ({
    error,
    index,
    at: positionOf(error),
  }));
  keyed.sort((a, b) => {
    if (!a.at || !b.at) return a.at ? -1 : b.at ? 1 : a.index - b.index;
    return (
      (a.at.file ?? "").localeCompare(b.at.file ?? "") ||
      a.at.line - b.at.line ||
      a.at.column - b.at.column ||
      a.index - b.index
    );
  });
  const seen = new Set<string>();
  return keyed
    .filter(({ error, at }) => {
      if (!at) return true;
      const key = `${at.file ?? ""}:${at.line}:${at.column}:${(error as Error).message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ error }) => error);
}

/**
 * Checks a lowered IR, collecting every error: `TranslateError`s, plus an
 * `Error` per broken invariant, earliest first. Empty means the IR passes.
 *
 * Never throws and never writes to the IR. Every recovery point records into
 * `problems`; a throw outside every one of them (a bug here) is recorded with
 * the rest, so the errors already collected are never lost behind it.
 */
export function checkIr(
  ir: Ir,
  source: string,
  options: CheckOptions,
): unknown[] {
  problems = [];
  try {
    return checkAll(ir, source, options);
  } catch (error) {
    return sortedProblems([...problems, error]);
  }
}

function checkAll(ir: Ir, source: string, options: CheckOptions): unknown[] {
  activeLineStarts = lineStartsOf(source);
  activeSource = source;
  activeDialectId = options.dialectId;
  activeVoice = options.voice ?? MX_VOICE;
  activeSourceLength = source.length;
  const stmts = attempt(() => statements(ir)) ?? [];
  checkNodes(ir.body);
  const extra: unknown[] = [];
  const unknownHits: UnknownTagHit[] = [];
  const asError = ({
    message,
    at,
    code,
    blameEnd,
  }: {
    message: string;
    at: Position;
    code: MxDiagnosticCode;
    blameEnd?: BlameEnd;
  }) => errorAt(code, message, at, blameEnd);
  attempt(() => {
    for (const found of allStructural(ir, stmts, options)) {
      extra.push(asError(found));
    }
  });
  const explained = new Set<unknown>();
  if (options.unknownTags === "reject" || options.explainer) {
    attempt(() => {
      const found = allUnknownTags(
        ir,
        options.declaredTags,
        options.exemptTags,
        options.explainer,
        options.dialectId,
      );
      for (const hit of found) {
        if (hit.explained) {
          // The dialect's error is the one for this tag, in both modes.
          explained.add(hit.explained);
          extra.push(hit.explained);
          unknownHits.push(hit);
        } else if (options.unknownTags === "reject") {
          extra.push(asError(hit));
          unknownHits.push(hit);
        }
      }
    });
  }
  return sortedProblems(
    labelInside([...problems, ...extra], unknownHits, explained, activeVoice),
  );
}
