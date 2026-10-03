/**
 * Projects core's IR into the data tree (`tree.ts`).
 *
 * The projection is total over the IR a data compile can produce: every node
 * kind either maps to a tree node or is a positioned `TranslateError` in the
 * target's own words (decision 131's addendum, item 3). The rejects:
 *
 * - a tag variable (`<x/v>`): a binding means nothing without evaluation;
 * - a dynamic tag (`<${expr}>`): a static tree needs a name;
 * - a `Component` (a discovered `tags/` template tag call — a capitalized
 *   import call already failed in `declarations.ts`'s `rejectComponentTag`):
 *   a data file cannot call a template tag;
 * - `<!doctype>`: means nothing in a data file.
 *
 * With `structural: "reject"` the pass-through structural constructs (text,
 * `${}`, `<if>`/`<for>`/`<const>`, comments, `import`/`export`/`static`)
 * each become a positioned error — "the data tree is static; this file's
 * consumer does not evaluate `<if>`" — reported at the earliest construct in
 * document order, for a consumer (mash) that wants tags and attributes only.
 */

import type { Expression } from "@babel/types";
import {
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type Branch,
  type DelegatedTag,
  type Expr,
  type ForHead,
  type Ir,
  type IrNode,
  type Position,
  type SourceSpan,
  TranslateError,
} from "@mxlang/core";
import type {
  DataAttr,
  DataAttrTagNode,
  DataBranch,
  DataDocument,
  DataExpr,
  DataForHead,
  DataNode,
  DataStatement,
  DataTag,
} from "./tree.ts";

export interface BuildOptions {
  structural: "pass" | "reject";
}

/** The dynamic-tag reject, shared by `Component` and an unusable tag name. */
const DYNAMIC_TAG_MESSAGE = `a dynamic tag (\`<\${expr}>\`) has no name; the data tree is static and needs one`;

/** The fixed structural-reject message (the 131 addendum's item 1). */
function structuralMessage(construct: string): string {
  return `the data tree is static; this file's consumer does not evaluate ${construct}`;
}

function fail(message: string, at: Position): never {
  throw new TranslateError(message, at.line, at.column, at.file);
}

function requiredSpan(span: SourceSpan | undefined, what: string): SourceSpan {
  if (!span) {
    throw new Error(
      `@mxlang/data: core IR invariant broken — ${what} carries no span`,
    );
  }
  return span;
}

function dataExpr(expr: Expr, what: string): DataExpr {
  return {
    code: expr.code,
    shape: expr.shape,
    span: requiredSpan(expr.span, what),
    node: expr.node as Expression,
  };
}

/** Every attribute kind but the spread, which has no name. */
type NamedAttr = Exclude<Attr, { kind: "spread" }>;

/**
 * An attribute's `nameSpan`, or `undefined` when core has none.
 *
 * A shorthand attribute (`#myid`, `.cls`) reaches the IR with a `nameSpan`
 * whose offsets are `NaN` — core records no name for a name that is not
 * written, and `JSON.stringify` renders `NaN` as `null`, so it reads like a
 * null offset until something slices it. The tree never emits a non-finite
 * offset: the field is omitted instead. Core-side, that should become a real
 * span (TODO `core-shorthand-attr-spans`).
 */
function optionalNameSpan(attr: NamedAttr): SourceSpan | undefined {
  const span = attr.nameSpan as SourceSpan | null | undefined;
  if (!span) return undefined;
  return Number.isFinite(span.sourceStart) && Number.isFinite(span.sourceEnd)
    ? span
    : undefined;
}

function requiredNameSpan(attr: NamedAttr, what: string): SourceSpan {
  const span = optionalNameSpan(attr);
  if (!span) {
    throw new Error(
      `@mxlang/data: core IR invariant broken — ${what} carries no name span`,
    );
  }
  return span;
}

