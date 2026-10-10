/**
 * The MX front end as the compiler's parse (port PR 5, decision 158):
 * `compileSource` and `parseFragment` parse through `@mxlang/parser`'s front
 * end and hand `lower()` the `MxDocument` body.
 *
 * Three pieces of `@marko/compiler`'s `compileSync` survive here, so the
 * switch changes no output and no diagnostic (decision 166 addendum 1 item 4,
 * the PR 5 ruling "keep today's text byte for byte"):
 *
 * - the parse inputs: the front end's `tagShape` and statement keywords are
 *   read from the same taglib lookup Marko parsed with;
 * - the parse error: Marko threw a `CompileError` (one) or `CompileErrors`
 *   (several) with a code frame, built from each `MarkoParseError`'s label
 *   and location; `compileErrorOf` builds the same object from the
 *   document's `MxParseError`s, so the rewrites after it (`hintParseError`,
 *   `tagParamError`, `sugarAfterDefaultError`) read what they always read;
 * - `stripTypes`: Marko's build output erased TypeScript from every
 *   expression before translating; `stripMxTypes` runs the same Babel
 *   plugin over the document's payloads.
 *
 * Types are `Node` (untyped) at this module's boundary: the published
 * `.d.ts` may not name `@mxlang/babel` (slice-6 addendum of decision 158).
 */
import { relative } from "node:path";
import { parse as mxFrontEndParse } from "@mxlang/parser/frontend";
import { strippedMethodTypeParams } from "./attr-fields.ts";
import { coreBabel } from "./babel.ts";
import { type Node, TranslateError } from "./core.ts";
import type { SyntaxTable } from "./syntax-table.ts";
import type { TagTable } from "./tag-table.ts";

/** The six statement keywords of the language (decision 168). */
const STATEMENT_KEYWORDS = [
  "import",
  "export",
  "static",
  "server",
  "client",
  "class",
] as const;

/** Body modes of the front end's `tagShape` (ast §3.12). */
type BodyMode =
  | "html"
  | "parsed-text"
  | "preserve"
  | "parsed-text-preserve"
  | "void";

/** Where a fragment sits in its file (ast §5.3). */
export interface MxBase {
  offset: number;
  line: number;
  column: number;
}

/** For tests: how many front-end parses have run in this process (one per compile). */
export const mxParses = { count: 0 };

/**
 * Parses `source` with the MX front end, the tag shapes and statement
 * keywords read from `lookup` (the lookup Marko would have parsed with).
 * Returns the `MxDocument`; parse errors are in its `errors`, never thrown.
 */
export function parseMx(
  source: string,
  options: { syntax: SyntaxTable; lookup: TagTable | undefined; base?: MxBase },
): Node {
  const { lookup } = options;
  const parseOptionsOf = (name: string): Node =>
    lookup?.getTag(name)?.parseOptions;
  const tagShape = (name: string): BodyMode => {
    const parse = parseOptionsOf(name);
    if (!parse) return "html";
    if (parse.openTagOnly) return "void";
    if (parse.text)
      return parse.preserveWhitespace ? "parsed-text-preserve" : "parsed-text";
    return parse.preserveWhitespace ? "preserve" : "html";
  };
  const statementKeywords = new Set(
    STATEMENT_KEYWORDS.filter((name) => parseOptionsOf(name)?.statement),
  );
  mxParses.count++;
  return mxFrontEndParse(source, {
    statementKeywords,
    tagShape,
    syntax: options.syntax,
    ...(options.base ? { base: options.base } : {}),
  });
}

/** 1-based line, 0-based column of a fragment-local `offset` in `source`. */
function positionAt(
  source: string,
  offset: number,
): { line: number; column: number; index: number } {
  let line = 1;
  let lineStart = 0;
  for (
    let at = source.indexOf("\n");
    at !== -1 && at < offset;
    at = source.indexOf("\n", at + 1)
  ) {
    line++;
    lineStart = at + 1;
  }
  return { line, column: offset - lineStart, index: offset };
}

