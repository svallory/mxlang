/**
 * Projects core's IR into the data tree (`tree.ts`).
 *
 * The projection is total over the IR a data compile can produce: every node
 * kind either maps to a tree node or is a positioned `TranslateError` in the
 * target's own words (decision 131's addendum, item 3). The rejects:
 *
 * - a tag variable (`<x/v>`): a binding means nothing without evaluation;
 * - a dynamic tag (`<${expr}>`): a static tree needs a name;
 * - a `Component` (a call of a tag that has a template: a capitalized
 *   import call already failed in `declarations.ts`'s `rejectComponentTag`;
 *   a lowercase name reaches here only when `customTags` holds an entry with
 *   a template, as a `getCustomTags` map does for a `tags/` file). `parseData`
 *   never scans, so a `tags/` template that is not in `customTags` is just a
 *   data tag named like the file: a data file cannot call a template tag;
 * - `<!doctype>`: means nothing in a data file.
 *
 * With `structural: "reject"` the pass-through structural constructs (text,
 * `${}`, `<if>`/`<for>`/`<const>`, `import`/`export`/`static`) each become a
 * positioned error — "the data tree is static; this file's
 * consumer does not evaluate `<if>`" — reported at the earliest construct in
 * document order, for a consumer (mash) that wants tags and attributes only.
 */

import type { Expression, ImportDeclaration } from "@babel/types";
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
  isTranslateError,
  nearestName,
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
  DataImport,
  DataImportName,
  DataNode,
  DataStatement,
  DataTag,
} from "./tree.ts";

export interface BuildOptions {
  structural: "pass" | "reject";
  /** Absent: the `structural` value decides `import`s too. */
  imports?: "pass" | "reject";
  /**
   * With `"reject"`, a tag whose name is not in `declaredTags` is an error.
   * `declaredTags` is the key set of `customTags`.
   */
  unknownTags: "allow" | "reject";
  declaredTags: ReadonlySet<string>;
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

/**
 * Every error the build met, in the order met. The build recovers per node,
 * per attribute and per argument: a reject there is recorded here and the walk
 * goes on, so one file reports every independent mistake. A non-positioned
 * `Error` (an internal invariant) is recorded too; `parseData` reports it with
 * its own prefix. Set per `buildDataDocumentAll` call, like the line tables.
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

/** `items.map(fn)` minus the items whose `fn` threw, each recorded. */
function each<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => U,
): U[] {
  const out: U[] = [];
  items.forEach((item, index) => {
    const built = attempt(() => ({ value: fn(item, index) }));
    if (built) out.push(built.value);
  });
  return out;
}

function requiredSpan(span: SourceSpan | undefined, what: string): SourceSpan {
  if (!span) {
    throw new Error(
      `@mxlang/data: core IR invariant broken — ${what} carries no span`,
    );
  }
  return span;
}

/** A span the tree can emit: present, with finite offsets (no `NaN`). */
function finiteSpan(span: SourceSpan | undefined, what: string): SourceSpan {
  const checked = requiredSpan(span, what);
  if (
    !Number.isFinite(checked.sourceStart) ||
    !Number.isFinite(checked.sourceEnd)
  ) {
    throw new Error(
      `@mxlang/data: core IR invariant broken — ${what} carries a non-finite span`,
    );
  }
  return checked;
}

function dataExpr(expr: Expr, what: string): DataExpr {
  return {
    code: expr.code,
    shape: expr.shape,
    span: requiredSpan(expr.span, what),
    node: expr.node,
  };
}

/** Every attribute kind but the spread, which has no name. */
type NamedAttr = Exclude<Attr, { kind: "spread" }>;

/**
 * An attribute's `nameSpan`, or `undefined` when core has none.
 *
 * Core gives a tag shorthand (`#myid`, `.cls`) the span of the sigil plus the
 * token, like the spaced sugar form. This guard is kept for the invariant it
 * states: the tree never emits a non-finite offset (`JSON.stringify` renders
 * `NaN` as `null`, which reads like a null offset until something slices it),
 * so the field is omitted rather than written as `NaN`.
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
 * A shorthand `class` alone is fine: core gives that one a real `valueSpan`
 * and `nameSpan`. This lifts when TODO `core-shorthand-attr-spans` gives core
 * a real span for a merged attribute; then the union of the two written ranges is the span,
 * and the tree can carry it.
 */
