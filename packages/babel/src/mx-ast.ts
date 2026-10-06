import type {
  Expression,
  FunctionParameter,
  LVal,
  SpreadElement,
  Statement,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
} from "@babel/types";

/** Half-open `[start, end)` range of UTF-16 offsets into the original file (ast §3.0, §5.1). */
export interface Span {
  start: number;
  end: number;
}

/** What every MX node carries: a `type` discriminator and a span (ast §3.0). */
export interface MxNodeBase extends Span {
  type: `Mx${string}`;
}

/** Origin of a fragment parse: file offset, zero-based line and column (ast §5.3). */
export interface MxFragmentBase {
  offset: number;
  line: number;
  column: number;
}

/** Parse shape `tagShape(name)` answers for a tag (ast §3.12). */
export type MxBodyMode =
  | "html"
  | "parsed-text"
  | "preserve"
  | "parsed-text-preserve"
  | "void";

/** The front end's per-target input mapping a tag name to its body mode (ast §3.12, §7.1). */
export type MxTagShape = (name: string) => MxBodyMode;

/** The six statement keywords of the language; a target supplies a subset (ast §3.10). */
export type MxStatementKeyword =
  | "import"
  | "export"
  | "static"
  | "server"
  | "client"
  | "class";

/** The two inputs the front end takes from outside the source text (ast §7.1). */
export interface MxFrontEndOptions {
  statementKeywords: ReadonlySet<MxStatementKeyword>;
  tagShape: MxTagShape;
}

/**
 * Code of an `MxParseError` (ast §3.13): the 31 template-parser codes by name,
 * Babel reason codes, and the front end's `MX_*` rules. Lowering's own codes
 * are not members: they are not `MxParseError`s.
 */
export type MxErrorCode =
  | "EXTRA_CLOSING_TAG"
  | "INVALID_ATTRIBUTE_ARGUMENT"
  | "INVALID_ATTRIBUTE_NAME"
  | "INVALID_ATTRIBUTE_VALUE"
  | "INVALID_CHARACTER"
  | "INVALID_CODE_AFTER_SEMICOLON"
  | "INVALID_EXPRESSION"
  | "INVALID_INDENTATION"
  | "INVALID_LINE_START"
  | "INVALID_REGULAR_EXPRESSION"
  | "INVALID_STRING"
  | "INVALID_TAG_ARGUMENT"
  | "INVALID_TAG_SHORTHAND"
  | "INVALID_TEMPLATE_STRING"
  | "MALFORMED_CDATA"
  | "MALFORMED_CLOSE_TAG"
  | "MALFORMED_COMMENT"
  | "MALFORMED_DECLARATION"
  | "MALFORMED_DOCUMENT_TYPE"
  | "MALFORMED_OPEN_TAG"
  | "MALFORMED_PLACEHOLDER"
  | "MISMATCHED_CLOSING_TAG"
  | "MISSING_END_TAG"
  | "MISSING_TAG_VARIABLE"
  | "RESERVED_TAG_NAME"
  | "ROOT_TAG_ONLY"
  | "INVALID_TAG_PARAMS"
  | "INVALID_TAG_TYPES"
  | "INVALID_ATTR_TYPE_PARAMS"
  | "AMBIGUOUS_ATTRIBUTE_VALUE"
  | "INVALID_HTML_COMMENT"
  // Open by design: Babel's reason codes are not enumerated here, and closing
  // the list needs a decision.
  | `BABEL_${string}`
  | "MX_SECOND_NAME"
  | "MX_COLON_BEFORE_DYNAMIC"
  | "MX_SUGAR_NAME_MISSING"
  | "MX_SUGAR_NAME_INVALID"
  | "MX_SHORTHAND_INVALID"
  | "MX_SUGAR_DYNAMIC"
  | "MX_SUGAR_ARGUMENTS"
  | "MX_SUGAR_BOUND"
  | "MX_SUGAR_ON_STATEMENT"
  | "MX_STATEMENT_IN_HTML_MODE"
  | "MX_RESERVED_TAG_NAME"
  | "MX_ATTRIBUTE_TAG_AT_ROOT"
  | "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE";