/**
 * Front-end rules ported from `@marko/compiler`'s own parser (ast §3.13):
 * Marko threw each as one `CompileError` at the node the moment it parsed
 * it (`file.buildCodeFrameError`). The other `MX_*` rules were lowering's.
 */
const MARKO_PARSER_RULES: ReadonlySet<string> = new Set([
  "MX_ATTRIBUTE_TAG_AT_ROOT",
  "MX_RESERVED_TAG_NAME",
  "MX_STATEMENT_IN_HTML_MODE",
]);

/**
 * The error `@marko/compiler` threw for the document's parse errors, or
 * `undefined`. Marko's parse threw at the first template error (a
 * `CompileErrors` aggregate of the expression errors before it and the
 * template error) or at the first rule its parser checks (one
 * `CompileError`), whichever came first; expression errors alone were thrown
 * after the parse only by a compile (`expressionErrors`), as an aggregate,
 * and left in the tree by a parse-only fragment. `source` and the error
 * offsets are the fragment's own (the document's offsets less `base`), as
 * Marko parsed a fragment without knowing its base.
 */
export function compileErrorOf(
  document: Node,
  filename: string,
  options: { expressionErrors: boolean },
): Error | undefined {
  // A module statement's code is checked by lowering (`rejectInvalidStatement`,
  // with MX's own wording), as Marko left a statement tag's text unparsed:
  // its container's error is not a parse error here.
  const statementErrors = new Set<Node>();
  for (const child of document.body ?? []) {
    if (child.type === "MxModuleStatement" && child.code?.error) {
      statementErrors.add(child.code.error);
    }
  }
  const all: Node[] = document.errors ?? [];
  const parse = all.filter(
    (error) => error.origin !== "front-end" && !statementErrors.has(error),
  );
  const direct = [
    ...all.filter(
      (error) =>
        error.origin === "front-end" && MARKO_PARSER_RULES.has(error.code),
    ),
    ...shorthandIdErrors(document.body ?? []),
  ].sort((a, b) => detectedAt(a) - detectedAt(b))[0];
  const template = parse.findIndex((error) => error.origin === "template");
  const templateError = template < 0 ? undefined : parse[template];
  let thrown: Node[];
  if (
    direct &&
    (!templateError || detectedAt(direct) < detectedAt(templateError))
  ) {
    thrown = [direct];
  } else if (templateError) {
    thrown = parse.slice(0, template + 1);
  } else if (options.expressionErrors && parse.length > 0) {
    thrown = parse;
  } else {
    return undefined;
  }
  const source: string = document.source;
  const baseOffset: number = document.base?.offset ?? 0;
  const built = thrown.map((error) => {
    const start = positionAt(source, error.start - baseOffset);
    // Marko's point error shares one object between `start` and `end`.
    const loc =
      error.end === error.start
        ? { start, end: start }
        : { start, end: positionAt(source, error.end - baseOffset) };
    return compileError(filename, source, loc, error.message);
  });
  return built.length === 1 ? built[0] : compileErrors(built);
}

/**
 * Which came first in Marko's parse: a rule its parser checks fires at the
 * tag's name, or at the end of the open tag (`detectedAt` on the error), a
 * template error where the parser finds it, and a missing end tag (reported
 * at the tag) only at the end of input.
 */
function detectedAt(error: Node): number {
  if (error.code === "MISSING_END_TAG") return Number.POSITIVE_INFINITY;
  return error.detectedAt ?? error.start;
}

/**
 * Marko's `onOpenTagEnd` rule (`@marko/compiler` 5.42.10 `chunk-src.js`
 * 6168): a tag-head `#id` beside an authored attribute named `id` throws
 * "Cannot have shorthand id and id attribute." at that attribute (the first
 * one), when the open tag ends. The MX front end keeps both (ast §6.1a), so
 * the error is built here, as Marko's parser rule it is. An attribute-position
 * `#x` is not an `id` attribute to Marko (its name is `#x`), so it does not
 * count.
 */