const MERGED_SHORTHAND_CLASS =
  "a shorthand class (`.a`) together with a `class` attribute is not supported in a data file: write every class in the `class` attribute";

const SYNTHESIZED_SHORTHAND_ID =
  "a shorthand id with a placeholder (`#a${x}`) is not supported in a data file: write `id=...`";

const SYNTHESIZED_SHORTHAND_CLASS =
  "a shorthand class with a placeholder (`.a${x}`) is not supported in a data file: write `class=...`";

/**
 * The two rejects for a shorthand `id`/`class` whose value has no source span.
 *
 * Core builds the value of a shorthand with a placeholder (`#a${x}`,
 * `.${x}-b`) as a synthesized template literal with no authored source, so the
 * tree has no span to give it: a positioned reject, at the `#`/`.` when the
 * attribute's name span starts there, instead of the invariant error
 * `dataExpr` would throw. The same spanless value arises when a shorthand
 * class and an authored `class` attribute merge (`<x.a class="b"/>`; the name
 * span then starts at the authored `class`): a different mistake, so a
 * different message. Only `class` merges silently; core rejects a shorthand
 * `#id` beside an authored `id` itself (positioned).
 */
function rejectSpanlessShorthand(attrs: Attr[], at: Position): void {
  for (const attr of attrs) {
    if (attr.kind === "spread") continue;
    if (attr.name !== "id" && attr.name !== "class") continue;
    const span =
      attr.kind === "static"
        ? attr.valueSpan
        : attr.kind === "boolean"
          ? undefined
          : attr.value.span;
    if (span) continue;
    const nameSpan = optionalNameSpan(attr);
    const sigil = nameSpan ? activeSource[nameSpan.sourceStart] : undefined;
    const where = nameSpan
      ? { ...at, ...positionOfOffset(nameSpan.sourceStart) }
      : at;
    if (attr.name === "id" && sigil === "#") {
      fail(SYNTHESIZED_SHORTHAND_ID, where);
    }
    if (attr.name === "class" && sigil === ".") {
      fail(SYNTHESIZED_SHORTHAND_CLASS, where);
    }
    if (attr.name === "class") fail(MERGED_SHORTHAND_CLASS, at);
  }
}