/**
 * A tag name the static tree cannot carry.
 *
 * The rule is deliberately narrow, and it is about *what a name can be*, not
 * about what is idiomatic. Marko parses a concise `$!{x}` line as a tag called
 * `$!{x}` and a `$const x = 1` scriptlet as a tag called `$const`; MX has no
 * scriptlets (decision 54) and no placeholder can name a tag, so those two
 * shapes are rejected and everything else is a name.
 *
 * Everything else includes XML-style namespaced names (`svg:rect`,
 * `soap:Envelope`) and non-ASCII names (a data file in Portuguese or
 * Japanese). An earlier, wider rule refused those as "not a plain identifier";
 * it was written to catch the two shapes above and over-reached, and it was
 * also inconsistent — it ran for tags but not for attribute tags, so `<é/>`
 * failed while `<@é/>` passed.
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

function checkTagName(name: string, at: Position): void {
  if (!unusableTagName(name)) return;
  if (name.startsWith("$") && name.includes("{")) {
    fail(DYNAMIC_TAG_MESSAGE, at);
  }
  fail(
    `\`${name}\` is not a tag name a data file can use: it must not start with \`$\` or \`!\`, or contain \`{\`, \`}\` or whitespace — those are a \`$…\` scriptlet or a \`\${…}\` placeholder, which a data file does not have`,
    at,
  );
}

/**
 * A shorthand class written next to an authored `class` attribute.
 *
 * `<x.a class="b"/>` is valid Marko, and core merges the two into one
 * synthesized `class` expression that has **no span** — there is no single
 * source range for a value the author wrote twice, in two syntaxes. The tree
 * cannot describe that (its `valueSpan` would have to slice something the
 * author never wrote), and the alternative — a silent drop or a crash out of
 * `parseData` — is worse, so it is one positioned diagnostic at the tag.
 *
 * A shorthand `class` alone is fine: core gives that one a real `valueSpan`.
 * This lifts when TODO `core-shorthand-attr-spans` gives core a real span for
 * a merged attribute; then the union of the two written ranges is the span,
 * and the tree can carry it.
 */
const MERGED_SHORTHAND_CLASS =
  "a shorthand class (`.a`) together with a `class` attribute is not supported in a data file: write every class in the `class` attribute";

/**
 * The attribute a shorthand class would have merged into, if core merged one.
 *
 * Only `class` is special: a shorthand is `#id` or `.class`, core rejects a
 * shorthand `#id` beside an authored `id` itself (positioned), and `class` is
 * the one name where core silently merges instead.
 */
function rejectMergedShorthandClass(attrs: Attr[], at: Position): void {
  for (const attr of attrs) {
    if (attr.kind === "spread") continue;
    if (attr.name !== "class") continue;
    const span =
      attr.kind === "static"
        ? attr.valueSpan
        : attr.kind === "boolean"
          ? undefined
          : attr.value.span;
    if (!span) fail(MERGED_SHORTHAND_CLASS, at);
  }
}

function dataAttr(attr: Attr): DataAttr {
  switch (attr.kind) {
    case "static": {
      const nameSpan = optionalNameSpan(attr);
      return {
        kind: "string",
        name: attr.name,
        value: attr.value,
        ...(nameSpan ? { nameSpan } : {}),
        valueSpan: requiredSpan(
          attr.valueSpan,
          `static attribute \`${attr.name}\``,
        ),
      };
    }
    case "boolean":
      return {
        kind: "boolean",
        name: attr.name,
        nameSpan: requiredNameSpan(attr, `attribute \`${attr.name}\``),
      };
    case "bound":
      return {
        kind: "expression",
        name: attr.name,
        value: dataExpr(attr.value, `bound attribute \`${attr.name}\``),
        nameSpan: requiredNameSpan(attr, `bound attribute \`${attr.name}\``),
        bound: true,
      };
    case "spread":
      return {
        kind: "spread",
        value: dataExpr(attr.value, "spread attribute"),
      };
    // `dynamic`, and `event` as a fallback: an `on*` attribute is only
    // rewritten to the `event` kind on an element, and the data declarations
    // declare no elements, so a delegated tag's `onClick` arrives as
    // `dynamic`. The `event` arm only guards a core behavior change.
    default:
      return {
        kind: "expression",
        name: attr.name,
        value: dataExpr(attr.value, `attribute \`${attr.name}\``),
        nameSpan: requiredNameSpan(attr, `attribute \`${attr.name}\``),
      };
  }
}