function shorthandIdErrors(body: readonly Node[]): Node[] {
  const errors: Node[] = [];
  const visit = (children: readonly Node[]): void => {
    for (const child of children) {
      if (
        child?.type !== "MxTag" &&
        child?.type !== "MxAttributeTag" &&
        child?.type !== "MxReturn"
      ) {
        continue;
      }
      const headId = (child.shorthands ?? []).some(
        (shorthand: Node) =>
          shorthand.sigil === "#" && shorthand.position !== "attribute",
      );
      const id = headId
        ? (child.attributes ?? []).find(
            (attr: Node) => attr.type === "MxAttribute" && attr.name === "id",
          )
        : undefined;
      if (id) {
        errors.push({
          start: id.start,
          end: id.end,
          detectedAt: child.openTag?.end ?? id.end,
          message: "Cannot have shorthand id and id attribute.",
        });
      }
      if (child.body) visit(child.body);
    }
  };
  visit(body);
  return errors;
}

/**
 * Whether lowering raises `error` (a front-end `MX_*` rule Marko's tree had
 * lowering raise), not Marko's parser.
 *
 * One exception keeps today's text and position (lead ruling, PR 5): the
 * front end reports `MX_SUGAR_BOUND` on every tag-adjacent `:=` (`<div:=1/>`),
 * but today's sugar check (`checkNearSugar`) fired only on a bindable value
 * (an `Identifier` or a `MemberExpression`); any other value reached Marko's
 * own binding check instead. Such an error is skipped here, so lowering
 * raises that check ("Attributes may only be bound to identifiers or member
 * expressions", at the value) or accepts the value (`a?.b`), as today.
 */
function isLoweringError(document: Node, error: Node): boolean {
  if (error.origin !== "front-end" || MARKO_PARSER_RULES.has(error.code)) {
    return false;
  }
  if (error.code !== "MX_SUGAR_BOUND") return true;
  const bound = defaultBindAt(document.body ?? [], error.start);
  if (!bound) return true;
  const type = bound.value?.node?.type;
  return type === "Identifier" || type === "MemberExpression";
}

/** The tag-adjacent `:=` (an unnamed bound `MxAttribute`) starting at `offset`. */
function defaultBindAt(
  body: readonly Node[],
  offset: number,
): Node | undefined {
  for (const child of body) {
    for (const attr of child?.attributes ?? []) {
      if (
        attr.type === "MxAttribute" &&
        attr.name === null &&
        attr.operator === ":=" &&
        attr.start === offset
      ) {
        return attr;
      }
    }
    if (Array.isArray(child?.body)) {
      const found = defaultBindAt(child.body, offset);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The first of the document's front-end errors (ast §3.13: the `MX_*` rules,
 * name sugar the token level already refuses) as the `TranslateError`
 * lowering raised for it on Marko's tree, at the same position (ruling of
 * decision 158 PR 4 slice 4: same text, same offset). `undefined` when there
 * is none. Positions are the file's: the document's base is applied.
 */
export function frontEndErrorOf(document: Node): TranslateError | undefined {
  const error = (document.errors ?? []).find(
    (each: Node) =>
      each.code !== INPUT_ENDS_IN_DELIMITER && isLoweringError(document, each),
  );
  if (!error) return undefined;
  // A bare `,` line: the front end places the error where the unnamed tag's
  // name would start, just past the `,`; Marko's path reported it at the `,`
  // itself.
  const base = document.base?.offset ?? 0;
  const at =
    error.code === "MX_TAG_NAME_MISSING"
      ? base + document.source.lastIndexOf(",", error.start - base)
      : error.start;
  const { line, column } = filePosition(document, at);
  return new TranslateError(error.message, line, column);
}

/** Documents with front-end errors, by each body array lowering may be handed. */
const pendingDocuments = new WeakMap<object, Node>();

/**
 * Remembers `document` for lowering when it has front-end errors: those were
 * raised by lowering on Marko's tree, so lowering raises them on the MX path
 * too (`pendingFrontEndError`), whichever body of the document a caller hands
 * it (a host may lower a wrapper tag's body, as angular does).
 */
export function registerDocument(document: Node): void {
  if (
    !(document.errors ?? []).some((e: Node) => isLoweringError(document, e))
  ) {
    return;
  }
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (Array.isArray(value.body)) {
      pendingDocuments.set(value.body, document);
      visit(value.body);
    }
  };
  visit(document);
}

