import { createParser, TagType } from "htmljs-parser";

/**
 * htmljs-parser (through `@marko/compiler`) reports a mismatched closing tag
 * at the closer and names both tags, but never says where the opener is, so
 * an author has to hunt for the unclosed `<p>`. Marko 6.3.51's error carries
 * no second location either, so MX finds it by replaying the source.
 */
const MISMATCH =
  /(The closing "[^"\n]*" tag does not match the corresponding opening "[^"\n]*" tag)(?=\r?\n|$)/;

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

/** Tags whose body is raw text, so a `<` inside is not markup. */
const TEXT = new Set(["script", "style", "textarea", "html-comment"]);

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
  const parser = createParser({
    onOpenTagStart(range) {
      pending = { name: "", start: range.start };
    },
    onOpenTagName(range) {
      const name = parser.read(range) || "div";
      if (pending) pending.name = name;
      if (VOID.has(name)) return TagType.void;
      if (TEXT.has(name)) return TagType.text;
      return undefined;
    },
    onOpenTagEnd(range) {
      if (pending && !range.selfClosed && !VOID.has(pending.name)) {
        stack.push(pending);
      }
      pending = null;
    },
    onCloseTagEnd() {
      stack.pop();
    },
    onError(range) {
      if (range.start === closerStart && range.message === message) {
        opener = stack[stack.length - 1]?.start ?? null;
      }
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
 * Adds ` at line:column` (1-based, UTF-16 columns) of the unclosed opener to a
 * mismatched-closing-tag compile error's message, in place. Any other error,
 * or one the replay cannot reproduce, is left untouched.
 */
export function annotateCloseTagOpener(error: unknown, source: string): void {
  if (!(error instanceof Error)) return;
  const found = MISMATCH.exec(error.message);
  const loc = (error as { loc?: { start?: { line: number; column: number } } })
    .loc?.start;
  if (!found || !loc) return;
  let closerStart = 0;
  for (let line = 1; line < loc.line; line++) {
    const next = source.indexOf("\n", closerStart);
    if (next === -1) return;
    closerStart = next + 1;
  }
  closerStart += loc.column;
  const opener = findOpener(source, found[1] as string, closerStart);
  if (opener === null) return;
  const lineStart = source.lastIndexOf("\n", opener - 1) + 1;
  const line = source.slice(0, opener).split("\n").length;
  const suffix = ` at ${line}:${opener - lineStart + 1}`;
  error.message = error.message.replace(MISMATCH, `$1${suffix}`);
  // `@marko/compiler`'s `CompileError` also keeps the reason alone as `label`,
  // which the Vite plugin reports in place of the message.
  const labelled = error as { label?: unknown };
  if (typeof labelled.label === "string" && labelled.label === found[1]) {
    labelled.label += suffix;
  }
}