function dataAttr(attr: Attr): DataAttr {
  switch (attr.kind) {
    case "static": {
      const nameSpan = optionalNameSpan(attr);
      if (attr.atom) {
        return {
          kind: "atom",
          name: attr.name,
          value: attr.atom.name,
          ...(nameSpan ? { nameSpan } : {}),
          span: attr.atom.span,
        };
      }
      // Decision 182 addendum 5: the name a syntax module's trigger
      // declares is not written, so the variant carries no `nameSpan`.
      if (attr.member) {
        return {
          kind: "member",
          name: attr.name,
          value: attr.member.name,
          span: attr.member.span,
        };
      }
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
        ...(attr.refinement
          ? {
              refinement: dataExpr(
                attr.refinement,
                `refinement of bound attribute \`${attr.name}\``,
              ),
            }
          : {}),
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

/** One of a tag's two child lists, tagged so a walk can interleave them. */
type Part =
  | { side: "attr"; node: AttributeTagNode }
  | { side: "child"; node: IrNode };

/**
 * Where a node opens, as an offset: its span when core gave it a finite one,
 * else its `loc`. A `Text` node's `loc` points at the line above (see
 * `textPosition`), so it relies on its span, which core gives every `Text`
 * (#234); the `loc` fallback is only a guard.
 */
function openOffset(part: Part): number {
  const node = part.node;
  const tag =
    node.kind === "DelegatedTag" || node.kind === "AttributeTag"
      ? node.tag
      : undefined;
  const span = tag ? tag.span : "span" in node ? node.span : undefined;
  if (span && Number.isFinite(span.sourceStart)) return span.sourceStart;
  const at = tag ? tag.loc : node.loc;
  if (!at) {
    throw new Error(
      `@mxlang/data: core IR invariant broken — a \`${node.kind}\` node carries neither a span nor a loc`,
    );
  }
  return offsetOfPosition(at.line, at.column);
}

/**
 * A tag's attribute tags and children as one list in source order.
 *
 * Core keeps the two apart (`attributeTagTree` and `children`), so a walk of
 * one then the other visits `<@meta>` before a child written above it. Every
 * walk that reports "the first" hit (the build rejects, the structural
 * reject) goes through here, so the first it meets is the earliest in the
 * file. The sort is stable, and the tree still keeps the two lists apart.
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

/**
 * The `contract`/`groups` fields of a wildcard-matched tag (decision 147);
 * empty for every other tag, so an existing tree serializes byte-identically.
 */
function wildcardMatch(
  tag: DelegatedTag<unknown>,
): Pick<DataTag, "contract" | "groups"> {
  const { alias } = tag;
  if (alias === undefined) return {};
  return {
    contract: tag.name,
    ...(Object.keys(alias.groups).length > 0 ? { groups: alias.groups } : {}),
  };
}

function dataTag(tag: DelegatedTag<unknown>): DataTag {
  attempt(() => checkTagName(tag.name, tag.loc));
  // A merged class has no span, so building that tag's attributes would add an
  // internal "no span" error that is only the same mistake again: skip them.
  const attrsBuildable = attempt(() => {
    rejectSpanlessShorthand(tag.attrs, tag.loc);
    return true;
  });
  if (tag.var !== null) {
    attempt(() =>
      fail(
        `tag variable \`/${tag.var}\` on \`<${tag.name}>\`: the data tree is static; a binding without evaluation means nothing`,
        tag.loc,
      ),
    );
  }
  const attrs = attrsBuildable ? each(tag.attrs, dataAttr) : [];
  const args = each(tag.args ?? [], (arg, i) =>
    dataExpr(arg, `argument ${i + 1} of \`<${tag.name}>\``),
  );
  const { attrTags, children } = dataParts(tag.attributeTagTree, tag.children);
  return {
    kind: "tag",
    // A wildcard child keeps the name the author wrote; `tag.name` is then the
    // canonical tag whose contract matched, exposed as `contract` (decision 147).
    name: tag.alias?.authored ?? tag.name,
    ...wildcardMatch(tag),
    ...(tag.trigger ? { trigger: tag.trigger } : {}),
    nameSpan: requiredSpan(tag.nameSpan, `tag \`<${tag.name}>\`'s name`),
    span: withoutTrailingNewline(
      requiredSpan(tag.span, `tag \`<${tag.name}>\``),
    ),
    attrs,
    args,
    params: tag.params,
    attrTags,
    children,
  };
}

/**
 * Projects a tag's attribute tags and children in source order, so a build
 * reject is the earliest one in the file; the two arrays stay separate.
 */
function dataParts(
  attrTagNodes: AttributeTagNode[],
  childNodes: IrNode[],
): { attrTags: DataAttrTagNode[]; children: DataNode[] } {
  const attrTags: DataAttrTagNode[] = [];
  const children: DataNode[] = [];
  for (const part of inSourceOrder(attrTagNodes, childNodes)) {
    if (part.side === "attr") {
      const built = attempt(() => dataAttrTagNode(part.node));
      if (built) attrTags.push(built);
    } else {
      const built = attempt(() => dataNode(part.node));
      if (built) children.push(built);
    }
  }
  return { attrTags, children };
}

function dataAttrTag(tag: AttributeTag): DataAttrTagNode {
  attempt(() => checkTagName(tag.name, tag.loc));
  const attrsBuildable = attempt(() => {
    rejectSpanlessShorthand(tag.attrs, tag.loc);
    return true;
  });
  const attrs = attrsBuildable ? each(tag.attrs, dataAttr) : [];
  const { attrTags, children } = dataParts(
    tag.attributeTagTree,
    tag.block.children,
  );
  // The spans are the last thing read, so a tag with a bad name or attribute
  // still has its body walked (and its inner errors recorded) before an
  // internal span invariant stops this one tag.
  return {
    kind: "attr-tag",
    name: tag.name,
    nameSpan: finiteSpan(
      tag.nameSpan,
      `attribute tag \`<@${tag.name}>\`'s name`,
    ),
    span: withoutTrailingNewline(
      requiredSpan(tag.span, `attribute tag \`<@${tag.name}>\``),
    ),
    attrs,
    params: tag.block.params,
    attrTags,
    children,
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
        branches: each(node.branches, (branch) => ({
          test: branch.test
            ? dataExpr(branch.test, "attribute-tag `<if>` condition")
            : null,
          children: each(branch.nodes, dataAttrTagNode),
          span: branch.span,
        })),
      };
    case "AttributeTagFor":
      return {
        kind: "for",
        head: dataForHead(node.loop, "attribute-tag `<for>`"),
        children: each(node.nodes, dataAttrTagNode),
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
        branches: each(node.branches, dataBranch),
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
  return each(nodes, dataNode);
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

/**
 * The authored imports, in file order, with the module specifier and the
 * names each brings in. Both come from the Babel `ImportDeclaration` the
 * front end parsed (`Import.declaration`), never from the statement text.
 */
function dataImports(ir: Ir): DataImport[] {
  const out: DataImport[] = [];
  for (const node of ir.imports) {
    if (node.synthesized) continue;
    const declaration = node.declaration as ImportDeclaration | undefined;
    if (declaration?.type !== "ImportDeclaration") {
      throw new Error(
        "@mxlang/data: core IR invariant broken — an authored `import` carries no parsed declaration",
      );
    }
    out.push({
      code: node.code,
      span: requiredSpan(node.span, "`import` statement"),
      from: declaration.source.value,
      names: declaration.specifiers.map(importName),
      ...(declaration.importKind === "type" ? { typeOnly: true as const } : {}),
    });
  }
  out.sort((a, b) => a.span.sourceStart - b.span.sourceStart);
  return out;
}

/** The source span of a parsed identifier or string literal in an import specifier. */
function nodeSpan(node: {
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  } | null;
}): SourceSpan {
  if (!node.loc) {
    throw new Error(
      "@mxlang/data: core IR invariant broken — an import specifier carries no location",
    );
  }
  return {
    sourceStart: offsetOfPosition(node.loc.start.line, node.loc.start.column),
    sourceEnd: offsetOfPosition(node.loc.end.line, node.loc.end.column),
  };
}

function importName(
  specifier: ImportDeclaration["specifiers"][number],
): DataImportName {
  const typeOnly =
    specifier.type === "ImportSpecifier" && specifier.importKind === "type"
      ? { typeOnly: true as const }
      : {};
  switch (specifier.type) {
    case "ImportDefaultSpecifier":
      return {
        imported: "default",
        local: specifier.local.name,
        kind: "default",
        span: nodeSpan(specifier.local),
      };
    case "ImportNamespaceSpecifier":
      return {
        imported: "*",
        local: specifier.local.name,
        kind: "namespace",
        span: nodeSpan(specifier.local),
      };
    case "ImportSpecifier": {
      const imported = specifier.imported;
      const local = specifier.local.name;
      const name =
        imported.type === "StringLiteral" ? imported.value : imported.name;
      return {
        // `import { "a-b" as ab }` names the export with a string literal.
        imported: name,
        local,
        kind: "named",
        span: nodeSpan(imported),
        ...(local !== name ? { localSpan: nodeSpan(specifier.local) } : {}),
        ...typeOnly,
      };
    }
  }
}

/** The error text for an authored tag with no contract in `customTags`. */
export function unknownTagMessage(
  name: string,
  declaredTags: ReadonlySet<string>,
): string {
  const near = nearestName(name, declaredTags);
  return `\`<${name}>\` is not a known tag: it has no contract in \`customTags\`${near ? `; did you mean \`<${near}>\`?` : ""}`;
}

/** An unknown authored tag, for `unknownTags: "reject"`. */
export interface UnknownTagHit {
  name: string;
  message: string;
  at: Position;
  /** Where the tag's element ends, to label the errors inside it. */
  end?: Position;
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
export function allUnknownTags(
  ir: Ir,
  declaredTags: ReadonlySet<string>,
): UnknownTagHit[] {
  const found: UnknownTagHit[] = [];
  const visitTag = (tag: DelegatedTag<unknown>) => {
    if (
      tag.nameSpan !== undefined &&
      // A wildcard child (`alias`) was claimed by its parent's contract: known.
      tag.alias === undefined &&
      !declaredTags.has(tag.name)
    ) {
      found.push({
        name: tag.name,
        message: unknownTagMessage(tag.name, declaredTags),
        at: tag.loc,
        ...(tag.span && Number.isFinite(tag.span.sourceEnd)
          ? { end: positionOfOffset(tag.span.sourceEnd) }
          : {}),
      });
    }
    visitAttrTagNodes(tag.attributeTagTree);
    visitNodes(tag.children);
  };
  const visitAttrTagNodes = (nodes: AttributeTagNode[]) => {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") {
        visitAttrTagNodes(node.tag.attributeTagTree);
        visitNodes(node.tag.block.children);
      } else if (node.kind === "AttributeTagIf") {
        for (const branch of node.branches) visitAttrTagNodes(branch.nodes);
      } else {
        visitAttrTagNodes(node.nodes);
      }
    }
  };
  const visitNodes = (nodes: IrNode[]) => {
    for (const node of nodes) {
      if (node.kind === "DelegatedTag") visitTag(node.tag);
      else if (node.kind === "IfChain") {
        for (const branch of node.branches) visitNodes(branch.children);
      } else if (node.kind === "For") visitNodes(node.children);
    }
  };
  visitNodes(ir.body);
  return found;
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
    if (node.kind === "AttributeTagIf") out.push(hit("`<if>`", node.loc));
    else if (node.kind === "AttributeTagFor") {
      out.push(hit("`<for>`", node.loc));
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
        out.push(hit("text", textPosition(node.span, node.loc)));
        break;
      case "Interpolation":
        out.push(hit(`\`\${}\``, node.loc));
        break;
      case "IfChain":
        out.push(hit("`<if>`", node.loc));
        break;
      case "For":
        out.push(hit("`<for>`", node.loc));
        break;
      case "Const":
        out.push(hit("`<const>`", node.loc));
        break;
      case "DelegatedTag":
        structuralInParts(node.tag.attributeTagTree, node.tag.children, out);
        break;
    }
  }
}

