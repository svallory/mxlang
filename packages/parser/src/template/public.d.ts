/**
 * Public types of `@mxlang/parser/lexer` as seen by other packages (the
 * `types` condition of the `./lexer` export): the template lexer's event API,
 * `createParser` and `TagType`.
 *
 * Consumers typecheck against this rather than against `index.ts`, because the
 * template sources are written for the parser package's own compiler flags
 * and fail under stricter ones (`noUncheckedIndexedAccess`): `@mxlang/core`
 * lexes with it on its error paths, and its declaration build must not pull
 * the sources into its program. `public-types.test.ts` pins this file to the
 * source.
 */

export interface Range {
  start: number;
  end: number;
}

export declare namespace Ranges {
  interface Value extends Range {
    value: Range;
  }
  interface Template extends Range {
    expressions: Value[];
    quasis: Range[];
  }
  interface Error extends Range {
    code: number;
    message: string;
  }
  interface Scriptlet extends Value {
    block: boolean;
  }
  interface Placeholder extends Value {
    escape: boolean;
  }
  interface AttrValue extends Value {
    bound: boolean;
  }
  interface AttrMethod extends Range {
    body: Value;
    params: Value;
    typeParams: Value | undefined;
    async: boolean;
  }
  interface OpenTagEnd extends Range {
    selfClosed: boolean;
  }
  interface Filter extends Value {
    name: Range;
  }
  interface Trigger extends Range {
    id: string;
    position: "expression" | "attribute" | "line";
    standIn: "number" | "identifier" | "keep";
    text: Range;
    value?: Range;
    /** What the parser's `claim` answered for this trigger, when one was given. */
    claim?: unknown;
  }
}

/** How the lexer reads a tag's body: html 0, text 1, void 2, statement 3. */
export type TagType = 0 | 1 | 2 | 3;

export declare const TagType: {
  readonly html: 0;
  readonly text: 1;
  readonly void: 2;
  readonly statement: 3;
};

/** The lexer's events, one optional handler each. */
export interface Handlers {
  onError?(data: Ranges.Error): void;
  onAtom?(data: Ranges.Value): void;
  onTrigger?(data: Ranges.Trigger): void;
  onBlockTag?(data: Ranges.Value): void;
  onFilter?(data: Ranges.Filter): void;
  onText?(data: Range): void;
  onPlaceholder?(data: Ranges.Placeholder): void;
  onComment?(data: Ranges.Value): void;
  onCDATA?(data: Ranges.Value): void;
  onDeclaration?(data: Ranges.Value): void;
  onDoctype?(data: Ranges.Value): void;
  onScriptlet?(data: Ranges.Scriptlet): void;
  onOpenTagStart?(data: Range): void;
  onOpenTagName?(data: Ranges.Template): TagType | undefined;
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

/** Where a parsed substring sits in its document (`parse`'s second argument). */
export interface ParseOptions {
  startOffset?: number;
  startLine?: number;
  startColumn?: number;
}

/** The lexer `createParser` returns. */
export interface Lexer {
  parse(code: string, options?: ParseOptions): void;
  read(range: Range): string;
  offsetAt(offset: number): number;
}

/**
 * A template lexer calling `handlers` (decision 182: `options.syntax` is the
 * syntax table, a plain object validated at run time; omitted means the
 * default row).
 */
export declare function createParser(
  handlers: Handlers,
  options?: { syntax?: object; claim?: TriggerClaim },
): Lexer;

/**
 * Asked once per matched attribute or line trigger start: `undefined`
 * declines (the text lexes as if no row matched); anything else claims and
 * is carried on the trigger's event as `claim`.
 */
export type TriggerClaim = (
  id: string,
  position: "attribute" | "line",
  start: number,
  end: number,
) => unknown;
