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
 * §5.3) — there is no post-hoc shift walk. Expression triggers
 * are parsed from their same-length stand-in, and the payload marks each
 * with `extra.mxTrigger` (`markTriggers`).
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
import { type StandIn, standInText } from "../template/syntax.ts";

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

/** An expression trigger of the container's source, local to the container's text. */
export interface SubParseTrigger {
  readonly start: number;
  readonly end: number;
  readonly id: string;
  readonly standIn: StandIn;
  /** The authored text (the payload holds the stand-in). */
  readonly text: string;
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
  MxTemplateLiteral: { code: (t) => `\`${t}\``, offset: 1 },
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

/** What one Babel run hands back: the container's node and, for statements, the program's extras. */
interface BabelRun {
  readonly node: unknown;
  readonly directives?: readonly unknown[];
  readonly innerComments?: readonly unknown[];
  /** The errors a recovering run collected instead of throwing. */
  readonly errors: readonly BabelError[];
  /** The tree to search for stand-ins (the file, for statements). */
  readonly root: unknown;
}

interface BabelError {
  reasonCode: string;
  message: string;
  pos: number;
  loc: { line: number; column: number; index?: number };
}

function runBabel(
  code: string,
  options: ParserOptions,
  statements: boolean,
): BabelRun {
  let node: unknown;
  let root: unknown;
  let directives: readonly unknown[] | undefined;
  let innerComments: readonly unknown[] | undefined;
  let errors: readonly BabelError[];
  if (statements) {
    const file = babelParse(code, options) as unknown as {
      program: {
        body: unknown;
        directives?: readonly unknown[];
        innerComments?: readonly unknown[];
      };
      errors?: readonly BabelError[];
    };
    node = file.program.body;
    root = file;
    directives = file.program.directives;
    innerComments = file.program.innerComments;
    errors = file.errors ?? [];
  } else {
    node = parseExpression(code, options);
    root = node;
    errors = (node as { errors?: readonly BabelError[] }).errors ?? [];
  }
  // The fork's result carries the parse's own `comments`/`errors` on the
  // root; today's tree carries neither on a payload, so neither does ours.
  const payload = node as { comments?: unknown; errors?: unknown };
  delete payload.comments;
  delete payload.errors;
  return { node, directives, innerComments, errors, root };
}

/**
 * The checks Babel makes on the shape of what a stand-in stands for, by
 * reason code. `StrictDelete` (`delete <identifier>`) is about an identifier
 * stand-in. An identifier is always assignable, so the other three, about an
 * assignment, update, `for-in`/`for-of` or destructuring target that is not
 * assignable, can be about a number stand-in only.
 */
const DELETE_CODE = "StrictDelete";
const TARGET_CODES: ReadonlySet<string> = new Set([
  "InvalidLhs",
  "InvalidParenthesizedAssignment",
  "InvalidRestAssignmentPattern",
]);

/** The file-absolute `start:end` of each stand-in the payload holds, with its shape. */
type StandInSpans = ReadonlyMap<string, "identifier" | "number">;

function standInSpans(
  triggers: readonly SubParseTrigger[],
  fileOffset: number,
): StandInSpans {
  const spans = new Map<string, "identifier" | "number">();
  for (const trigger of triggers) {
    if (trigger.standIn === "keep") continue;
    spans.set(
      `${trigger.start + fileOffset}:${trigger.end + fileOffset}`,
      trigger.standIn,
    );
  }
  return spans;
}

/** Whether a first error is one a stand-in's shape could have raised, given the shapes this container holds. */
function isStandInSensitive(error: unknown, spans: StandInSpans): boolean {
  const code = (error as { reasonCode?: unknown } | null)?.reasonCode;
  if (typeof code !== "string") return false;
  if (code === DELETE_CODE) return spans.size > 0;
  return TARGET_CODES.has(code) && [...spans.values()].includes("number");
}

// biome-ignore lint/suspicious/noExplicitAny: Babel nodes, generically
type AnyNode = any;

/** Every node of the tree (comments and `extra` aside). */
function nodesOf(root: unknown): AnyNode[] {
  const nodes: AnyNode[] = [];
  const seen = new Set<unknown>();
  const visit = (value: AnyNode): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.type === "string") nodes.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "extra") continue;
      visit(child);
    }
  };
  visit(root);
  return nodes;
}

