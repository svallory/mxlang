import { createParser, TagType } from "@mxlang/parser/lexer";
import { STATEMENT, TEXT } from "./close-tag-opener.ts";
import { TranslateError } from "./core.ts";

/**
 * The parse-error rewrite that turns a template-parser failure inside a tag's
 * `|params|` into a positioned MX error, and the template-parser reads it and
 * `parse-error-hints.ts` share (`markoParser`, `lexedAtoms`).
 *
 * A `:` after a value (`<if=x :b>`) is Marko's own "Expected a single
 * expression" failure, reported as Marko reports it: MX has no `:name` sugar
 * to point at.
 */

/**
 * The slice of MX's template lexer (`@mxlang/parser/lexer`) these replays
 * call, declared here so no emitted `.d.ts` names the private parser package.
 */
type TemplateLexer = {
  createParser(handlers: Record<string, unknown>): {
    parse(source: string): void;
  };
  TagType: { readonly text: number; readonly statement: number };
};

const templateLexer: TemplateLexer = { createParser, TagType } as TemplateLexer;

/**
 * The template lexer these rewrites and `parse-error-hints.ts` replay the
 * source with: MX's own (`@mxlang/parser/lexer`), on every run. Always
 * defined; the `undefined` arm is kept for the callers' fallbacks.
 *
 * TODO(pr6): rename to `templateLexer` once move-sugars a1 merges
 * (`shorthand.ts` imports this name).
 */
export function markoParser(): TemplateLexer | undefined {
  return templateLexer;
}

let lexedFor: { source: string; atoms: { start: number; end: number }[] } = {
  source: "",
  atoms: [],
};

/**
 * The atoms MX's template lexer lexes in `source` (decision 156), for a
 * diagnostic that must name only a real atom: never a `:` in a scriptlet, a
 * statement tag or a ternary. `undefined` when the parser cannot be loaded.
 * Remembers the last source, since one failure may ask more than once.
 */
export function lexedAtoms(
  source: string,
): { start: number; end: number }[] | undefined {
  if (lexedFor.source === source) return lexedFor.atoms;
  const parser = markoParser();
  if (!parser) return undefined;
  const atoms: { start: number; end: number }[] = [];
  try {
    const instance = parser.createParser({
      // Statement and text tags as Marko's taglib types them, so a `static`
      // line or a `<script>` body is never read as attributes.
      onOpenTagName: (range: { start: number; end: number }) => {
        const name = source.slice(range.start, range.end);
        if (STATEMENT.has(name)) return parser.TagType.statement;
        if (TEXT.has(name)) return parser.TagType.text;
        return undefined;
      },
      onAtom: (atom: { start: number; end: number }) =>
        atoms.push({ start: atom.start, end: atom.end }),
      onError: () => {},
    });
    instance.parse(source);
  } catch {
    // A parse that throws still reported the atoms before it.
  }
  lexedFor = { source, atoms };
  return atoms;
}

/**
 * A concise line that holds only `,` (or `<,/>`) with no tag above it: the
 * front end's `MX_TAG_NAME_MISSING`. `parseFragment` throws it, as it did
 * when Marko crashed on the nameless tag (grammar probe g1683).
 */
export const BARE_COMMA_MESSAGE =
  "a `,` continues the attributes of the tag above; there is no tag here";

/**
 * The text Babel gave a failure inside a tag's `|params|`: Marko builds its
 * `CompileError` with an empty first line, the `at file:line:col` line and a
 * code frame, so the reason sits on the frame's caret line.
 */
const CARET_LINE = /^\s*\|\s*\^+\s*(\S.*)$/m;

/**
 * The positioned MX error for a parse failure inside a tag's `|params|`
 * (`<define/Foo|{a=}|>`, `<for|{a=}| of=x>`): Marko throws its own
 * `CompileError`, whose `line`/`column` are 0 and whose `message` opens with an
 * empty line. The error is rewritten to a `TranslateError` at Marko's own
 * position, with the reason Babel gave. `undefined` unless `error` carries a
 * `loc` that falls inside a params list and a reason on its caret line, so no
 * other failure is rewritten.
 */
export function tagParamError(
  error: unknown,
  source: string,
): TranslateError | undefined {
  const at = (
    error as { loc?: { start?: { line?: unknown; column?: unknown } } } | null
  )?.loc?.start;
  const message = (error as { message?: unknown } | null)?.message;
  if (
    !(error instanceof Error) ||
    typeof at?.line !== "number" ||
    typeof at.column !== "number" ||
    typeof message !== "string"
  ) {
    return undefined;
  }
  // Marko colours its code frame when the terminal allows it (CI does), so
  // the caret line is matched with the escape sequences removed.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  const plain = message.replace(/\u001b\[[0-9;]*m/g, "");
  const reason = CARET_LINE.exec(plain)?.[1];
  const parser = markoParser();
  if (!reason || !parser) return undefined;
  const lineStart = source.split("\n").slice(0, at.line - 1);
  const offset =
    lineStart.reduce((sum, line) => sum + line.length + 1, 0) + at.column;
  let inParams = false;
  try {
    parser
      .createParser({
        onTagParams: (range: { start: number; end: number }) => {
          if (offset >= range.start && offset < range.end) inParams = true;
        },
        onError: () => {},
      })
      .parse(source);
  } catch {
    // A parse that throws still reported the params before it.
  }
  return inParams ? new TranslateError(reason, at.line, at.column) : undefined;
}