/** How a top-level `import` is treated: `imports`, else the effective `structural`. */
function importsMode(options: BuildOptions): "pass" | "reject" {
  return options.imports ?? options.structural ?? "pass";
}

/** Every structural construct, as a position and message. */
function allStructural(
  ir: Ir,
  stmts: DataStatement[],
  options: BuildOptions,
): { message: string; at: Position }[] {
  const hits: StructuralHit[] = [];
  if (options.structural === "reject") structuralInNodes(ir.body, hits);
  for (const stmt of stmts) {
    // `imports` decides an `import` on its own; the rest follow `structural`.
    if (stmt.kind === "import") {
      if (importsMode(options) !== "reject") continue;
    } else if (options.structural !== "reject") {
      continue;
    }
    hits.push({
      construct: `\`${stmt.kind}\``,
      offset: stmt.span.sourceStart,
      at: positionOfOffset(stmt.span.sourceStart),
    });
  }
  return hits.map((best) => ({
    message: structuralMessage(best.construct),
    at: best.at,
  }));
}

/** An unknown tag's element: where it opens and (when known) closes. */
export interface UnknownTagRange {
  name: string;
  at: Position;
  end?: Position;
}

/** The suffix of an error that sits inside an unknown tag's element. */
function insideUnknownTagLabel(name: string): string {
  return ` (inside the unknown tag \`<${name}>\`; may resolve once it is declared)`;
}

