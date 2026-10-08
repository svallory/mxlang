/**
 * The MX front end (decision 158; ast §7): drives the template parser
 * (`../template`) and builds the MX AST from its events, one handler per row
 * of the ast §7 event table.
 *
 * Nodes are built as private mutable builders and copied into plain read-only
 * objects once the parse ends (`finish`), so no node is mutated after it is
 * attached to its parent (decision 163 addendum 5). Offsets are file-absolute
 * at creation: the fragment base is added when a node is made, never by a
 * later walk (ast §5.3).
 */
import type {
  MxBodyMode,
  MxDocument,
  MxErrorCode,
  MxFragmentBase,
  MxFrontEndOptions,
  MxParseError,
  MxStatementKeyword,
  Span,
} from "@mxlang/babel/mx-ast";
import { createParser, ErrorCode, TagType } from "../template/index.ts";
import type {
  Range,
  Ranges,
  TagType as TagTypeValue,
} from "../template/internal.ts";
import {
  type ContainerKind,
  subParse,
  wrappedAttrValueHint,
} from "./expressions.ts";
import {
  type RuleContext,
  frontEndRules as realFrontEndRules,
} from "./rules.ts";

/** Options of `parse`: the two per-target inputs (ast §7.1) and an optional fragment base (ast §5.3). */
export interface ParseOptions extends MxFrontEndOptions {
  readonly base?: MxFragmentBase;
}

/** Decision 161's wording for an error that is never the author's. */
const MX_BUG = "not yours: an MX bug";

const BODY_MODES: ReadonlySet<string> = new Set<MxBodyMode>([
  "html",
  "parsed-text",
  "preserve",
  "parsed-text-preserve",
  "void",
]);

const KEYWORD_ONLY: ReadonlySet<string> = new Set([
  "import",
  "export",
  "class",
]);

const ERROR_NAMES: ReadonlyMap<number, MxErrorCode> = new Map(
  Object.entries(ErrorCode).map(([name, code]) => [
    code as number,
    name as MxErrorCode,
  ]),
);

/**
 * Test-only seams. `frontEndRules` is PR 2b's `MX_*` rules (ast §3.13): it
 * receives each finished tag, its parent (if any), and the rule context, in
 * document order; tests replace it to silence or observe the rules.
 */
export const seams: {
  frontEndRules: (
    tag: TagBuilder,
    parent: TagBuilder | undefined,
    ctx: RuleContext,
  ) => readonly MxParseError[];
  /** Called each time a parser range past the end of input is clamped (see `FrontEnd.clamp`). */
  clamped: (local: number) => void;
  /** The template parser; a test replaces it to make the parser itself throw. */
  createParser: typeof createParser;
} = {
  frontEndRules: realFrontEndRules,
  clamped: () => {},
  createParser,
};

// ---------------------------------------------------------------------------
// Builders: mutable, private, copied into the read-only tree by `finish`.
// A key starting with `_` is builder state and is not copied.

// Builders are untyped records copied into the typed tree by `finish`.
interface Builder {
  // biome-ignore lint/suspicious/noExplicitAny: builders are untyped records copied into the typed tree
  [key: string]: any;
}

export interface TagBuilder extends Builder {
  type: "MxTag" | "MxAttributeTag" | "MxReturn";
  start: number;
  end: number;
  body: Builder[] | null;
  attributes: Builder[];
  shorthands: Builder[];
  openTag: { start: number; end: number };
  incomplete: boolean;
  /** The furthest offset any part of this tag reached, for an incomplete end (ast §3.13). */
  _reached: number;
  _closeStart: number | undefined;
  _closeName: Range | undefined;
  _openEnded: boolean;
  /** Opened with a preserving body mode; its close ends the preserved run. */
  _preserves?: boolean;
  /** Opened by `headTag` before any name event; a later name fills it in. */
  _phantom?: boolean;
}

/**
 * The whitespace layer of a normalizing body (ast §3.8, decision 166 item
 * 2): Marko's `onText` rule, reproduced. A pure whitespace run that starts
 * with a line break is layout and produces no node; otherwise the leading
 * newline-led run is dropped by what the previous sibling is (a placeholder
 * keeps it), and the trailing one is settled by what comes next — the
 * settle runs at the next content push, at a tag close, and at the end of
 * the parse, exactly where Marko's `onNext` fires. Inner whitespace
 * collapses to one space in `value`; `valueSpan` covers the trimmed text
 * before the collapse (Marko's `withLoc` range).
 */
const LAYOUT_WHITESPACE = /^(?:[\n\r][ \t\n\r\f]*)?(?:[\n\r][ \t\n\r\f]*)?$/;
const LEADING_BREAK = /^[\n\r][ \t\n\r\f]*/;
const TRAILING_BREAK = /[\n\r][ \t\n\r\f]*$/;

/**
 * Parses `source` into the MX AST (ast §3). Never throws on any input: a
 * template-parser error and a failure of the front end itself are both
 * returned in `errors` with the tree built so far (ast §3.13). Throws a
 * `TypeError` only for a missing option, a programming error.
 */
export function parse(source: string, options: ParseOptions): MxDocument {
  if (typeof source !== "string") {
    throw new TypeError("parse: `source` must be a string");
  }
  if (!options || typeof options.tagShape !== "function") {
    throw new TypeError("parse: `options.tagShape` is required (ast §7.1)");
  }
  if (!(options.statementKeywords instanceof Set)) {
    throw new TypeError(
      "parse: `options.statementKeywords` is required (ast §7.1)",
    );
  }
  const base: MxFragmentBase = options.base ?? {
    offset: 0,
    line: 0,
    column: 0,
  };
  const builder = new FrontEnd(source, options, base.offset, base);
  try {
    builder.run();
  } catch (error) {
    builder.internalError(error);
  }
  return builder.finish(base);
}