/** `:name` atom found in an expression's source (ast §4.3). */
export interface MxAtom extends Span {
  type: "MxAtom";
  name: string;
}

/** A parse error recorded as data; `start`/`end` are what to underline (ast §3.13). */
export interface MxParseError extends MxNodeBase {
  type: "MxParseError";
  code: MxErrorCode;
  origin: "template" | "expression" | "front-end";
  message: string;
  context: Span | null;
}

/** Container for embedded TypeScript, generic over the Babel payload (ast §4.1). */
export interface MxExpressionContainer<N> extends Span {
  source: string;
  outer: Span;
  node: N | null;
  error: MxParseError | null;
  atoms: MxAtom[];
}

/** Expression container (ast §4.1). */
export type MxExpression = MxExpressionContainer<Expression> & { type: "MxExpression" };
/** Statements container: module statements, scriptlets, method bodies (ast §3.10, §4.1). */
export type MxStatements = MxExpressionContainer<Statement[]> & { type: "MxStatements" };
/** Binding pattern container, the tag variable (ast §3.4, §4.1). */
export type MxPattern = MxExpressionContainer<LVal> & { type: "MxPattern" };
/** Arguments container, on a tag or an attribute (ast §3.4, §4.1). */
export type MxArguments = MxExpressionContainer<(Expression | SpreadElement)[]> & {
  type: "MxArguments";
};
/** Parameter list container, tag `|params|` or method `(params)` (ast §3.4, §4.1). */
export type MxParameterList = MxExpressionContainer<FunctionParameter[]> & {
  type: "MxParameterList";
};
/** Type arguments container, `<Tag<T>>` (ast §3.4, §4.1). */
export type MxTypeArguments = MxExpressionContainer<TSTypeParameterInstantiation> & {
  type: "MxTypeArguments";
};
/** Type parameters container, `<T>` before params (ast §3.4, §4.1). */
export type MxTypeParameters = MxExpressionContainer<TSTypeParameterDeclaration> & {
  type: "MxTypeParameters";
};

/** The written closing tag, a field shape of `MxTag` (ast §3.2). */
export interface MxCloseTag {
  span: Span;
  name: string | null;
  nameSpan: Span | null;
}

/** Name of an `MxTag`, a field shape (ast §3.3). */
export type MxTagName =
  | { kind: "static"; value: string; span: Span }
  | { kind: "dynamic"; expression: MxExpression; span: Span }
  | { kind: "unnamed"; span: Span };

/** Value of an `MxShorthand`, a field shape (ast §3.6). */
export type MxShorthandValue =
  | { kind: "static"; value: string; span: Span }
  | {
      kind: "dynamic";
      template: MxExpression;
      quasis: Span[];
      expressions: MxExpression[];
      span: Span;
    };

/** Method shorthand `name(params) { body }` as an attribute value (ast §3.5a). */
export interface MxMethod extends MxNodeBase {
  type: "MxMethod";
  async: boolean;
  typeParams: MxTypeParameters | null;
  params: MxParameterList;
  body: MxStatements;
  source: string;
}

/** `#id`, `.class` or `:name` sugar in tag or attribute position (ast §3.6). */
export interface MxShorthand extends MxNodeBase {
  type: "MxShorthand";
  sigil: "#" | "." | ":";
  position: "tag" | "attribute";
  value: MxShorthandValue;
  operator: "=" | ":=" | null;
  default: MxExpression | MxMethod | null;
}

/** One named attribute, or the tag's default value when `name` is null (ast §3.5). */
export interface MxAttribute extends MxNodeBase {
  type: "MxAttribute";
  name: string | null;
  nameSpan: Span;
  operator: "=" | ":=" | null;
  value: MxExpression | MxMethod | null;
  args: MxArguments | null;
}

/** `...expr` in the attribute list (ast §3.5b). */
export interface MxSpreadAttribute extends MxNodeBase {
  type: "MxSpreadAttribute";
  value: MxExpression;
}