function dataForHead(head: ForHead, what: string): DataForHead {
  const source: DataForHead["source"] =
    head.source.kind === "of"
      ? { kind: "of", list: dataExpr(head.source.list, `${what} \`of\``) }
      : head.source.kind === "in"
        ? { kind: "in", object: dataExpr(head.source.object, `${what} \`in\``) }
        : {
            kind: "range",
            from: head.source.from
              ? dataExpr(head.source.from, `${what} \`from\``)
              : null,
            bound: dataExpr(head.source.bound, `${what} \`to\`/\`until\``),
            inclusive: head.source.inclusive,
            step: head.source.step
              ? dataExpr(head.source.step, `${what} \`step\``)
              : null,
          };
  return {
    source,
    params: head.params,
    paramSpans: head.paramSpans ?? head.params.map(() => undefined),
    key: head.key ? dataExpr(head.key, `${what} \`by\``) : null,
  };
}

function dataTag(tag: DelegatedTag<unknown>): DataTag {
  checkTagName(tag.name, tag.loc);
  rejectMergedShorthandClass(tag.attrs, tag.loc);
  if (tag.var !== null) {
    fail(
      `tag variable \`/${tag.var}\` on \`<${tag.name}>\`: the data tree is static; a binding without evaluation means nothing`,
      tag.loc,
    );
  }
  return {
    kind: "tag",
    name: tag.name,
    nameSpan: requiredSpan(tag.nameSpan, `tag \`<${tag.name}>\`'s name`),
    span: withoutTrailingNewline(
      requiredSpan(tag.span, `tag \`<${tag.name}>\``),
    ),
    attrs: tag.attrs.map(dataAttr),
    args: (tag.args ?? []).map((arg, i) =>
      dataExpr(arg, `argument ${i + 1} of \`<${tag.name}>\``),
    ),
    params: tag.params,
    attrTags: tag.attributeTagTree.map(dataAttrTagNode),
    children: dataNodes(tag.children),
  };
}

function dataAttrTag(tag: AttributeTag): DataAttrTagNode {
  checkTagName(tag.name, tag.loc);
  rejectMergedShorthandClass(tag.attrs, tag.loc);
  return {
    kind: "attr-tag",
    name: tag.name,
    nameSpan: tag.nameSpan,
    span: withoutTrailingNewline(
      requiredSpan(tag.span, `attribute tag \`<@${tag.name}>\``),
    ),
    attrs: tag.attrs.map(dataAttr),
    params: tag.block.params,
    attrTags: tag.attributeTagTree.map(dataAttrTagNode),
    children: dataNodes(tag.block.children),
  };
}

export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function dataAttrTagNode(node: AttributeTagNode): DataAttrTagNode {
  switch (node.kind) {
    case "AttributeTag":
      return dataAttrTag(node.tag);
    case "AttributeTagIf":
      return {
        kind: "if",
        branches: node.branches.map((branch) => ({
          test: branch.test
            ? dataExpr(branch.test, "attribute-tag `<if>` condition")
            : null,
          children: branch.nodes.map(dataAttrTagNode),
          span: branch.span,
        })),
      };
    case "AttributeTagFor":
      return {
        kind: "for",
        head: dataForHead(node.loop, "attribute-tag `<for>`"),
        children: node.nodes.map(dataAttrTagNode),
      };
  }
}

// Line tables convert between offsets and positions: an `export interface
// Input` statement's span is derived from its positions (core carries no
// span on `InputInterface`), and a statement's structural-reject position is
// derived from its span. Set per `buildDataDocument` call (compiles are
// synchronous and single-threaded, same as core's own `current` handle).
let activeLineStarts: number[] = [0];
let activeSourceLength = 0;
/** The source itself, for the two span adjustments that need its text. */
let activeSource = "";

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
 * A tag's span without the line terminator that follows it.
 *
 * In concise mode core measures a tag through the end of the line it ends
 * on, so `b` + `  c` arrives as `"b\\n  c\\n"`. A `<tag/>` span never carries
 * the terminator, and `DataTag.span` is documented as "opening tag, body and
 * closing tag" — the line terminator is neither. Every trailing `\r`/`\n`
 * goes; a blank line between the tag and the next one is not part of it
 * either way, and trimming is idempotent.
 */