class FrontEnd {
  readonly body: Builder[] = [];
  readonly errors: MxParseError[] = [];
  templateError: MxParseError | undefined;
  readonly stack: TagBuilder[] = [];
  /** Atoms announced but not yet claimed by a container, in source order (local offsets). */
  atoms: { start: number; end: number; name: string }[] = [];
  openStart: number | undefined;
  /** The attribute-list item(s) the last `onAttrName` produced: value, args and methods attach to the last one. */
  current: Builder | undefined;
  statement:
    | { keyword: MxStatementKeyword; start: number; nameEnd: number }
    | undefined;
  /** The furthest local offset any event reached. */
  reached = 0;
  stopped = false;

  constructor(
    readonly source: string,
    readonly options: ParseOptions,
    readonly offset: number,
    readonly base: MxFragmentBase,
  ) {}

  run(): void {
    const handlers = {
      onError: (e: Ranges.Error) => this.onError(e),
      onAtom: (e: Ranges.Value) => this.onAtom(e),
      onText: (e: Range) => this.onText(e),
      onPlaceholder: (e: Ranges.Placeholder) => this.onPlaceholder(e),
      onComment: (e: Ranges.Value) => this.onComment(e),
      onCDATA: (e: Ranges.Value) => this.onValueNode("MxCDATA", e),
      onDeclaration: (e: Ranges.Value) => this.onValueNode("MxDeclaration", e),
      onDoctype: (e: Ranges.Value) => this.onValueNode("MxDoctype", e),
      onScriptlet: (e: Ranges.Scriptlet) => this.onScriptlet(e),
      onOpenTagStart: (e: Range) => this.onOpenTagStart(e),
      onOpenTagName: (e: Ranges.Template) => this.onOpenTagName(e),
      onTagShorthandId: (e: Ranges.Template) => this.onTagShorthand("#", e),
      onTagShorthandClass: (e: Ranges.Template) => this.onTagShorthand(".", e),
      onTagTypeArgs: (e: Ranges.Value) =>
        this.onTagPart("typeArgs", "MxTypeArguments", e),
      onTagVar: (e: Ranges.Value) => this.onTagPart("var", "MxPattern", e),
      onTagArgs: (e: Ranges.Value) => this.onTagPart("args", "MxArguments", e),
      onTagTypeParams: (e: Ranges.Value) =>
        this.onTagPart("typeParams", "MxTypeParameters", e),
      onTagParams: (e: Ranges.Value) =>
        this.onTagPart("params", "MxParameterList", e),
      onAttrName: (e: Range) => this.onAttrName(e),
      onAttrArgs: (e: Ranges.Value) => this.onAttrArgs(e),
      onAttrValue: (e: Ranges.AttrValue) => this.onAttrValue(e),
      onAttrMethod: (e: Ranges.AttrMethod) => this.onAttrMethod(e),
      onAttrSpread: (e: Ranges.Value) => this.onAttrSpread(e),
      onOpenTagComment: (e: Ranges.Value) => this.onOpenTagComment(e),
      onOpenTagEnd: (e: Ranges.OpenTagEnd) => this.onOpenTagEnd(e),
      onCloseTagStart: (e: Range) => this.onCloseTagStart(e),
      onCloseTagName: (e: Range) => this.onCloseTagName(e),
      onCloseTagEnd: (e: Range) => this.onCloseTagEnd(e),
    };
    // Each handler marks that the front end is running, so a throw from the
    // template parser itself (a defect there: it never throws by contract)
    // is told apart from one of ours in the internal error's message.
    const wrapped: Record<string, unknown> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      wrapped[name] = (event: never) => {
        this.inHandler = true;
        const result = (handler as (e: never) => unknown)(event);
        this.inHandler = false;
        return result;
      };
    }
    this.inTemplate = true;
    seams.createParser(wrapped).parse(this.source);
    this.inTemplate = false;
    if (!this.templateError && this.stack.length > 0) {
      // TODO `concise-eof-open-delimiter-silent` and
      // `concise-eof-interpolation-drops-event` (parser-grammar OQ 19): at
      // end of input inside a concise open delimiter the template parser
      // stops with no error and no close events. Close the tags there, as
      // today's path (Marko) keeps them; decision 163 addendum 9 (Q8).
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const tag = this.stack[i] as TagBuilder;
        tag.end = Math.max(tag._reached, tag.end);
        if (!tag._openEnded) tag.openTag.end = tag.end;
        const parent = this.stack[i - 1];
        if (parent && tag.end > parent._reached) parent._reached = tag.end;
      }
      const open = this.stack.splice(0).reverse();
      // `open` is outermost-first: each tag's ancestor is the next entry
      // (mirroring `stopAll`), so the root rule sees real nesting here too.
      for (let i = 0; i < open.length; i++) {
        this.runRules(open[i], open[i + 1]);
      }
    }
    this.settle();
  }

  // --- positions -----------------------------------------------------------

  at(local: number): number {
    return this.offset + this.clamp(local);
  }

  /**
   * The one clamp: TODO `concise-eof-open-delimiter-silent` and TODO
   * `concise-eof-interpolation-drops-event` report some ranges one past the
   * end of input (`div(a` gives tag arguments 3-6 on five characters).
   */
  clamp(local: number): number {
    if (local <= this.source.length) return local;
    seams.clamped(local);
    return this.source.length;
  }

  span(range: Range): Span {
    return { start: this.at(range.start), end: this.at(range.end) };
  }

  /** The line starts of this source, as htmljs's `getLines` builds them (only `\n` starts a line). */
  private lines(): readonly number[] {
    this._lines ??= (() => {
      const found = [0];
      for (
        let at = this.source.indexOf("\n");
        at !== -1;
        at = this.source.indexOf("\n", at + 1)
      )
        found.push(at + 1);
      return found;
    })();
    return this._lines;
  }

  private _lines: readonly number[] | undefined;

  /** The file-absolute 1-based line and 0-based column of a local offset (ast §5.2, §5.3). */
  positionAt(local: number): { line: number; column: number } {
    const starts = this.lines();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] as number) <= local) low = mid;
      else high = mid - 1;
    }
    return {
      line: 1 + this.base.line + low,
      column:
        low === 0
          ? local - (starts[0] as number) + this.base.column
          : local - (starts[low] as number),
    };
  }

  slice(range: Range): string {
    return this.source.slice(this.clamp(range.start), this.clamp(range.end));
  }

  /**
   * Records how far the parse got: the innermost open tag's furthest part.
   * A tag hands its end to its parent when it closes (`close`, `stopAll`),
   * so this stays constant time however deep the nesting.
   */
  reach(local: number): void {
    if (local > this.reached) this.reached = local;
    const top = this.top;
    if (top && this.at(local) > top._reached) top._reached = this.at(local);
  }

  // --- containers and atoms ------------------------------------------------

  /**
   * An expression container over `value` (ast §4.1): span and source are the
   * value range, `outer` the range with the position's delimiters. It claims
   * the pending atoms inside its span, so a nested container built first
   * keeps its own (decision 163 addendum 8: innermost only).
   */
  container(
    type: ContainerKind,
    value: Range,
    outer: Range = value,
    hints: "attr-value" | null = null,
  ): Builder {
    const atoms: Builder[] = [];
    const rest: typeof this.atoms = [];
    for (const atom of this.atoms) {
      if (atom.start >= value.start && atom.end <= value.end) {
        atoms.push({
          type: "MxAtom",
          start: this.at(atom.start),
          end: this.at(atom.end),
          name: atom.name,
        });
      } else rest.push(atom);
    }
    this.atoms = rest;
    const start = this.at(value.start);
    const end = this.at(value.end);
    const text = this.slice(value);
    // The sub-parse (ast §4.1): the container's position carries the fragment
    // base, so the payload's offsets are file-absolute at creation.
    const position = this.positionAt(value.start);
    const result = subParse(
      type,
      text,
      atoms.map((atom: Builder) => ({
        start: (atom.start as number) - start,
        end: (atom.end as number) - start,
        name: atom.name as string,
      })),
      { offset: start, line: position.line, column: position.column },
      end,
    );
    let error = result.error;
    if (error !== null) {
      if (
        hints === "attr-value" &&
        text.startsWith("$!{") &&
        error.code.startsWith("BABEL_")
      ) {
        // Decision 166 item 1: `$!{…}` as an attribute value gets its own
        // code; the message and position are today's, byte for byte (there
        // is no dedicated message today — the Babel error is the report).
        error = { ...error, code: "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE", origin: "front-end" };
      } else if (
        hints === "attr-value" &&
        /^\{[\s\S]*\}$/.test(text.trim())
      ) {
        // Marko's `withWrappedAttrValueHint` (ast §3.13 item 2); the text is
        // today's, byte for byte, until the lead rules the MX rewording.
        error = {
          ...error,
          message: `${error.message}${error.message.endsWith(".") ? "" : "."}${wrappedAttrValueHint(text, { offset: start, line: position.line, column: position.column }, end)}`,
        };
      }
      if (error !== result.error) this.errors.push(error);
      else this.errors.push(error);
    }
    return {
      type,
      start,
      end,
      source: text,
      outer: this.span(outer),
      atoms,
      node: result.node,
      error,
    };
  }

  /**
   * Marko's template-string rule (`parseTemplateString`, ast §3.3): one
   * `${…}` between empty quasis is that expression; anything else is one
   * container over the whole written text.
   */
  templateContainer(template: {
    quasis: readonly Range[];
    expressions: readonly Ranges.Value[];
  }): Builder {
    const { quasis, expressions } = template;
    const [first] = quasis;
    const last = quasis[quasis.length - 1];
    const only = expressions[0];
    if (
      expressions.length === 1 &&
      only &&
      first &&
      last &&
      first.start === first.end &&
      last.start === last.end
    ) {
      return this.container("MxExpression", only.value, only);
    }
    const whole = { start: first?.start ?? 0, end: last?.end ?? 0 };
    return this.container("MxExpression", whole);
  }

  onAtom(event: Ranges.Value): void {
    this.atoms.push({
      start: event.start,
      end: event.end,
      name: this.slice(event.value),
    });
  }

  // --- children ------------------------------------------------------------

  get top(): TagBuilder | undefined {
    return this.stack[this.stack.length - 1];
  }

  pushChild(node: Builder): void {
    this.settle(node);
    const top = this.top;
    if (top) {
      if (!top.body) throw new Error("a child arrived for a tag with no body");
      top.body.push(node);
    } else this.body.push(node);
    this.reach(node.end - this.offset);
  }

  onText(range: Range): void {
    const raw = this.slice(range);
    const span = this.span(range);
    if (this.preserving === 0) {
      if (LAYOUT_WHITESPACE.test(raw)) return;
      let value = raw;
      switch (this.previousSibling()?.type) {
        case "MxPlaceholder":
          break;
        case "MxText": {
          const previous = this.previousSibling() as { value: string };
          if (/[ \t\n\r\f]$/.test(previous.value))
            value = value.replace(/^[ \t\n\r\f]+/, "");
          break;
        }
        case "MxTag":
        case "MxReturn":
          break;
        case "MxAttributeTag":
        case "MxModuleStatement":
          value = value.replace(LEADING_BREAK, "");
          break;
        default:
          value = value.replace(LEADING_BREAK, "");
      }
      if (value === "") return;
      const node: Builder = {
        type: "MxText",
        ...span,
        value,
        raw,
        valueSpan: { ...span },
      };
      this.pushChild(node);
      this.pending = {
        node,
        body: (this.top?.body ?? this.body) as Builder[],
        raw,
        start: range.start,
        value,
      };
      return;
    }
    this.pushChild({
      type: "MxText",
      ...span,
      value: raw,
      raw,
      valueSpan: { ...span },
    });
  }

  /** The last child of the body the next child joins, skipping scriptlets and comments (Marko's `onText` prev scan). */
  previousSibling(): Builder | undefined {
    const body = (this.top?.body ?? this.body) as Builder[];
    for (let at = body.length - 1; at >= 0; at--) {
      const node = body[at] as Builder;
      if (node.type === "MxScriptlet" || node.type === "MxComment") continue;
      return node;
    }
    return undefined;
  }

  /** Open tags whose body preserves whitespace (Marko's `preservingWhitespaceUntil`). */
  preserving = 0;

  /** A pending text node's settle state (Marko's `onNext` closure). */
  pending:
    | {
        node: Builder;
        body: Builder[];
        raw: string;
        start: number;
        value: string;
      }
    | undefined;

  /**
   * The whitespace settle of the pending text node (Marko's `onNext`): the
   * next content node decides the trailing trim; a scriptlet or comment
   * leaves it pending for the node after. Every pushed child, every tag
   * close and the end of the parse pass through here.
   */
  settle(next?: Builder): void {
    const pending = this.pending;
    if (!pending) return;
    switch (next?.type) {
      case "MxScriptlet":
      case "MxComment":
        return;
      case "MxPlaceholder":
      case "MxTag":
      case "MxReturn":
        break;
      case "MxText":
        if (/^[ \t\n\r\f]/.test((next as { value: string }).value))
          pending.value = pending.value.replace(/[ \t\n\r\f]+$/, "");
        break;
      default:
        pending.value = pending.value.replace(TRAILING_BREAK, "");
    }
    this.pending = undefined;
    const value = pending.value.replace(/[ \t\n\r\f]+/g, " ");
    if (value === "") {
      const at = pending.body.indexOf(pending.node);
      if (at >= 0) pending.body.splice(at, 1);
      return;
    }
    const trimmedAt = pending.raw.indexOf(pending.value);
    const start = trimmedAt < 0 ? 0 : pending.start + trimmedAt;
    pending.node.value = value;
    pending.node.valueSpan = {
      start: this.at(start),
      end: this.at(start + pending.value.length),
    };
  }

  onPlaceholder(event: Ranges.Placeholder): void {
    const expression = this.container("MxExpression", event.value, event);
    this.pushChild({
      type: "MxPlaceholder",
      ...this.span(event),
      escape: event.escape,
      expression,
    });
  }

  onScriptlet(event: Ranges.Scriptlet): void {
    const code = this.container(
      "MxStatements",
      event.value,
      event.block ? braced(this.source, event.value) : event.value,
    );
    this.pushChild({
      type: "MxScriptlet",
      ...this.span(event),
      block: event.block,
      code,
    });
  }

  onComment(event: Ranges.Value): void {
    this.pushChild({
      type: "MxComment",
      ...this.span(event),
      kind: commentKind(this.source, event.start),
      value: this.slice(event.value),
      valueSpan: this.span(event.value),
    });
  }

  onValueNode(type: string, event: Ranges.Value): void {
    this.pushChild({
      type,
      ...this.span(event),
      value: this.slice(event.value),
      valueSpan: this.span(event.value),
    });
  }

  // --- open tag ------------------------------------------------------------

  onOpenTagStart(range: Range): void {
    this.openStart = range.start;
  }

  onOpenTagName(template: Ranges.Template): TagTypeValue {
    const concise = this.openStart === undefined;
    const start = this.openStart ?? template.start;
    this.openStart = undefined;
    this.current = undefined;
    const dynamic = template.expressions.length > 0;
    const written = dynamic ? undefined : this.slice(template);

    if (
      written !== undefined &&
      concise &&
      this.options.statementKeywords.has(written as MxStatementKeyword)
    ) {
      // Decision 163 addendum 7 (Q4): a concise line only; nested, the
      // template parser reports ROOT_TAG_ONLY itself, as today.
      this.statement = {
        keyword: written as MxStatementKeyword,
        start: template.start,
        nameEnd: template.end,
      };
      return TagType.statement;
    }

    let type: TagBuilder["type"] = "MxTag";
    let name: Builder;
    let bodyMode: MxBodyMode = "html";
    const shorthands: Builder[] = [];
    if (written === undefined) {
      name = {
        kind: "dynamic",
        expression: this.templateContainer(template),
        span: this.span(template),
      };
    } else if (written.startsWith("@")) {
      // An attribute tag is never asked: its body is html, and `tagShape`
      // only sees names that are tags (decision 163 addendum 8).
      type = "MxAttributeTag";
      name = { value: written.slice(1), span: this.span(template) };
    } else {
      bodyMode = this.shapeOf(written);
      const colon = written.indexOf(":");
      const value = colon < 0 ? written : written.slice(0, colon);
      name =
        value === ""
          ? {
              kind: "unnamed",
              span: {
                start: this.at(template.start),
                end: this.at(template.start),
              },
            }
          : {
              kind: "static",
              value,
              span: this.span({
                start: template.start,
                end: template.start + value.length,
              }),
            };
      if (value === "return") type = "MxReturn";
      // ast §3.3: from the first `:` on is a tag-position `:` sugar.
      if (colon >= 0 && colon + 1 < written.length) {
        shorthands.push(
          this.staticShorthand(
            ":",
            "tag",
            template.start + colon,
            template.end,
          ),
        );
      }
    }

    const phantom = this.top;
    if (phantom?._phantom && !phantom._openEnded) {
      // A concise attribute group (`[/* c */ …`) reports head events before
      // the name: the tag `headTag` opened for them is this one.
      phantom._phantom = false;
      phantom.type = type;
      phantom.name = name;
      phantom.bodyMode = bodyMode;
      phantom.shorthands.push(...shorthands);
      this.reach(template.end);
    } else {
      this.openTag(
        start,
        concise,
        name,
        type,
        bodyMode,
        shorthands,
        template.end,
      );
    }
    switch (bodyMode) {
      case "void":
        return TagType.void;
      case "parsed-text":
      case "parsed-text-preserve":
        return TagType.text;
      default:
        return TagType.html;
    }
  }

  openTag(
    start: number,
    concise: boolean,
    name: Builder,
    type: TagBuilder["type"],
    bodyMode: MxBodyMode,
    shorthands: Builder[],
    headEnd: number,
  ): void {
    const tag: TagBuilder = {
      type,
      start: this.at(start),
      end: this.at(headEnd),
      name,
      typeArgs: null,
      var: null,
      args: null,
      typeParams: null,
      params: null,
      shorthands,
      attributes: [],
      body: null,
      bodyMode,
      selfClosed: false,
      concise,
      openTag: { start: this.at(start), end: this.at(headEnd) },
      closeTag: null,
      incomplete: false,
      _reached: this.at(headEnd),
      _closeStart: undefined,
      _closeName: undefined,
      _openEnded: false,
    } as TagBuilder;
    if (bodyMode === "preserve" || bodyMode === "parsed-text-preserve") {
      this.preserving++;
      tag._preserves = true;
    }
    this.pushChild(tag);
    this.stack.push(tag);
    this.reach(headEnd);
  }

  shapeOf(written: string): MxBodyMode {
    const mode = this.options.tagShape(written);
    if (!BODY_MODES.has(mode)) {
      throw new Error(
        `tagShape(${JSON.stringify(written)}) answered ${JSON.stringify(mode)}, not a body mode`,
      );
    }
    return mode;
  }

  /** A shorthand with a static value from `sigilAt` (the sigil) to `end`, local offsets. */
  staticShorthand(
    sigil: "#" | "." | ":",
    position: "tag" | "attribute",
    sigilAt: number,
    end: number,
  ): Builder {
    const value = { start: sigilAt + 1, end };
    return {
      type: "MxShorthand",
      start: this.at(sigilAt),
      end: this.at(end),
      sigil,
      position,
      value: {
        kind: "static",
        value: this.slice(value),
        span: this.span(value),
      },
      operator: null,
      default: null,
      args: null,
    };
  }

  /**
   * `onTagShorthandId`/`onTagShorthandClass` (ast §3.6, "Splitting a
   * shorthand value"): the static tail after the last `${…}` splits at its
   * first `:` into a tag-position `:` sugar; a value the split leaves empty
   * makes no shorthand for its sigil.
   */
  onTagShorthand(sigil: "#" | ".", template: Ranges.Template): void {
    if (this.statement) return; // a statement's continuation line (g0895)
    const tag = this.headTag(template.start);
    const quasis = template.quasis.map((q) => ({ ...q }));
    const last = quasis[quasis.length - 1] as Range;
    const colonInLast = this.slice(last).indexOf(":");
    const colon = colonInLast < 0 ? -1 : last.start + colonInLast;
    const valueEnd = colon < 0 ? template.end : colon;
    last.end = valueEnd;
    if (template.expressions.length === 0) {
      if (valueEnd > template.start + 1) {
        tag.shorthands.push(
          this.staticShorthand(sigil, "tag", template.start, valueEnd),
        );
      }
    } else {
      // Inner containers first: each atom belongs to the innermost one.
      const expressions = template.expressions.map((e) =>
        this.container("MxExpression", e.value, e),
      );
      const templateNode = this.templateContainer({
        quasis,
        expressions: template.expressions,
      });
      const value = { start: template.start + 1, end: valueEnd };
      tag.shorthands.push({
        type: "MxShorthand",
        start: this.at(template.start),
        end: this.at(valueEnd),
        sigil,
        position: "tag",
        value: {
          kind: "dynamic",
          template: templateNode,
          quasis: quasis.map((q) => this.span(q)),
          expressions,
          span: this.span(value),
        },
        operator: null,
        default: null,
        args: null,
      });
    }
    if (colon >= 0 && colon + 1 < template.end) {
      tag.shorthands.push(
        this.staticShorthand(":", "tag", colon, template.end),
      );
    }
    this.reach(template.end);
  }

  onTagPart(
    field: string,
    type: ContainerKind,
    event: Ranges.Value,
  ): void {
    if (this.statement) return; // a statement's continuation line (g0895)
    const tag = this.headTag(event.start);
    tag[field] = this.container(type, event.value, event);
    this.reach(event.end);
  }

  /**
   * The open tag a head event belongs to. Interim (decision 163 addendum 9):
   * a concise line that opens a tag with no name (`,` alone, `,// c`) gets
   * head events and the open tag's end but no `onOpenTagName`
   * (parser-grammar, "a named close tag when the open tag never got its
   * name", g1683); the tag is unnamed, at its first head event. PR 2b
   * records MX_TAG_NAME_MISSING here instead; today's path crashes.
   */
  headTag(at: number): TagBuilder {
    const top = this.top;
    if (top && !top._openEnded) return top;
    // In HTML mode (`<,/>`) the tag starts at its pending `<`; the empty
    // name sits right after it, as for any unnamed tag (ast §3.3).
    const open = this.openStart;
    this.openStart = undefined;
    const nameAt = open === undefined ? at : open + 1;
    this.openTag(
      open ?? at,
      open === undefined,
      {
        kind: "unnamed",
        span: { start: this.at(nameAt), end: this.at(nameAt) },
      },
      "MxTag",
      this.shapeOf(""),
      [],
      at,
    );
    const tag = this.requireTag();
    tag._phantom = true;
    return tag;
  }

  requireTag(): TagBuilder {
    const tag = this.top;
    if (!tag) throw new Error("a tag event arrived with no open tag");
    return tag;
  }

  // --- attributes ----------------------------------------------------------

  onAttrName(range: Range): void {
    // A statement's continuation line (`static x = 1\n, y`) reports its
    // words as attribute names; they are inside the statement's range,
    // which the statement node covers (g0895).
    if (this.statement) return;
    const tag = this.headTag(range.start);
    const text = this.slice(range);
    const items: Builder[] = [];
    if (text === "") {
      items.push({
        type: "MxAttribute",
        start: this.at(range.start),
        end: this.at(range.start),
        name: null,
        nameSpan: { start: this.at(range.start), end: this.at(range.start) },
        modifier: null,
        modifierSpan: null,
        operator: null,
        value: null,
        args: null,
      });
    } else if (text[0] === ":") {
      items.push(...this.sugarParts(":", range.start, range.end));
    } else if (text[0] === "#" || text[0] === ".") {
      for (const part of splitChain(text)) {
        const partStart = range.start + part.start;
        items.push(
          ...this.sugarParts(part.sigil, partStart, range.start + part.end),
        );
      }
    } else {
      // Decision 163 addendum 12: the split is kept as data, and the name
      // is the head before the last colon — `nameSpan` covers the head only.
      // A trailing colon is an empty modifier with a zero-width span after it.
      const colon = text.lastIndexOf(":");
      items.push({
        type: "MxAttribute",
        ...this.span(range),
        name: colon < 0 ? text : text.slice(0, colon),
        nameSpan:
          colon < 0
            ? this.span(range)
            : {
                start: this.at(range.start),
                end: this.at(range.start + colon),
              },
        modifier: colon < 0 ? null : text.slice(colon + 1),
        modifierSpan:
          colon < 0
            ? null
            : {
                start: this.at(range.start + colon + 1),
                end: this.at(range.end),
              },
        operator: null,
        value: null,
        args: null,
      });
    }
    tag.attributes.push(...items);
    this.current = items[items.length - 1];
    this.reach(range.end);
  }

  /** One attribute-position sugar from its sigil to `end`, split at the first `:` outside `${…}` (ast §3.6 rule 1). */
  sugarParts(sigil: "#" | "." | ":", sigilAt: number, end: number): Builder[] {
    const colon = firstColonOutsidePlaceholders(this.source, sigilAt + 1, end);
    if (colon < 0)
      return [this.staticShorthand(sigil, "attribute", sigilAt, end)];
    return [
      this.staticShorthand(sigil, "attribute", sigilAt, colon),
      this.staticShorthand(":", "attribute", colon, end),
    ];
  }

  requireCurrent(): Builder {
    const current = this.current;
    if (!current)
      throw new Error("an attribute part arrived with no attribute");
    return current;
  }

  onAttrArgs(event: Ranges.Value): void {
    if (this.statement) return;
    const current = this.requireCurrent();
    if (current.type === "MxAttribute") {
      current.args = this.container("MxArguments", event.value, event);
      current.end = this.at(event.end);
    } else {
      // Arguments after a sugar (`.c(p)`) are kept on the node, atoms
      // included; PR 2b raises MX_SUGAR_ARGUMENTS at the sugar (decision
      // 163 addendum 11, ast §3.6 rule 6).
      current.args = this.container("MxArguments", event.value, event);
    }
    this.reach(event.end);
  }

  onAttrValue(event: Ranges.AttrValue): void {
    if (this.statement) return;
    const current = this.requireCurrent();
    const value = this.container("MxExpression", event.value, event.value, "attr-value");
    const operator = event.bound ? ":=" : "=";
    if (current.type === "MxAttribute") {
      current.operator = operator;
      current.value = value;
      current.end = value.end;
    } else {
      current.operator = operator;
      current.default = value;
    }
    this.reach(event.end);
  }

  onAttrMethod(event: Ranges.AttrMethod): void {
    if (this.statement) return;
    const current = this.requireCurrent();
    const typeParams = event.typeParams
      ? this.container(
          "MxTypeParameters",
          event.typeParams.value,
          event.typeParams,
        )
      : null;
    const params = this.container(
      "MxParameterList",
      event.params.value,
      event.params,
    );
    const body = this.container("MxStatements", event.body.value, event.body);
    const method = {
      type: "MxMethod",
      ...this.span(event),
      async: event.async,
      typeParams,
      params,
      body,
      source: this.slice(event),
    };
    if (current.type === "MxAttribute") {
      current.value = method;
      if (current.name === null) {
        // The default value's name is zero-width at the `(` (ast §3.5); the
        // parser's empty name sits at `async` or a type parameter's `<`.
        const paren = this.at(event.params.start);
        current.nameSpan = { start: paren, end: paren };
        current.start = method.start;
      }
      current.start = Math.min(current.start, method.start);
      current.end = method.end;
    } else {
      current.default = method;
    }
    this.reach(event.end);
  }

  onAttrSpread(event: Ranges.Value): void {
    if (this.statement) return;
    const tag = this.headTag(event.start);
    tag.attributes.push({
      type: "MxSpreadAttribute",
      ...this.span(event),
      value: this.container("MxExpression", event.value),
    });
    this.current = undefined;
    this.reach(event.end);
  }

  onOpenTagComment(event: Ranges.Value): void {
    if (this.statement) return;
    const tag = this.headTag(event.start);
    tag.attributes.push({
      type: "MxComment",
      ...this.span(event),
      kind: this.source.charCodeAt(event.start + 1) === 42 ? "block" : "line",
      value: this.slice(event.value),
      valueSpan: this.span(event.value),
    });
    this.reach(event.end);
  }

  onOpenTagEnd(event: Ranges.OpenTagEnd): void {
    this.current = undefined;
    const statement = this.statement;
    if (statement) {
      this.statement = undefined;
      this.pushStatement(statement, event.end);
      return;
    }
    const tag = this.headTag(event.start);
    // A concise head ends at its last non-whitespace character (ast §3.10:
    // a span is right-trimmed, as for every node); the parser's range keeps
    // the whitespace before a `--` or the line end.
    let headEnd = event.end;
    if (tag.concise) {
      // Never back past the last part of the head (`_reached`): a part's
      // own range may end in whitespace the parser read into it.
      const lastPart = tag._reached - this.offset;
      while (
        headEnd > lastPart &&
        isTrimmable(this.source.charCodeAt(headEnd - 1))
      ) {
        headEnd--;
      }
    }
    tag.openTag.end = this.at(headEnd);
    tag._openEnded = true;
    tag.selfClosed = event.selfClosed;
    tag.end = this.at(headEnd);
    this.reach(event.end);
    if (event.selfClosed || tag.bodyMode === "void") {
      this.close(tag);
    } else {
      tag.body = [];
    }
  }

  /** `MxModuleStatement` (ast §3.10): span right-trimmed, `untrimmedEnd` the parser's range end. */
  pushStatement(
    statement: { keyword: MxStatementKeyword; start: number },
    untrimmedEnd: number,
  ): void {
    let end = untrimmedEnd;
    while (
      end > statement.start &&
      isTrimmable(this.source.charCodeAt(end - 1))
    ) {
      end--;
    }
    let codeStart = statement.start;
    if (!KEYWORD_ONLY.has(statement.keyword)) {
      codeStart += statement.keyword.length;
      while (
        codeStart < end &&
        isTrimmable(this.source.charCodeAt(codeStart))
      ) {
        codeStart++;
      }
    }
    const code = this.container("MxStatements", { start: codeStart, end });
    this.pushChild({
      type: "MxModuleStatement",
      start: this.at(statement.start),
      end: this.at(end),
      keyword: statement.keyword,
      code,
      untrimmedEnd: this.at(untrimmedEnd),
    });
    this.reach(untrimmedEnd);
  }

  // --- close tag -----------------------------------------------------------

  onCloseTagStart(range: Range): void {
    // Not attached until the close tag ends: an incomplete tag never
    // reaches into a close tag it did not get (ast §3.13).
    // With no open tag the template parser reports EXTRA_CLOSING_TAG next.
    const tag = this.top;
    if (tag) tag._closeStart = range.start;
  }

  onCloseTagName(range: Range): void {
    const tag = this.top;
    if (tag) tag._closeName = range;
  }

  onCloseTagEnd(range: Range): void {
    const tag = this.requireTag();
    if (tag._closeStart !== undefined) {
      const name = tag._closeName;
      const written = name && name.end > name.start;
      tag.closeTag = {
        span: this.span({ start: tag._closeStart, end: range.end }),
        name: written ? this.slice(name) : null,
        nameSpan: written ? this.span(name) : null,
      };
    }
    // A tag closed without a written close tag (a concise block, or an
    // HTML-mode tag the parser ends at a dedent) ends at its last
    // descendant (ast §3.2); the parser's close range can end one short of
    // it, after a block scriptlet (template parser defect, PR 2 report).
    tag.end =
      tag._closeStart === undefined
        ? Math.max(this.at(range.end), tag._reached)
        : this.at(range.end);
    this.reach(range.end);
    this.close(tag);
  }

  close(tag: TagBuilder): void {
    this.settle();
    if (this.stack.pop() !== tag) {
      throw new Error("closed a tag that is not the innermost open one");
    }
    if (tag._preserves) this.preserving--;
    const parent = this.top;
    if (parent && tag.end > parent._reached) parent._reached = tag.end;
    this.runRules(tag, parent);
  }

  runRules(tag: TagBuilder, parent: TagBuilder | undefined): void {
    this.errors.push(
      ...seams.frontEndRules(tag, parent, {
        source: this.source,
        offset: this.offset,
        statementKeywords: this.options.statementKeywords,
      }),
    );
  }

  // --- errors --------------------------------------------------------------

  onError(event: Ranges.Error): void {
    const code = ERROR_NAMES.get(event.code);
    if (!code)
      throw new Error(`unknown template-parser error code ${event.code}`);
    this.templateError = {
      type: "MxParseError",
      ...this.span(event),
      code,
      origin: "template",
      message: event.message,
      context: null,
    };
    this.stopAll(event.start);
  }

  /**
   * Ends every open tag at the stop point (ast §3.13, decision 163 addendum
   * 8): its end is the error's start or the furthest part attached to it,
   * whichever is later; the parse delivers no further event.
   */
  stopAll(at: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.settle();
    const statement = this.statement;
    this.statement = undefined;
    if (statement) {
      // A statement the error cut short is kept (decision 163 addendum 10):
      // its range runs to the error's start or its last part, whichever is
      // later; `end` is that range right-trimmed, as for every statement.
      this.pushStatement(statement, Math.max(at, statement.nameEnd));
    }
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const tag = this.stack[i] as TagBuilder;
      const end = Math.max(this.at(at), tag._reached);
      tag.incomplete = true;
      tag.closeTag = null;
      tag.end = end;
      if (!tag._openEnded) tag.openTag.end = end;
      const parent = this.stack[i - 1];
      if (parent && end > parent._reached) parent._reached = end;
    }
    const open = this.stack.splice(0).reverse();
    for (let i = 0; i < open.length; i++) {
      this.runRules(open[i], open[i + 1]);
    }
  }

  /** A failure of the front end itself (ast §3.13, `MX_FRONT_END_INTERNAL`). */
  internalError(error: unknown): void {
    const raw =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    const at = this.at(this.reached);
    this.errors.push({
      type: "MxParseError",
      start: at,
      end: at,
      code: "MX_FRONT_END_INTERNAL",
      origin: "front-end",
      message:
        !this.inTemplate || this.inHandler
          ? `The MX front end failed while building the syntax tree (${MX_BUG}): ${raw}`
          : `The MX template parser threw instead of reporting an error (${MX_BUG}): ${raw}`,
      context: null,
    });
    this.internal = true;
    try {
      this.stopAll(this.reached);
    } catch {
      this.stack.length = 0;
    }
  }

  internal = false;
  /** Inside the template parser's `parse` call. */
  inTemplate = false;
  /** Inside one of the front end's handlers (set only while `inTemplate`). */
  inHandler = false;

  finish(base: MxFragmentBase): MxDocument {
    const errors = [...this.errors].sort((a, b) => a.start - b.start);
    if (this.templateError) errors.push(this.templateError);
    const document = {
      type: "MxDocument",
      start: base.offset,
      end: base.offset + this.source.length,
      body: this.body,
      errors,
      complete: !this.templateError && !this.internal,
      source: this.source,
      base: { offset: base.offset, line: base.line, column: base.column },
    };
    // SAFETY: `freezeCopy` copies the builder tree shape verbatim.
    return freezeCopy(document) as unknown as MxDocument;
  }
}