/**
 * Labels, never drops, the errors strictly inside an unknown tag's element
 * (decision 161: no diagnostic is dropped). An unknown tag has no contract, so
 * what is reported inside it (its children's own unknown names, a `parents`/
 * `children` error that is only the symptom of the typo) may disappear once the
 * tag is declared, while an independent mistake (a `/var`, a `<!doctype>`, a
 * structural `<if>`, an unknown attribute on a declared tag) stays; the label
 * tells an agent which is which without hiding either. The innermost enclosing
 * unknown tag names the label. An error with no position, or positioned in
 * another file (an inlined tag template), is not inside this file's element and
 * is left as is.
 */
export function labelInside(
  errors: unknown[],
  unknown: readonly UnknownTagRange[],
): unknown[] {
  const inside = (at: Position, tag: UnknownTagRange) =>
    tag.end !== undefined &&
    at.file === undefined &&
    (at.line > tag.at.line ||
      (at.line === tag.at.line && at.column > tag.at.column)) &&
    (at.line < tag.end.line ||
      (at.line === tag.end.line && at.column < tag.end.column));
  return errors.map((error) => {
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
    return new TranslateError(
      `${(error as TranslateError).message}${insideUnknownTagLabel(innermost.name)}`,
      at.line,
      at.column,
      at.file,
    );
  });
}