function withoutTrailingNewline(span: SourceSpan): SourceSpan {
  let end = span.sourceEnd;
  while (end > span.sourceStart) {
    const code = activeSource.charCodeAt(end - 1);
    if (code !== 10 && code !== 13) break;
    end -= 1;
  }
  return end === span.sourceEnd
    ? span
    : { sourceStart: span.sourceStart, sourceEnd: end };
}

/**
 * The position a `structural: "reject"` reports for a text node.
 *
 * `Text.loc` points at the *end of the line above* whenever the node carries
 * leading whitespace, because Marko keeps the line terminator and the
 * indentation inside the text (`"\\n  text"` for the value `" text"`). An
 * agent following that line number lands on the previous tag. The position
 * comes from the span instead — advanced past the leading whitespace the
 * span itself carries, so it is the first character of the text itself.
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

function dataBranch(branch: Branch): DataBranch<DataNode> {
  return {
    test: branch.condition
      ? dataExpr(branch.condition, "`<if>` condition")
      : null,
    children: dataNodes(branch.children),
    span: requiredSpan(branch.span, "an `<if>` branch"),
  };
}

function dataNode(node: IrNode): DataNode {
  switch (node.kind) {
    case "DelegatedTag":
      return dataTag(node.tag);
    case "Text":
      return {
        kind: "text",
        value: node.value,
        span: requiredSpan(node.span, "text"),
      };
    case "Interpolation":
      return {
        kind: "expression",
        value: dataExpr(node.expr, "interpolation"),
        escaped: node.escaped,
        span: requiredSpan(node.span, "interpolation"),
      };
    case "Comment":
      return {
        kind: "comment",
        value: node.value,
        html: node.html,
        span: requiredSpan(node.span, "comment"),
      };
    case "IfChain":
      return {
        kind: "if",
        branches: node.branches.map(dataBranch),
        span: requiredSpan(node.span, "`<if>`"),
      };
    case "For":
      return {
        kind: "for",
        head: dataForHead(node, "`<for>`"),
        children: dataNodes(node.children),
        span: requiredSpan(node.span, "`<for>`"),
      };
    case "Const":
      return {
        kind: "const",
        name: node.name,
        init: dataExpr(node.init, "`<const>`"),
        span: requiredSpan(node.span, "`<const>`"),
      };
    case "Component":
      if (node.target.kind === "dynamic") {
        fail(DYNAMIC_TAG_MESSAGE, node.loc);
      }
      fail(
        `\`<${node.authoredName ?? node.target.name}>\` calls a template tag; a data file cannot call a template tag`,
        node.loc,
      );
      break;
    case "DocumentType":
      fail(
        "`<!doctype>` means nothing in a data file; the data tree describes tags and data, not a page",
        node.loc,
      );
      break;
    default:
      // `Define` cannot appear (the declarations reject `<define>` before it
      // lowers); `Import`/`Static`/`Export`/`InputInterface`/`Hoisted` live
      // on the Ir's statement lists, never in a body. `Element` cannot
      // appear (the declarations declare no elements).
      throw new Error(
        `@mxlang/data: unexpected IR node kind \`${node.kind}\` in a body`,
      );
  }
}

function dataNodes(nodes: IrNode[]): DataNode[] {
  return nodes.map(dataNode);
}

function statements(ir: Ir): DataStatement[] {
  const out: DataStatement[] = [];
  for (const node of ir.imports) {
    // A synthesized import exists only to back a `Component` the tree
    // rejects; it is not an authored statement.
    if (node.synthesized) continue;
    out.push({
      kind: "import",
      code: node.code,
      span: requiredSpan(node.span, "`import` statement"),
    });
  }
  for (const node of ir.hoisted) {
    out.push({
      kind: node.kind === "Static" ? "static" : "export",
      code: node.code,
      span: requiredSpan(node.span, `\`${node.kind.toLowerCase()}\` statement`),
    });
  }
  if (ir.inputInterface) {
    // The one statement kind core carries no span on: derive it from the
    // statement's positions through the line table (documented in tree.ts).
    out.push({
      kind: "export",
      code: ir.inputInterface.code,
      span: {
        sourceStart: offsetOfPosition(
          ir.inputInterface.loc.line,
          ir.inputInterface.loc.column,
        ),
        sourceEnd: offsetOfPosition(
          ir.inputInterface.end.line,
          ir.inputInterface.end.column,
        ),
      },
    });
  }
  // Core splits statements out of the body into separate lists and loses
  // their cross-list order; the document order is recovered by span.
  out.sort((a, b) => a.span.sourceStart - b.span.sourceStart);
  return out;
}

/** The earliest structural construct, for `structural: "reject"`. */
interface StructuralHit {
  construct: string;
  /** UTF-16 offset, for picking the earliest across body and statements. */
  offset: number;
  at: Position;
}

