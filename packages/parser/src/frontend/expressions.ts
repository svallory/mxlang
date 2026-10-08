/**
 * The expression sub-parser of the MX front end (ast §4.1, §7.1): MX's Babel
 * fork (`@mxlang/babel`), configured exactly as `@marko/compiler` configures
 * its bundled Babel today (`manipulateOptions`, the flags and plugins of ast
 * §7.1's table row), with the same wrapper per position and the same
 * compensation of the wrapper's prefix that Marko's `sourceOffset` performs
 * (`parseParams`, `parseArgs`, `parseVar`, `parseTypeArgs`, `parseTypeParams`,
 * `parseStatements`, all of `@marko/compiler`'s `babel-utils/parse`).
 *
 * Positions are file-absolute at creation: the sub-parse receives the
 * container's offset, line and column, so every payload node's `start`, `end`
 * and `loc` (with `index`) already addresses the original file (ast §4.1,
 * §5.3) — there is no post-hoc shift walk. Atoms are parsed from a numeric
 * stand-in of the same length (the template parser's rule, decision 156) and
 * the payload carries each as a `StringLiteral` with `extra.mxAtom`, the
 * shape `core/src/atoms.ts` produces today (ast §4.3).
 *
 * A failure is data (ast §3.13 item 2): `node` is null and the error's
 * message and position are today's, byte for byte, with the position bounded
 * to the container's range as Marko's `getBoundedRange` bounds it.
 */

import type {
  Expression,
  FunctionParameter,
  LVal,
  SpreadElement,
  Statement,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
} from "@babel/types";
import {
  parse as babelParse,
  type ParserOptions,
  parseExpression,
} from "@mxlang/babel";
import type { MxParseError, Span } from "@mxlang/babel/mx-ast";

/** The seven container types of ast §4.1, plus the template-literal wrapper of a dynamic name or shorthand value (Marko's `parseTemplateLiteral`). */
export type ContainerKind =
  | "MxExpression"
  | "MxStatements"
  | "MxPattern"
  | "MxArguments"
  | "MxParameterList"
  | "MxTypeArguments"
  | "MxTypeParameters"
  | "MxTemplateLiteral";

/** What each container's payload is (ast §4.1). */
export type ContainerPayload<C extends ContainerKind> = C extends "MxExpression"
  ? Expression
  : C extends "MxStatements"
    ? Statement[]
    : C extends "MxPattern"
      ? LVal
      : C extends "MxArguments"
        ? (Expression | SpreadElement)[]
        : C extends "MxParameterList"
          ? FunctionParameter[]
          : C extends "MxTypeArguments"
            ? TSTypeParameterInstantiation
            : TSTypeParameterDeclaration;