/** The front-end error lowering raises for `body`, if its document had one. */
export function pendingFrontEndError(
  body: readonly unknown[],
): TranslateError | undefined {
  const document = pendingDocuments.get(body);
  return document ? frontEndErrorOf(document) : undefined;
}

/**
 * `MX_INPUT_ENDS_IN_DELIMITER` (decision 161): input that ends inside a
 * concise open delimiter, where Marko's parser was silent. Lowering raises it
 * last (`endOfInputError`), so whatever main reported for such input (a
 * lowering error on the cut tag, `Tag does not support arguments.`) still
 * wins, and it fires only where nothing else would.
 */
const INPUT_ENDS_IN_DELIMITER = "MX_INPUT_ENDS_IN_DELIMITER";

/** `body`'s document's `MX_INPUT_ENDS_IN_DELIMITER`, positioned in the file. */
export function endOfInputError(
  body: readonly unknown[],
): TranslateError | undefined {
  const document = pendingDocuments.get(body);
  const error = (document?.errors ?? []).find(
    (each: Node) => each.code === INPUT_ENDS_IN_DELIMITER,
  );
  if (!error) return undefined;
  const { line, column } = filePosition(document, error.start);
  return new TranslateError(error.message, line, column);
}

/** 1-based line, 0-based column of a document offset, in file coordinates. */
export function filePosition(
  document: Node,
  offset: number,
): { line: number; column: number } {
  const base = document.base ?? { offset: 0, line: 0, column: 0 };
  const local = positionAt(document.source, offset - base.offset);
  return {
    line: local.line + base.line,
    column: local.line === 1 ? local.column + base.column : local.column,
  };
}

// --- `@marko/compiler` 5.42.10 `src/util/build-code-frame.js` and
// `src/util/merge-errors.js`, ported verbatim (same text, same fields).