/** Comment, in a child list or among a tag's attributes (ast §3.11). */
export interface MxComment extends MxNodeBase {
  type: "MxComment";
  kind: "html" | "line" | "block";
  value: string;
  valueSpan: Span;
}

/** `<![CDATA[ … ]]>` (ast §3.11). */
export interface MxCDATA extends MxNodeBase {
  type: "MxCDATA";
  value: string;
  valueSpan: Span;
}

/** `<!doctype …>` (ast §3.11). */
export interface MxDoctype extends MxNodeBase {
  type: "MxDoctype";
  value: string;
  valueSpan: Span;
}

/** `<?xml …?>` (ast §3.11). */
export interface MxDeclaration extends MxNodeBase {
  type: "MxDeclaration";
  value: string;
  valueSpan: Span;
}

/** Text run, normalized by the body mode's rule (ast §3.8). */
export interface MxText extends MxNodeBase {
  type: "MxText";
  value: string;
  raw: string;
  valueSpan: Span;
}

/** `${expr}` / `$!{expr}` (ast §3.9). */
export interface MxPlaceholder extends MxNodeBase {
  type: "MxPlaceholder";
  escape: boolean;
  expression: MxExpression;
}

/** A statement keyword line at the top level (ast §3.10). */
export interface MxModuleStatement extends MxNodeBase {
  type: "MxModuleStatement";
  keyword: MxStatementKeyword;
  code: MxStatements;
}

/** `$ stmt` and `$ { block }` (ast §3.10). */
export interface MxScriptlet extends MxNodeBase {
  type: "MxScriptlet";
  block: boolean;
  code: MxStatements;
}

/** Fields shared by `MxTag`, `MxAttributeTag` and `MxReturn` (ast §3.2, §3.7, §3.14). */
interface MxTagFields {
  typeArgs: MxTypeArguments | null;
  var: MxPattern | null;
  args: MxArguments | null;
  typeParams: MxTypeParameters | null;
  params: MxParameterList | null;
  shorthands: MxShorthand[];
  attributes: (MxAttribute | MxShorthand | MxSpreadAttribute | MxComment)[];
  body: MxChild[] | null;
  bodyMode: MxBodyMode;
  selfClosed: boolean;
  concise: boolean;
  openTag: Span;
  closeTag: MxCloseTag | null;
  incomplete: boolean;
}

/** An element, component call, structural tag, custom tag or dynamic tag (ast §3.2). */
export interface MxTag extends MxNodeBase, MxTagFields {
  type: "MxTag";
  name: MxTagName;
}

/** `<@name>`: a property of the nearest enclosing tag (ast §3.7). */
export interface MxAttributeTag extends MxNodeBase, MxTagFields {
  type: "MxAttributeTag";
  name: { value: string; span: Span };
}

/** `<return=x/>` (ast §3.14). */
export interface MxReturn extends MxNodeBase, MxTagFields {
  type: "MxReturn";
  name: MxTagName;
}

/** Root of a parse (ast §3.1). */
export interface MxDocument extends MxNodeBase {
  type: "MxDocument";
  body: MxChild[];
  errors: MxParseError[];
  complete: boolean;
  source: string;
  base: MxFragmentBase;
}

/** Nodes that appear in a child list (ast §3.0). */
export type MxChild =
  | MxTag
  | MxAttributeTag
  | MxReturn
  | MxText
  | MxPlaceholder
  | MxScriptlet
  | MxComment
  | MxCDATA
  | MxDoctype
  | MxDeclaration
  | MxModuleStatement;

/** Every MX node (ast §3.0). */
export type MxNode =
  | MxDocument
  | MxChild
  | MxAttribute
  | MxShorthand
  | MxSpreadAttribute
  | MxMethod
  | MxParseError
  | MxAtom
  | MxExpression
  | MxStatements
  | MxPattern
  | MxArguments
  | MxParameterList
  | MxTypeArguments
  | MxTypeParameters;