/** The nodes an `ancestor` of this type checks as assignment targets, a default or a rest unwrapped to the target it holds. */
function targetsOf(ancestor: AnyNode): AnyNode[] {
  const slots: AnyNode[] =
    ancestor.type === "ArrayPattern"
      ? ancestor.elements
      : ancestor.type === "ObjectPattern"
        ? ancestor.properties.map((property: AnyNode) =>
            property.type === "ObjectProperty" ? property.value : property,
          )
        : [ancestor.left];
  return slots.flatMap((slot) => {
    let node = slot;
    while (node?.type === "RestElement" || node?.type === "AssignmentPattern")
      node = node.type === "RestElement" ? node.argument : node.left;
    return node ? [node] : [];
  });
}

/**
 * Whether Babel's error is about a stand-in node itself and nothing else.
 * Babel reports an error at the start of the node it rejects, and an
 * ancestor (`#1++ = 3`, `(#1 = 1) = 2`) starts where its stand-in does, so a
 * position alone is not enough: the rejected node is identified and must be
 * the stand-in, by span.
 *
 * - `StrictDelete`: the `delete` that starts at the error has a stand-in as
 *   its operand (Babel unwraps parentheses).
 * - `InvalidLhs`: its `ancestor` names the node whose slot (`left`,
 *   `argument`) Babel rejected, or only the kind of node (a pattern, a
 *   `for-in`/`for-of` head), whose target starting at the error is the one.
 * - `InvalidParenthesizedAssignment`: every parenthesized node starting at the
 *   error is a stand-in.
 * - `InvalidRestAssignmentPattern`: every rest argument starting at the error
 *   is a stand-in.
 */
function isAboutStandIn(
  error: { reasonCode: string; pos: number; details?: unknown },
  nodes: readonly AnyNode[],
  spans: StandInSpans,
): boolean {
  const isStandIn = (node: AnyNode, shape: "identifier" | "number") =>
    node?.type === (shape === "number" ? "NumericLiteral" : "Identifier") &&
    spans.get(`${node.start}:${node.end}`) === shape;
  const allStandIns = (found: readonly AnyNode[]) =>
    found.length > 0 && found.every((node) => isStandIn(node, "number"));
  switch (error.reasonCode) {
    case DELETE_CODE: {
      const deletes = nodes.filter(
        (node) =>
          node.type === "UnaryExpression" &&
          node.operator === "delete" &&
          node.start === error.pos,
      );
      return (
        deletes.length > 0 &&
        deletes.every((node) => isStandIn(node.argument, "identifier"))
      );
    }
    case "InvalidLhs": {
      const ancestor = (error.details as { ancestor?: AnyNode } | undefined)
        ?.ancestor;
      switch (ancestor?.type) {
        case "AssignmentExpression":
        case "AssignmentPattern":
          return isStandIn(ancestor.left, "number");
        case "UpdateExpression":
          return isStandIn(ancestor.argument, "number");
        case "ArrayPattern":
        case "ObjectPattern":
        case "ForInStatement":
        case "ForOfStatement":
          return allStandIns(
            nodes
              .filter((node) => node.type === ancestor.type)
              .flatMap(targetsOf)
              .filter((node) => node.start === error.pos),
          );
        default:
          return false;
      }
    }
    case "InvalidParenthesizedAssignment":
      return allStandIns(
        nodes.filter(
          (node) => node.extra?.parenthesized && node.start === error.pos,
        ),
      );
    case "InvalidRestAssignmentPattern":
      return allStandIns(
        nodes
          .filter(
            (node) =>
              node.type === "RestElement" && node.argument.start === error.pos,
          )
          .map((node) => node.argument),
      );
    default:
      return false;
  }
}

/**
 * Reparses a container that failed with a check on a stand-in's shape,
 * letting Babel collect its recoverable errors. An error is dropped only when
 * it is about a stand-in node itself. If the first error was not dropped, the
 * first parse's own error is thrown, byte for byte; otherwise the first one
 * left. A run with nothing left is the container's tree. A fatal error of the
 * reparse is thrown as is.
 */
function recoverPastStandIns(
  code: string,
  options: ParserOptions,
  statements: boolean,
  spans: StandInSpans,
  first: unknown,
): BabelRun {
  const run = runBabel(code, { ...options, errorRecovery: true }, statements);
  if (run.errors.length === 0) return run;
  const nodes = nodesOf(run.root);
  const index = run.errors.findIndex(
    (error) => !isAboutStandIn(error, nodes, spans),
  );
  if (index === 0) throw first;
  if (index > 0) throw run.errors[index];
  return run;
}

/**
 * Parses one container. `text` is the authored slice, `at` the position of
 * its first character and `end` the file-absolute end of the slice;
 * `triggers` its expression triggers, local spans in source
 * order.
 */