/**
 * Copies a builder tree into fresh plain objects, dropping builder state
 * (`_` keys). Iterative, so a deeply nested document cannot overflow the
 * stack (`scaling.test.ts`, the deep shape).
 */
/** Anything a builder tree holds: builders, plain arrays, or a leaf value. */
// SAFETY: the copy keeps leaves verbatim and rebuilds only objects.
type Copy = null | boolean | number | string | Copy[] | { [key: string]: Copy };

function freezeCopy(root: unknown): Copy {
  // SAFETY: every leaf is copied verbatim; only objects are fresh copies,
  // each distinct object copied once so shared references (a container's
  // error and its entry in `errors`, ast §3.13) stay one object.
  const copies = new Map<unknown, Copy>();
  const copyOf = (value: Copy): Copy => {
    if (value === null || typeof value !== "object") return value;
    let copy = copies.get(value);
    if (copy === undefined) {
      copy = Array.isArray(value) ? new Array(value.length) : {};
      copies.set(value, copy);
    }
    return copy;
  };
  const top = copyOf(root as Copy);
  const work: [unknown, unknown][] = [[root, top]];
  while (work.length > 0) {
    const pair = work.pop() as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const [from, to] = pair;
    if (from === null || typeof from !== "object") continue;
    for (const [key, field] of Object.entries(from)) {
      if (key.startsWith("_")) continue;
      const copy = copyOf(field as Copy);
      to[key] = copy;
      if (copy !== field) work.push([field, copy]);
    }
  }
  return top;
}

