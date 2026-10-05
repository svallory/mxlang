import type * as HtmljsParser from "htmljs-parser";
import { markoHtmljsParser } from "./marko-frontend.ts";

/**
 * htmljs-parser (through `@marko/compiler`) reports a mismatched closing tag
 * at the closer and names both tags, but never says where the opener is, so
 * an author has to hunt for the unclosed `<p>`. Marko 6.3.51's error carries
 * no second location either, so MX finds it by replaying the source.
 */
// With colours on (CI, FORCE_COLOR) Marko wraps the reason in escape codes that
// run to the end of the line, so allow SGR sequences between the reason and the
// line end, and keep them (group 2) when inserting the position.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";
const MISMATCH = new RegExp(
  `(The closing "[^"\\n]*" tag does not match the corresponding opening "[^"\\n]*" tag)(${SGR})(?=\\r?\\n|$)`,
);

/** HTML elements that have no closing tag, as Marko's own taglib declares them. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Marko 6.3.51's core taglib parse options, which `@marko/compiler` turns into
 * htmljs-parser tag types (data/marko `packages/compiler/src/babel-plugin/parser.js:341-352`:
 * `statement` -> `TagType.statement`, `openTagOnly` -> `void`, `text` -> `text`).
 * Without them a TypeScript generic in `export interface Input<T = string>` is
 * read as attribute type parameters and the replay dies before the closer.
 * - statement: `class.ts:13`, `export.ts:38`, `import.ts:27`, and
 *   `util/statement-tag.ts:28` (`client`, `server`, `static`)
 * - openTagOnly: `const.ts:115`, `debug.ts:61`, `id.ts:131`, `let.ts:196`,
 *   `lifecycle.ts:97`, `log.ts:70`, `return.ts:173`
 * - text: `html-comment.ts:180`, `html-script.ts:9`, `html-style.ts:9`,
 *   `script.ts:164`, `style.ts:114`; `textarea` is HTML's own text element.
 * All under `packages/runtime-tags/src/translator/core/` in data/marko.
 */
const STATEMENT = new Set([
  "class",
  "client",
  "export",
  "import",
  "server",
  "static",
]);
const OPEN_TAG_ONLY = new Set([
  "const",
  "debug",
  "id",
  "let",
  "lifecycle",
  "log",
  "return",
]);
const TEXT = new Set([
  "html-comment",
  "html-script",
  "html-style",
  "script",
  "style",
  "textarea",
]);

class Found extends Error {}

/**
 * Offset of the innermost unclosed tag's `<` at the point htmljs-parser first
 * reports `message` ending at `closerStart`, or null when the replay does not
 * reproduce that exact error (so a wrong opener is never named).
 */
function findOpener(
  source: string,
  message: string,
  closerStart: number,
): number | null {
  const stack: { name: string; start: number }[] = [];
  let pending: { name: string; start: number } | null = null;
  let opener: number | null = null;
  // The parser Marko parses with (decision 159: MX's own in core's dist).
  const { createParser, TagType } =
    markoHtmljsParser() as unknown as typeof HtmljsParser;
  const parser = createParser({
    onOpenTagStart(range) {
      pending = { name: "", start: range.start };
    },
    onOpenTagName(range) {
      // An unnamed tag (`<#a>`) reads as "": Marko's own `|| "div"` only picks
      // a taglib entry, and `div` has no parse options, so "" is a plain tag
      // in this replay too. No set below holds "", so it needs no stand-in.
      const name = parser.read(range);
      if (pending) pending.name = name;
      if (STATEMENT.has(name)) return TagType.statement;
      if (VOID.has(name) || OPEN_TAG_ONLY.has(name)) return TagType.void;
      if (TEXT.has(name)) return TagType.text;
      return undefined;
    },
    onOpenTagEnd(range) {
      if (
        pending &&
        !range.selfClosed &&
        !VOID.has(pending.name) &&
        !OPEN_TAG_ONLY.has(pending.name)
      ) {
        stack.push(pending);
      }
      pending = null;
    },
    onCloseTagEnd() {
      stack.pop();
    },
    onError(range) {
      // Marko throws on the first error, but an aggregate error can carry
      // others before this one; keep replaying past them.
      if (range.start !== closerStart || range.message !== message) return;
      opener = stack[stack.length - 1]?.start ?? null;
      throw new Found();
    },
  });
  try {
    parser.parse(source);
  } catch (error) {
    if (!(error instanceof Found)) return null;
  }
  return opener;
}

/**
 * `@marko/compiler`'s `CompileError.message` is an accessor whose setter
 * discards the first assignment (it only swaps itself for a data property), so
 * a plain `error.message = …` can silently do nothing.
 */
function setMessage(error: Error, message: string): void {
  Object.defineProperty(error, "message", {
    value: message,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

type Located = Error & {
  loc?: { start?: { line: number; column: number } };
  label?: unknown;
  errors?: unknown[];
};

/** Annotates one error; returns the ` at line:column` it added, or null. */
function annotateOne(error: Located, source: string): string | null {
  const found = MISMATCH.exec(error.message);
  const loc = error.loc?.start;
  if (!found || !loc) return null;
  let closerStart = 0;
  for (let line = 1; line < loc.line; line++) {
    const next = source.indexOf("\n", closerStart);
    if (next === -1) return null;
    closerStart = next + 1;
  }
  closerStart += loc.column;
  const opener = findOpener(source, found[1] as string, closerStart);
  if (opener === null) return null;
  const lineStart = source.lastIndexOf("\n", opener - 1) + 1;
  const line = source.slice(0, opener).split("\n").length;
  const suffix = ` at ${line}:${opener - lineStart + 1}`;
  setMessage(error, error.message.replace(MISMATCH, `$1${suffix}$2`));
  // `@marko/compiler`'s `CompileError` also keeps the reason alone as `label`,
  // which the Vite plugin reports instead of the message.
  if (typeof error.label === "string" && error.label === found[1]) {
    error.label += suffix;
  }
  return suffix;
}

/**
 * Adds ` at line:column` (1-based, UTF-16 columns) of the unclosed opener to a
 * mismatched-closing-tag compile error's message, in place. When Marko reports
 * several parse errors it throws an aggregate with no `loc` of its own, whose
 * message concatenates its `errors[]`: each entry is annotated, and the same
 * suffix is written into the aggregate message. Any other error, or one the
 * replay cannot reproduce, is left untouched.
 */
export function annotateCloseTagOpener(error: unknown, source: string): void {
  if (!(error instanceof Error)) return;
  const aggregate = error as Located;
  annotateOne(aggregate, source);
  for (const entry of aggregate.errors ?? []) {
    if (typeof (entry as Located | null)?.message !== "string") continue;
    const suffix = annotateOne(entry as Located, source);
    // An annotated line no longer matches `MISMATCH`, so this rewrites the
    // aggregate's next un-annotated mismatch line.
    if (suffix) {
      setMessage(
        aggregate,
        aggregate.message.replace(MISMATCH, `$1${suffix}$2`),
      );
    }
  }
}
