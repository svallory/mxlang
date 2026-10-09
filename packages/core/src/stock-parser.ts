import { createParser, TagType } from "@mxlang/parser/lexer";
import { STATEMENT, TEXT } from "./close-tag-opener.ts";
import { TranslateError } from "./core.ts";

/**
 * Parse-error rewrites that turn a template-parser failure into a positioned
 * MX error (sugar right after a default value, a failure inside a tag's
 * `|params|`), and the template-parser reads they and `parse-error-hints.ts`
 * share (`markoParser`, `lexedAtoms`).
 *
 * Decision 151's stock-parser diagnostics (ruling 1: `:name` after a value,
 * and the decision 156 "atoms need the MX parser" error) are gone: core parses
 * with the MX front end (port PR 5), so a stock `htmljs-parser` never parses
 * MX input. Ruling 2 (the default attribute is exempt from the after-value
 * rule) holds on the MX parser and is `sugarAfterDefaultError` below.
 */

/** The text of the two spellings of the "more than one expression" failure. */
const FOLLOWED_BY_COLON =
  /first expression is followed by the unexpected character `:`|Expected a single expression, but found `:`/;

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
 * (`name-sugar.ts` imports this name).
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

type Located = Error & {
  loc?: { start?: { line: number; column: number; index?: number } };
  label?: unknown;
  errors?: unknown[];
};

function offsetOf(source: string, line: number, column: number): number {
  let start = 0;
  for (let at = 1; at < line; at++) {
    const next = source.indexOf("\n", start);
    if (next === -1) return -1;
    start = next + 1;
  }
  return start + column;
}

/** A `:` after whitespace that the "more than one expression" failure stopped at. */
function colonFailure(
  error: unknown,
  source: string,
):
  | { offset: number; at: { line: number; column: number }; token: string }
  | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidates = [error as Located, ...((error as Located).errors ?? [])];
  for (const candidate of candidates) {
    const entry = candidate as Located | null;
    if (typeof entry?.message !== "string") continue;
    const reason =
      typeof entry.label === "string" ? entry.label : entry.message;
    if (
      !FOLLOWED_BY_COLON.test(reason) &&
      !FOLLOWED_BY_COLON.test(entry.message)
    )
      continue;
    const at = entry.loc?.start;
    if (!at) continue;
    const offset = at.index ?? offsetOf(source, at.line, at.column);
    if (offset < 0 || source[offset] !== ":") continue;
    // Only a `:` after whitespace is the sugar; `x=a ? b :` is another error.
    if (!/\s/.test(source[offset - 1] ?? "")) continue;
    const token = source.slice(offset).match(/^:[^\s/>=,]*/)?.[0] ?? ":";
    return { offset, at, token };
  }
  return undefined;
}

/**
 * Does the attribute value that holds `offset` belong to the default
 * attribute (`<if=x …>`, `<let/x=1 …>`; no name before its `=`)? Decided with
 * the template parser: a default attribute has an empty name and is exempt
 * from the after-value rule, so a `:` inside its value never starts an
 * attribute — except ` :name` after a default value that is one atom
 * (decision 146 addendum 5). `undefined` when the probe cannot run.
 */
function offsetInDefaultValue(
  source: string,
  offset: number,
): boolean | undefined {
  const parser = markoParser();
  if (!parser) return undefined;
  // `source` can be a whole file with MX regions in it (`.solid.mx`), which is
  // not a template, so parse from where the tag opens: the nearest `<` before
  // the offset, else the start of its (trimmed) line, a concise tag.
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const starts = [
    source.lastIndexOf("<", offset),
    lineStart +
      (source.slice(lineStart).length -
        source.slice(lineStart).trimStart().length),
  ].filter((at, index, all) => at >= 0 && all.indexOf(at) === index);
  for (const from of starts) {
    const slice = source.slice(from);
    const at = offset - from;
    let emptyName = false;
    let answer: boolean | undefined;
    try {
      parser
        .createParser({
          onAttrName: (name: { start: number; end: number }) => {
            emptyName = name.start === name.end;
          },
          onAttrValue: (attr: { value: { start: number; end: number } }) => {
            if (attr.value.start <= at && at < attr.value.end) {
              answer = emptyName;
            }
          },
          onError: () => {},
        })
        .parse(slice);
    } catch {
      continue;
    }
    if (answer !== undefined) return answer;
  }
  return undefined;
}

/**
 * A concise line that holds only `,` (or `<,/>`) with no tag above it: the
 * front end's `MX_TAG_NAME_MISSING`. `parseFragment` throws it, as it did
 * when Marko crashed on the nameless tag (grammar probe g1683).
 */
export const BARE_COMMA_MESSAGE =
  "a `,` continues the attributes of the tag above; there is no tag here";

export const SUGAR_AFTER_DEFAULT_MESSAGE = (token: string): string =>
  `\`${token}\` right after a default value is not supported (decision 151, ruling 2); put it before the value or on the tag (\`<input:email type="email">\`). See "the parser after-value rule" in divergences.md.`;

/**
 * The one MX error for sugar right after a default attribute's value
 * (`<if=x :b>`, `<let/x=1 :b/>`): the default attribute is exempt from the
 * after-value rule (decision 151, ruling 2), so the parse fails on the `:`.
 * Positioned at the sugar token.
 */
export function sugarAfterDefaultError(
  error: unknown,
  source: string,
): TranslateError | undefined {
  const found = colonFailure(error, source);
  if (!found || offsetInDefaultValue(source, found.offset) !== true) {
    return undefined;
  }
  return new TranslateError(
    SUGAR_AFTER_DEFAULT_MESSAGE(found.token),
    found.at.line,
    found.at.column,
  );
}

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