function commentKind(source: string, at: number): "html" | "line" | "block" {
  if (source.startsWith("<!--", at)) return "html";
  return source.startsWith("/*", at) ? "block" : "line";
}

/** The range of `{ … }` around a scriptlet block's value. */
function braced(source: string, value: Range): Range {
  let start = value.start;
  while (start > 0 && source.charCodeAt(start - 1) !== 123) start--;
  let end = value.end;
  while (end < source.length && source.charCodeAt(end) !== 125) end++;
  return { start: start - 1, end: end + 1 };
}

function isTrimmable(code: number): boolean {
  return /\s/.test(String.fromCharCode(code));
}

/** `.c#m.d` → its `.`/`#` parts outside any `${…}` (today's `splitShorthandChain`), offsets within `text`. */
function splitChain(
  text: string,
): { sigil: "#" | "."; start: number; end: number }[] {
  const parts: { sigil: "#" | "."; start: number; end: number }[] = [];
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (depth === 0 && (char === "." || char === "#")) {
      const previous = parts[parts.length - 1];
      if (previous) previous.end = at;
      parts.push({ sigil: char, start: at, end: text.length });
      continue;
    }
    if (char === "$" && text[at + 1] === "{") {
      depth++;
      at++;
      continue;
    }
    if (depth > 0 && char === "{") depth++;
    if (depth > 0 && char === "}") depth--;
  }
  return parts;
}

function firstColonOutsidePlaceholders(
  source: string,
  start: number,
  end: number,
): number {
  let depth = 0;
  for (let at = start; at < end; at++) {
    const char = source[at];
    if (char === "$" && source[at + 1] === "{") {
      depth++;
      at++;
      continue;
    }
    if (depth > 0 && char === "{") depth++;
    else if (depth > 0 && char === "}") depth--;
    else if (depth === 0 && char === ":") return at;
  }
  return -1;
}