function hit(construct: string, at: Position): StructuralHit {
  return {
    construct,
    offset: offsetOfPosition(at.line, at.column),
    at,
  };
}

function structuralInAttrTagNodes(
  nodes: AttributeTagNode[],
): StructuralHit | null {
  for (const node of nodes) {
    const found =
      node.kind === "AttributeTagIf"
        ? hit("`<if>`", node.loc)
        : node.kind === "AttributeTagFor"
          ? hit("`<for>`", node.loc)
          : structuralInAttrTagNodes(node.tag.attributeTagTree) ||
            structuralInNodes(node.tag.block.children);
    if (found) return found;
  }
  return null;
}

function structuralInNodes(nodes: IrNode[]): StructuralHit | null {
  for (const node of nodes) {
    let found: StructuralHit | null = null;
    switch (node.kind) {
      case "Text":
        found = hit("text", textPosition(node.span, node.loc));
        break;
      case "Interpolation":
        found = hit(`\`\${}\``, node.loc);
        break;
      case "Comment":
        found = hit("comments", node.loc);
        break;
      case "IfChain":
        found = hit("`<if>`", node.loc);
        break;
      case "For":
        found = hit("`<for>`", node.loc);
        break;
      case "Const":
        found = hit("`<const>`", node.loc);
        break;
      case "DelegatedTag":
        found =
          structuralInAttrTagNodes(node.tag.attributeTagTree) ||
          structuralInNodes(node.tag.children);
        break;
    }
    if (found) return found;
  }
  return null;
}

function rejectStructural(ir: Ir, stmts: DataStatement[]): never {
  let best: StructuralHit | null = structuralInNodes(ir.body);
  for (const stmt of stmts) {
    if (!best || stmt.span.sourceStart < best.offset) {
      best = {
        construct: `\`${stmt.kind}\``,
        offset: stmt.span.sourceStart,
        at: positionOfOffset(stmt.span.sourceStart),
      };
    }
  }
  if (best) fail(structuralMessage(best.construct), best.at);
  throw new Error('@mxlang/data: structural: "reject" found no construct');
}

/**
 * Builds the tree from a lowered data compile. Throws `TranslateError`
 * (positioned) for every reject above; `parseData` turns it into the single
 * error diagnostic.
 */
export function buildDataDocument(
  ir: Ir,
  source: string,
  filename: string,
  options: BuildOptions,
): DataDocument {
  activeLineStarts = lineStartsOf(source);
  activeSource = source;
  activeSourceLength = source.length;
  const stmts = statements(ir);
  if (options.structural === "reject") {
    // Only reject when a structural construct exists; a tags-and-attributes
    // file builds the same under either option.
    if (stmts.length > 0 || structuralInNodes(ir.body) !== null) {
      rejectStructural(ir, stmts);
    }
  }
  return {
    kind: "document",
    filename,
    statements: stmts,
    children: dataNodes(ir.body),
  };
}