const INDENT = "    ";
const MAX_FRAME_COLUMNS = 160;
const LINES_ABOVE = 2;
const LINES_BELOW = 3;
const ELLIPSIS = "…";
const NEWLINE = /\r\n|[\n\r\u2028\u2029]/;
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Marko's own ANSI pattern
  /([\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g;

interface Loc {
  start: { line: number; column: number; index?: number };
  end: { line: number; column: number; index?: number };
}

function buildMessage(code: string, loc: Loc, message: string): string {
  const { line } = loc.start;
  const lines = code.split(NEWLINE);
  const first = Math.max(line - LINES_ABOVE - 1, 0);
  let framed = lines.slice(first, line + LINES_BELOW);
  let start = loc.start.column;
  let end = loc.end && loc.end.line === line ? loc.end.column : start;
  if (framed.some((text) => text.length > MAX_FRAME_COLUMNS)) {
    const lead = Math.max((MAX_FRAME_COLUMNS - (end - start)) >> 1, 20);
    const from = Math.max(
      0,
      Math.min(
        start - lead,
        (lines[line - 1] || "").length - MAX_FRAME_COLUMNS,
      ),
    );
    const to = from + MAX_FRAME_COLUMNS;
    const shift = from ? 1 : 0;
    framed = framed.map(
      (text) =>
        (from && text ? ELLIPSIS : "") +
        text.slice(from, to) +
        (text.length > to ? ELLIPSIS : ""),
    );
    end = Math.max(Math.min(end, to), start) + shift - from;
    start += shift - from;
  }
  return coreBabel().codeFrameColumns(
    framed.join("\n"),
    { start: { line, column: start + 1 }, end: { line, column: end + 1 } },
    {
      highlightCode: true,
      message,
      linesAbove: LINES_ABOVE,
      linesBelow: LINES_BELOW,
      startLine: first + 1,
    },
  );
}

// `kleur/colors` 4.1.5 as `@marko/compiler` used it: whether colours are on
// (read once, at load), and its `cyan`/`yellow` wrappers.
const COLOR = (() => {
  if (typeof process === "undefined") return true;
  const { FORCE_COLOR, NODE_DISABLE_COLORS, NO_COLOR, TERM } =
    process.env ?? {};
  return (
    !NODE_DISABLE_COLORS &&
    NO_COLOR == null &&
    TERM !== "dumb" &&
    ((FORCE_COLOR != null && FORCE_COLOR !== "0") ||
      Boolean(process.stdout?.isTTY))
  );
})();

function sgr(open: number, close: number): (text: string | number) => string {
  const closer = `\u001b[${close}m`;
  const opener = `\u001b[${open}m`;
  return (text) => {
    if (!COLOR) return String(text);
    const value = String(text);
    return (
      opener +
      (value.includes(closer)
        ? value.replaceAll(closer, closer + opener)
        : value) +
      closer
    );
  };
}

const cyan = sgr(36, 39);
const yellow = sgr(33, 39);

/**
 * `@marko/compiler/modules`' `cwd`, read once at load (file names in a frame
 * are relative to it): `"/"` when a DOM global exists or `BUNDLE` is set
 * (Marko's browser mode), else `process.cwd()` when the process has one.
 */
const CWD = (() => {
  if (
    (typeof process !== "undefined" && process.env?.BUNDLE) ||
    typeof (globalThis as { document?: unknown }).document === "object"
  ) {
    return "/";
  }
  try {
    return typeof process?.cwd === "function" ? process.cwd() : "/";
  } catch {
    return "/";
  }
})();

function buildFileName(filename: string, loc: Loc): string {
  return `${cyan(relative(CWD, filename))}:${yellow(loc.start.line)}:${yellow(loc.start.column + 1)}`;
}

function noop(): void {}

/**
 * Marko's two error classes, by name: a caller (and a test) reads
 * `constructor.name`, which Marko's `class CompileError extends Error` sets.
 * The fields, message and stack are set by `compileError`/`compileErrors`.
 */
class CompileError extends Error {}
class CompileErrors extends Error {}

/** Marko's `CompileError` for a located label. */
function compileError(
  filename: string,
  code: string,
  loc: Loc,
  label: string,
): Error {
  const prettyMessage = buildMessage(code, loc, label);
  const prettyFileName = buildFileName(filename, loc);
  const message = `\n${INDENT}at ${prettyFileName}\n${prettyMessage.replace(/^/gm, INDENT)}`;
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new CompileError(message);
  Error.stackTraceLimit = stackTraceLimit;
  error.name = "CompileError";
  // The stack Marko's aggregate reads: its header only (no frames at limit 0).
  error.stack = `CompileError: ${message}`;
  Object.defineProperties(error, {
    filename: {
      value: filename,
      enumerable: false,
      writable: true,
      configurable: true,
    },
    loc: { value: loc, enumerable: false, writable: true, configurable: true },
    label: {
      value: label,
      enumerable: false,
      writable: true,
      configurable: true,
    },
    frame: {
      value: prettyMessage,
      enumerable: false,
      writable: true,
      configurable: true,
    },
    code: { enumerable: false, configurable: true, get: noop, set: noop },
    // Marko's `message` is an accessor whose setter swallows the value once
    // and leaves a plain writable property: `compileSync` threw it through
    // Babel's transform wrapper, which assigns `message` (a filename prefix,
    // swallowed). The error a caller caught is that settled one, so a later
    // assignment (the vite plugin's `locate`) takes.
    message: {
      value: message,
      enumerable: true,
      writable: true,
      configurable: true,
    },
    toJSON: {
      value(this: Error) {
        return this.toString();
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    toString: {
      value(this: Error) {
        return `${this.name}: ${this.message.replace(ANSI, "")}`;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
  });
  return error;
}

const COMPILE_ERROR_PREFIX = "CompileError: \n";
const COMPILE_ERROR_STACK_PREFIX = `${COMPILE_ERROR_PREFIX}${INDENT}at `;

/** Marko's `CompileErrors` aggregate. */
function compileErrors(errors: Error[]): Error {
  const message = `\n${errors
    .map(({ stack = "" }) =>
      stack.startsWith(COMPILE_ERROR_STACK_PREFIX)
        ? stack.slice(COMPILE_ERROR_PREFIX.length)
        : stack.replace(/^(?!\s*$)/gm, INDENT),
    )
    .join("\n\n")}`;
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new CompileErrors(message) as Error & { errors: Error[] };
  Error.stackTraceLimit = stackTraceLimit;
  error.name = "CompileErrors";
  error.errors = errors;
  Object.defineProperty(error, "filename", {
    value: (errors[0] as Node).filename,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

// --- `stripTypes` (`@marko/compiler` 5.42.10 `src/babel-plugin/index.js`):
// Marko's build output (`output: "html"`) erased TypeScript before
// translating, with Babel's `transform-typescript` plugin and its own
// `stripTagTypesVisitor`. Lowering slices authored text by node span, so
// the strip shows in the output only where it replaces a node (`x as T` is
// `x`, a `type` statement is gone), but there it does: the MX path strips
// the same way. The document never leaves `compileSource`, so its payloads
// are replaced in place, as Marko's were.

/** The TS plugin's options, Marko's. */
const STRIP_OPTIONS = {
  isTSX: false,
  allowNamespaces: true,
  allowDeclareFields: true,
  optimizeConstEnums: true,
  onlyRemoveTypeImports: true,
  disallowAmbiguousJSXLike: false,
};

let stripVisitor: Node | undefined;

/** The TS plugin's visitor, built once (Marko caches it the same way). */
function typeScriptVisitor(): Node {
  if (stripVisitor) return stripVisitor;
  const babel = coreBabel();
  const api = {
    version: "7.29.0",
    types: babel.types,
    assertVersion() {},
    assumption() {
      return undefined;
    },
    targets() {
      return {};
    },
    addExternalDependency() {},
    cache: { using() {}, never() {}, forever() {} },
    env() {
      return "production";
    },
    caller() {
      return undefined;
    },
  };
  stripVisitor = babel.pluginTransformTypeScript(api, STRIP_OPTIONS).visitor;
  return stripVisitor;
}

/** Runs the TS plugin over `body` as one program; returns the program's body after it. */
function stripProgram(body: Node[]): Node[] {
  const babel = coreBabel();
  const t = babel.types;
  const program = t.program(body, [], "module");
  const file = new babel.File(
    { filename: "mx-strip.ts" },
    { code: "", ast: t.file(program) },
  );
  const path = file.path;
  path.state = { file };
  babel.traverse(
    path.node,
    babel.traverse.visitors.explode({ ...typeScriptVisitor() }),
    path.scope,
    path.state,
    path,
    true,
  );
  // Marko drops the empty `export {}` the plugin adds to a module.
  return path.node.body.filter(
    (statement: Node) =>
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration ||
      statement.specifiers.length > 0 ||
      statement.source,
  );
}

/**
 * Each `import` module statement's Babel `ImportDeclaration`, as the front end
 * parsed it, copied just before `stripMxTypes` runs. The strip is Marko's
 * `transform-typescript` (`onlyRemoveTypeImports`): it deletes a whole
 * `import type` and every `{ type X }` specifier from the payload in place,
 * and a consumer reading what was imported (`Import.declaration`) needs
 * exactly what the author wrote, type-only marks included. Keyed on the
 * `MxModuleStatement`; absent when the document was never stripped (the
 * payload is then the parsed declaration itself).
 */
export const parsedImportDeclarations = new WeakMap<object, Node>();

/**
 * Whether an `import` statement's payload holds something the strip cannot
 * take: a TypeScript `import x = …` (Babel's strip refuses `= require()` with
 * CommonJS advice that does not apply to MX, and leaves `import x = M.N`
 * in place) or a Flow `import typeof`. Such a payload is left unstripped, so
 * lowering refuses it at the statement (`refuseUnsupportedImport`).
 */
function leavesImportUnstripped(statement: Node): boolean {
  const body = statement.code?.node;
  if (!Array.isArray(body)) return false;
  return body.some(
    (node: Node) =>
      node?.type === "TSImportEqualsDeclaration" ||
      (node?.type === "ImportDeclaration" && isTypeofImport(node)),
  );
}

/** Flow's `import typeof T from "m"` / `import { typeof T } from "m"`. */
export function isTypeofImport(declaration: Node): boolean {
  return (
    declaration.importKind === "typeof" ||
    (declaration.specifiers ?? []).some((s: Node) => s.importKind === "typeof")
  );
}

function recordImportDeclaration(statement: Node): void {
  if (statement.keyword !== "import") return;
  const body = statement.code?.node;
  if (!Array.isArray(body) || body.length !== 1) return;
  if (body[0]?.type !== "ImportDeclaration") return;
  parsedImportDeclarations.set(
    statement,
    coreBabel().types.cloneNode(body[0], true),
  );
}

const TYPE_CONTAINERS = new Set(["MxTypeArguments", "MxTypeParameters"]);

/** Strips TypeScript from every payload of `document`, as Marko's `stripTypes` did. */
export function stripMxTypes(document: Node): void {
  const t = coreBabel().types;
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.type === "string" && value.type.startsWith("Mx")) {
      if (value.type === "MxModuleStatement") {
        recordImportDeclaration(value);
        if (value.keyword === "import" && leavesImportUnstripped(value)) return;
      }
      for (const [key, field] of Object.entries(value) as [string, Node][]) {
        if (
          field &&
          typeof field === "object" &&
          TYPE_CONTAINERS.has(field.type)
        ) {
          // `stripTagTypesVisitor`: a tag's (and a body's) type arguments
          // and parameters are dropped whole.
          if (value.type === "MxMethod") strippedMethodTypeParams.add(value);
          value[key] = null;
          continue;
        }
        if (
          field &&
          typeof field === "object" &&
          "node" in field &&
          "outer" in field
        ) {
          stripContainer(field, t);
        }
        visit(field);
      }
    }
  };
  visit(document.body);
}

function stripContainer(container: Node, t: Node): void {
  const node = container.node;
  if (node == null) return;
  switch (container.type) {
    case "MxExpression": {
      const [statement] = stripProgram([t.expressionStatement(node)]);
      container.node = statement?.expression ?? node;
      return;
    }
    case "MxStatements":
      container.node = stripProgram([...node]);
      return;
    case "MxPattern": {
      const [declaration] = stripProgram([
        t.variableDeclaration("let", [t.variableDeclarator(node)]),
      ]);
      container.node = declaration?.declarations?.[0]?.id ?? node;
      return;
    }
    case "MxArguments": {
      const [statement] = stripProgram([
        t.expressionStatement(t.callExpression(t.identifier("f"), [...node])),
      ]);
      container.node = statement?.expression?.arguments ?? node;
      return;
    }
    case "MxParameterList": {
      const [declaration] = stripProgram([
        t.functionDeclaration(
          t.identifier("f"),
          [...node],
          t.blockStatement([]),
        ),
      ]);
      container.node = declaration?.params ?? node;
      return;
    }
  }
}