export function subParse(
  kind: ContainerKind,
  text: string,
  at: SubParseAt,
  end: number,
  triggers: readonly SubParseTrigger[] = [],
): SubParseResult {
  // The sub-parser sees the same-length stand-ins, exactly as the template
  // parser's read() hands them to Babel; the payload marks the triggers.
  let parsed = "";
  let last = 0;
  for (const trigger of triggers) {
    parsed +=
      text.slice(last, trigger.start) +
      standInText(trigger.standIn, text.slice(trigger.start, trigger.end));
    last = trigger.end;
  }
  parsed += text.slice(last);
  const wrapper = WRAPPERS[kind];
  const code = wrapper.code(parsed);
  const options = parserOptions(at, wrapper.offset);
  let node: unknown;
  let directives: readonly unknown[] | undefined;
  let innerComments: readonly unknown[] | undefined;
  try {
    let run: BabelRun;
    try {
      run = runBabel(code, options, wrapper.statements === true);
    } catch (first) {
      // A stand-in is shaped like an identifier or a number, so Babel's own
      // checks on that shape (`delete <identifier>`, an assignment to a
      // number) can fire for text the dialect lowers to something else.
      // Only a failed parse with triggers and only those checks retry.
      const spans = standInSpans(triggers, at.offset);
      if (!isStandInSensitive(first, spans)) throw first;
      run = recoverPastStandIns(
        code,
        options,
        wrapper.statements === true,
        spans,
        first,
      );
    }
    node = run.node;
    directives = run.directives;
    innerComments = run.innerComments;
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
  if (triggers.length > 0) markTriggers(node, triggers, at.offset);
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
 * Marks one payload node per trigger with `extra.mxTrigger`:
 * its id, span and authored text (the node holds the stand-in, `_status`).
 * Several nodes can share the span (`x() { &a }`: the statement and the
 * identifier; `{ &a }`: the property, its key and its value); the mark goes
 * to the deepest, and among equals the last visited, which is the operand
 * itself (the shorthand's value, not its key). Nothing is converted;
 * lowering (`lowerTrigger`, core) decides what the trigger builds. A
 * `"keep"` trigger's text may parse as no single node; then none is marked.
 */
function markTriggers(
  // biome-ignore lint/suspicious/noExplicitAny: walks Babel nodes generically
  node: any,
  triggers: readonly SubParseTrigger[],
  fileOffset: number,
): void {
  const spans = new Map(
    triggers.map((trigger) => [trigger.start + fileOffset, trigger] as const),
  );
  // biome-ignore lint/suspicious/noExplicitAny: Babel nodes, generically
  const best = new Map<SubParseTrigger, { node: any; depth: number }>();
  const seen = new Set<unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: walks Babel nodes generically
  const visit = (value: any, depth: number): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth);
      return;
    }
    if (typeof value.type !== "string") return;
    const start = value.start ?? value.loc?.start?.index;
    const end = value.end ?? value.loc?.end?.index;
    const trigger = spans.get(start);
    if (trigger && end === trigger.end + fileOffset) {
      const found = best.get(trigger);
      if (!found || depth >= found.depth)
        best.set(trigger, { node: value, depth });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "extra") continue;
      visit(child, depth + 1);
    }
  };
  visit(node, 0);
  for (const [trigger, { node: marked }] of best) {
    const start = trigger.start + fileOffset;
    marked.extra = {
      ...marked.extra,
      mxTrigger: {
        id: trigger.id,
        span: { sourceStart: start, sourceEnd: trigger.end + fileOffset },
        text: trigger.text,
      },
    };
  }
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
  triggers: readonly SubParseTrigger[] = [],
): string {
  const trimmed = text.trim();
  const inner = trimmed.slice(1, -1);
  // The inside starts after the leading whitespace and the `{`. Its
  // triggers are stood in as for the whole value: the template parser's
  // `read()` hands the inside with the same stand-ins.
  const from = text.length - text.trimStart().length + 1;
  const inside = <T extends { start: number; end: number }>(
    items: readonly T[],
  ): T[] =>
    items
      .filter((item) => item.start >= from && item.end <= from + inner.length)
      .map((item) => ({
        ...item,
        start: item.start - from,
        end: item.end - from,
      }));
  const result = subParse("MxExpression", inner, at, end, inside(triggers));
  return result.error === null
    ? " Attribute values are plain TypeScript expressions, not JSX; remove the wrapping `{ }`."
    : "";
}