/** An atom of the container's source, local to the container's text. */
export interface SubParseAtom {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** Where the container sits in the file: absolute offset, 1-based line, 0-based column of its first character. */
export interface SubParseAt {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SubParseResult {
  readonly node: unknown;
  readonly error: MxParseError | null;
  /** A statements sub-parse's block `directives` and `innerComments` (ast §4.1, A22). */
  readonly directives?: readonly unknown[];
  readonly innerComments?: readonly unknown[];
}

/** Marko's fixed parser options for a sub-parse (ast §7.1), with the position of this container. */
function parserOptions(at: SubParseAt, wrapper: number): ParserOptions {
  return {
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: true,
    createImportExpressions: true,
    plugins: [
      "objectRestSpread",
      "classProperties",
      ["typescript", { disallowAmbiguousJSXLike: false, dts: false }],
    ],
    startIndex: at.offset - wrapper,
    startLine: at.line,
    startColumn: at.column - wrapper,
  };
}

/**
 * The wrapper of each position (Marko's `parse.js`): the prefix that makes
 * the slice one expression, and how many characters of it precede the
 * authored text (`sourceOffset`).
 */
const WRAPPERS: Record<
  ContainerKind,
  {
    readonly code: (text: string) => string;
    readonly offset: number;
    readonly statements?: boolean;
  }
> = {
  MxExpression: { code: (t) => t, offset: 0 },
  MxStatements: { code: (t) => t, offset: 0, statements: true },
  MxPattern: { code: (t) => `(${t}\n)=>{}`, offset: 1 },
  MxArguments: { code: (t) => `_(${t})`, offset: 2 },
  MxParameterList: { code: (t) => `(${t})=>{}`, offset: 1 },
  MxTypeArguments: { code: (t) => `_<${t}>`, offset: 2 },
  MxTypeParameters: { code: (t) => `<${t}>()=>{}`, offset: 1 },
  MxTemplateLiteral: { code: (t) => "`" + t + "`", offset: 1 },
};

/** Marko's `getParseErrorLabel`: two reason codes get their own sentence; every other message loses its `(line:column)` tail. */
function labelOf(
  error: { reasonCode: string; message: string; pos: number },
  code: string,
  startIndex: number,
): string {
  switch (error.reasonCode) {
    case "ParseExpressionEmptyInput":
      return "Expected an expression, but found only whitespace or comments.";
    case "ParseExpressionExpectsEOF":
      return `Expected a single expression, but found \`${String.fromCodePoint(code.codePointAt(error.pos - startIndex) ?? 0)}\` after it.`;
    default:
      return error.message.replace(/ *\(\d+:\d+\)$/, "");
  }
}

/** Marko's `getBoundedRange`: the error's point when it lies in the container, the whole container otherwise. */
function boundedSpan(
  loc: { line: number; column: number; index?: number },
  at: SubParseAt,
  end: number,
): Span {
  const index = loc.index;
  if (typeof index !== "number") return { start: at.offset, end };
  return index >= at.offset && index <= end
    ? { start: index, end: index }
    : { start: at.offset, end };
}

/** The atom stand-in of `:name`: `0.` plus one zero per extra character, the same length as the authored `:name` (the template parser's `standInAtoms`). */
export function atomStandIn(name: string): string {
  return `0.${"0".repeat(Math.max(name.length - 1, 0))}`;
}

/**
 * Parses one container. `text` is the authored slice, `atoms` its atoms with
 * local spans, `at` the position of its first character and `end` the
 * file-absolute end of the slice.
 */
export function subParse(
  kind: ContainerKind,
  text: string,
  atoms: readonly SubParseAtom[],
  at: SubParseAt,
  end: number,
): SubParseResult {
  // The sub-parser sees the numeric stand-ins, exactly as the template
  // parser's read() hands them to Babel today; the payload converts back.
  let parsed = "";
  let last = 0;
  for (const atom of atoms) {
    parsed += text.slice(last, atom.start) + atomStandIn(atom.name);
    last = atom.end;
  }
  parsed += text.slice(last);
  const wrapper = WRAPPERS[kind];
  const code = wrapper.code(parsed);
  const options = parserOptions(at, wrapper.offset);
  let node: unknown;
  let directives: readonly unknown[] | undefined;
  let innerComments: readonly unknown[] | undefined;
  try {
    if (wrapper.statements) {
      const program = babelParse(code, options).program as {
        body: unknown;
        directives?: readonly unknown[];
        innerComments?: readonly unknown[];
      };
      node = program.body;
      directives = program.directives;
      innerComments = program.innerComments;
    } else node = parseExpression(code, options);
    // The fork's result carries the parse's own `comments`/`errors` on the
    // root; today's tree carries neither on a payload, so neither does ours.
    const root = node as { comments?: unknown; errors?: unknown };
    delete root.comments;
    delete root.errors;
  } catch (error) {
    const babel = error as {
      reasonCode: string;
      message: string;
      pos: number;
      loc: { line: number; column: number; index?: number };
    };
    let label = labelOf(babel, code, at.offset - wrapper.offset);
    if (kind === "MxPattern" && /function parameter list/.test(label)) {
      // Marko's `parseVar` rewrite, byte for byte (the text it embeds is the
      // stand-in slice, as today).
      label = `\`${parsed}\` is not a valid [tag variable](https://markojs.com/docs/reference/language#tag-variables); use a JavaScript identifier or destructuring pattern.`;
    }
    return {
      node: null,
      error: errorOf(`BABEL_${babel.reasonCode}`, label, babel.loc, at, end),
    };
  }
  // Unwrap the wrapper: today's each-position extraction, and its
  // `ensureParseError` when the parse succeeded but the wrapper's shape did
  // not hold.
  // biome-ignore lint/suspicious/noExplicitAny: the wrapper extractions read Babel nodes generically
  const anyNode = node as any;
  const wrongShape = (): SubParseResult => ({
    node: null,
    error: errorOf(
      "BABEL_UNEXPECTED_NODE",
      `Unexpected node of type ${anyNode?.type} returned while parsing.`,
      undefined,
      at,
      end,
    ),
  });
  switch (kind) {
    case "MxExpression":
    case "MxStatements":
      break;
    case "MxTemplateLiteral": {
      // Marko's `parseTemplateLiteral`: a rebuilt `TemplateLiteral`, the
      // parsed quasis and expressions as its children, the wrapper's own
      // positions not carried (today's node carries none either).
      if (anyNode?.type === "TemplateLiteral")
        node = {
          type: "TemplateLiteral",
          quasis: anyNode.quasis,
          expressions: anyNode.expressions,
        };
      else return wrongShape();
      break;
    }
    case "MxPattern": {
      const params = anyNode?.params;
      if (anyNode?.type === "ArrowFunctionExpression" && params?.length === 1)
        node = params[0];
      else return wrongShape();
      break;
    }
    case "MxArguments":
      if (anyNode?.type === "CallExpression") node = anyNode.arguments;
      else return wrongShape();
      break;
    case "MxParameterList":
      if (anyNode?.type === "ArrowFunctionExpression") node = anyNode.params;
      else return wrongShape();
      break;
    case "MxTypeArguments":
      if (anyNode?.type === "TSInstantiationExpression")
        node = anyNode.typeParameters;
      else return wrongShape();
      break;
    case "MxTypeParameters":
      if (anyNode?.type === "ArrowFunctionExpression")
        node = anyNode.typeParameters;
      else return wrongShape();
      break;
  }
  if (atoms.length > 0) convertStandIns(node, atoms, at.offset);
  return { node, error: null, directives, innerComments };
}

/** Marko's `parseTemplateString` case 0: a static name's whole text as a `StringLiteral` over the quasi (withLoc'd). */
export function staticTemplateString(
  text: string,
  at: SubParseAt,
  end: number,
): SubParseResult {
  return {
    node: {
      type: "StringLiteral",
      value: text,
      start: at.offset,
      end,
      loc: {
        start: { line: at.line, column: at.column, index: at.offset },
        end: null,
      },
    },
    error: null,
  };
}

/** Marko's `templateElement` helper: `tail` also rides inside `value`, as `types.templateElement` builds it today. */
export function templateElement(raw: string): Record<string, unknown> {
  return {
    type: "TemplateElement",
    value: { raw, cooked: raw, tail: true },
  };
}

/** Marko's `withLoc(templateLiteral([templateElement(v, true)], []))`: a `${'str'}` name. */
export function stringQuasiTemplate(
  value: string,
  at: SubParseAt,
  end: number,
): SubParseResult {
  return {
    node: {
      type: "TemplateLiteral",
      quasis: [templateElement(value)],
      expressions: [],
      start: at.offset,
      end,
      loc: {
        start: { line: at.line, column: at.column, index: at.offset },
        end: null,
      },
    },
    error: null,
  };
}

function errorOf(
  code: string,
  message: string,
  loc: { line: number; column: number; index?: number } | undefined,
  at: SubParseAt,
  end: number,
): MxParseError {
  const span = loc ? boundedSpan(loc, at, end) : { start: at.offset, end };
  return {
    type: "MxParseError",
    ...span,
    code: code as MxParseError["code"],
    origin: "expression",
    message,
    context: { start: at.offset, end },
  };
}

/**
 * Converts every atom stand-in of a parsed payload into its public shape
 * (decision 156 addendum 1): a `StringLiteral` whose `value` is the name and
 * whose `extra.mxAtom` carries the atom's span, at the stand-in's own
 * offsets. The same mutation `core/src/atoms.ts` (`convertAtoms`) performs
 * on today's tree, done here before the payload is ever attached.
 */
function convertStandIns(
  // biome-ignore lint/suspicious/noExplicitAny: walks and rewrites Babel nodes generically
  node: any,
  atoms: readonly SubParseAtom[],
  fileOffset: number,
): void {
  const spans = new Map(
    atoms.map((atom) => [atom.start + fileOffset, atom] as const),
  );
  const seen = new Set<unknown>();
  const visit = (value: any): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.type !== "string") return;
    const start = value.start ?? value.loc?.start?.index;
    const end = value.end ?? value.loc?.end?.index;
    if (value.type === "NumericLiteral") {
      const atom = spans.get(start);
      if (atom && end === atom.end + fileOffset) {
        value.type = "StringLiteral";
        value.value = atom.name;
        value.extra = {
          raw: JSON.stringify(atom.name),
          rawValue: atom.name,
          mxAtom: {
            span: { sourceStart: start, sourceEnd: end },
          },
        };
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "extra") continue;
      visit(child);
    }
  };
  visit(node);
}

/**
 * Marko's `withWrappedAttrValueHint` (ast §3.13 item 2): an attribute value
 * written `{ … }` that parses once the braces are removed gets the hint
 * appended to its error. The MX rewording is the lead's ruling of
 * 2026-10-08 (brief §1.2.5); the period rule stays Marko's.
 */
export function wrappedAttrValueHint(
  text: string,
  at: SubParseAt,
  end: number,
): string {
  const trimmed = text.trim();
  const inner = trimmed.slice(1, -1);
  const result = subParse("MxExpression", inner, [], at, end);
  return result.error === null
    ? " Attribute values in MX are plain TypeScript expressions, not JSX; remove the wrapping `{ }`."
    : "";
}