/** An error's source position, or `null` for one with none (an internal bug). */
function positionOf(error: unknown): Position | null {
  return isTranslateError(error)
    ? { line: error.line, column: error.column, file: error.file }
    : null;
}

/**
 * Every error of one build, earliest first.
 *
 * The build rejects, the structural hits and the unknown tags are three
 * independent walks of the IR; their errors are merged by file, line and
 * column (discovery order on a tie, so two different errors at one position
 * both stay) and only a truly identical error — the same file, position and
 * message — appears once. This is `parseData`'s order too (`errorDiagnostics`),
 * so `buildDataDocument`'s first error is `parseData`'s first diagnostic. An
 * error with no position (an internal invariant) goes last.
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

/** What `buildDataDocumentAll` returns: a tree, or every error and no tree. */
export interface BuildResult {
  tree: DataDocument | undefined;
  /** `TranslateError`s, plus an `Error` per internal invariant; earliest first. */
  errors: unknown[];
}

/**
 * Builds the tree from a lowered data compile, collecting every error: no
 * `tree` when any was found (no partial tree in v1).
 *
 * Never throws. Every recovery point records into `problems`; a throw outside
 * every one of them (a bug here) is recorded with the rest and returned, so the
 * errors already collected are never lost behind it.
 */
export function buildDataDocumentAll(
  ir: Ir,
  source: string,
  filename: string,
  options: BuildOptions,
): BuildResult {
  problems = [];
  try {
    return buildAll(ir, source, filename, options);
  } catch (error) {
    return {
      tree: undefined,
      errors: sortedProblems([...problems, error]),
    };
  }
}

function buildAll(
  ir: Ir,
  source: string,
  filename: string,
  options: BuildOptions,
): BuildResult {
  activeLineStarts = lineStartsOf(source);
  activeSource = source;
  activeSourceLength = source.length;
  const stmts = attempt(() => statements(ir)) ?? [];
  const children = dataNodes(ir.body);
  const extra: unknown[] = [];
  let unknownHits: UnknownTagHit[] = [];
  const asError = ({ message, at }: { message: string; at: Position }) =>
    new TranslateError(message, at.line, at.column, at.file);
  attempt(() => {
    for (const hit of allStructural(ir, stmts, options)) {
      extra.push(asError(hit));
    }
  });
  if (options.unknownTags === "reject") {
    attempt(() => {
      unknownHits = allUnknownTags(ir, options.declaredTags);
      for (const hit of unknownHits) extra.push(asError(hit));
    });
  }
  const errors = sortedProblems(
    labelInside([...problems, ...extra], unknownHits),
  );
  if (errors.length > 0) return { tree: undefined, errors };
  // `structural: "reject"` with `imports: "pass"`: the imports leave
  // `statements` (every other kind was just rejected) for their own list.
  if (options.structural === "reject" && importsMode(options) === "pass") {
    return {
      tree: {
        kind: "document",
        filename,
        statements: stmts.filter((stmt) => stmt.kind !== "import"),
        imports: dataImports(ir),
        children,
      },
      errors,
    };
  }
  return {
    tree: { kind: "document", filename, statements: stmts, children },
    errors,
  };
}

/**
 * `buildDataDocumentAll` for a caller that wants one error: throws the first of
 * its ordered list (the earliest positioned error, as labelled inside an
 * unknown tag; an internal error only when nothing is positioned) or returns
 * the tree. It is the same error `parseData` lists first for the file.
 */
export function buildDataDocument(
  ir: Ir,
  source: string,
  filename: string,
  options: BuildOptions,
): DataDocument {
  const { tree, errors } = buildDataDocumentAll(ir, source, filename, options);
  if (errors.length > 0 || !tree) throw errors[0];
  return tree;
}
