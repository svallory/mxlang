import * as _ErrorCode from "./error-code.ts";
import * as _TagType from "./tag-type.ts";

// Same format as https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#position
export interface Position {
  /**
   * Line position in a document (zero-based).
   */
  line: number;
  /**
   * Character offset on a line in a document (zero-based).
   */
  character: number;
}

// Same format as https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#range
export interface Location {
  start: Position;
  end: Position;
}

export interface Range {
  /**
   * The start characters offset from the beginning of the document (zero-based).
   */
  start: number;
  /**
   * The end characters offset from the beginning of the document (zero-based).
   */
  end: number;
}

export namespace Ranges {
  export interface Value extends Range {
    value: Range;
  }

  export interface Template extends Range {
    expressions: Value[];
    quasis: Range[];
  }

  export interface Error extends Range {
    code: ErrorCode;
    message: string;
  }

  export interface Scriptlet extends Value {
    block: boolean;
  }

  export interface Placeholder extends Value {
    escape: boolean;
  }

  export interface AttrValue extends Value {
    bound: boolean;
  }

  export interface AttrMethod extends Range {
    body: Value;
    params: Value;
    typeParams: Value | undefined;
    /** Whether an `async` keyword preceded it; the range starts there. */
    async: boolean;
  }

  export interface OpenTagEnd extends Range {
    selfClosed: boolean;
  }

  /**
   * MX (decision 182): a syntax table's filter (`::name:: … ::`): the whole
   * filter, its name, and its raw body as `value`.
   */
  export interface Filter extends Value {
    name: Range;
  }

  /**
   * MX (decision 182): a syntax-table trigger. `start`/`end` cover the whole
   * construct: the matched text, plus `=value` for an attribute or line
   * trigger that has one. `text` is what the matcher matched.
   */
  export interface Trigger extends Range {
    id: string;
    /** The table list that armed it. */
    position: "expression" | "attribute" | "line";
    standIn: "number" | "identifier" | "keep";
    text: Range;
    /** The `=value` expression of an attribute or line trigger, `=` excluded. */
    value?: Range;
  }
}

export const ErrorCode = _ErrorCode;
export const TagType = _TagType;
export type ErrorCode = (typeof _ErrorCode)[keyof typeof _ErrorCode];
export type TagType = (typeof _TagType)[keyof typeof _TagType];

export interface ParserOptions {
  onError?(data: Ranges.Error): void;
  /**
   * MX (decision 156): an atom `:name` was lexed; one call per atom, in
   * source order. The range is the whole atom (`:` included); `value` is its
   * name. `read()` of the atom's own range returns its stand-in (`0.`), by
   * design; slice the source for the atom's text, or read `value` for its
   * name.
   */
  onAtom?(data: Ranges.Value): void;
  /**
   * MX (decision 182): a syntax-table trigger was lexed; one call per
   * trigger, after its `=value` (if any) was lexed. `read()` of its `text`
   * returns its stand-in.
   */
  onTrigger?(data: Ranges.Trigger): void;
  /**
   * MX (decision 182): a syntax table's block tag (`{% … %}`) in HTML
   * content: the whole form, and its raw body (between `open` and `close`)
   * as `value`.
   */
  onBlockTag?(data: Ranges.Value): void;
  /** MX (decision 182): a syntax table's filter in HTML content. */
  onFilter?(data: Ranges.Filter): void;
  onText?(data: Range): void;
  onPlaceholder?(data: Ranges.Placeholder): void;
  onComment?(data: Ranges.Value): void;
  onCDATA?(data: Ranges.Value): void;
  onDeclaration?(data: Ranges.Value): void;
  onDoctype?(data: Ranges.Value): void;
  onScriptlet?(data: Ranges.Scriptlet): void;
  onOpenTagStart?(data: Range): void;
  onOpenTagName?(data: Ranges.Template): TagType | void;
  onTagShorthandId?(data: Ranges.Template): void;
  onTagShorthandClass?(data: Ranges.Template): void;
  onTagTypeArgs?(data: Ranges.Value): void;
  onTagVar?(data: Ranges.Value): void;
  onTagArgs?(data: Ranges.Value): void;
  onTagTypeParams?(data: Ranges.Value): void;
  onTagParams?(data: Ranges.Value): void;
  onAttrName?(data: Range): void;
  onAttrArgs?(data: Ranges.Value): void;
  onAttrValue?(data: Ranges.AttrValue): void;
  onAttrMethod?(data: Ranges.AttrMethod): void;
  onAttrSpread?(data: Ranges.Value): void;
  onOpenTagComment?(data: Ranges.Value): void;
  onOpenTagEnd?(data: Ranges.OpenTagEnd): void;
  onCloseTagStart?(data: Range): void;
  onCloseTagName?(data: Range): void;
  onCloseTagEnd?(data: Range): void;
}
