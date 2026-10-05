import { TranslateError } from "./core.ts";
import { markoHtmljsParser } from "./marko-frontend.ts";

/**
 * Decision 146 PR 1 patches `htmljs-parser` (a bun `patchedDependencies`
 * entry) so that `:name` after an attribute value starts a new attribute. The
 * patch lives in this repo's install; a consumer of the published packages
 * gets a stock `htmljs-parser` through `@marko/compiler`. With a stock parser,
 * `<input type="email" :email>` reads ` :email` as the tail of the previous
 * value and Marko fails on it with a message about "exactly one expression".
 *
 * Decision 151, ruling 1: core probes the installed parser once and, when it
 * does not split, turns that failure into a positioned MX error that names the
 * rule and says what to do. (`x=a.b .c` is silently member access on a stock
 * parser, and nothing can see that per use: a known limit, documented in the
 * divergence row, not detected.)
 */

/** The text of the two spellings of Marko's "more than one expression" failure. */
const FOLLOWED_BY_COLON =
  /first expression is followed by the unexpected character `:`|Expected a single expression, but found `:`/;

type ParserModule = {
  createParser(handlers: Record<string, unknown>): {
    parse(source: string): void;
  };
};

/**
 * Does this `htmljs-parser` start a new attribute at ` :b` after `x=1`? The
 * patched parser reports two attribute names, a stock one reports one.
 */
export function parserSplitsAfterValue(parser: ParserModule): boolean {
  const names: unknown[] = [];
  parser
    .createParser({
      onAttrName: (name: unknown) => names.push(name),
      onError: () => {},
    })
    .parse("<a x=1 :b/>");
  return names.length > 1;
}

let installedSplits: boolean | undefined;
let probeFailed = false;

type MarkoParser = ParserModule & { TagType: Record<string, number> };

let markoParserModule: MarkoParser | undefined;

/**
 * The `htmljs-parser` that `@marko/compiler` parses with, the one that parses
 * MX: MX's own template parser in core's dist (decision 159), the workspace's
 * patched npm copy from source.
 */
export function markoParser(): MarkoParser | undefined {
  if (markoParserModule) return markoParserModule;
  try {
    markoParserModule = markoHtmljsParser();
  } catch {
    return undefined;
  }
  return markoParserModule;
}

/**
 * Whether the `htmljs-parser` that `@marko/compiler` resolves splits after a
 * value. Probed once per process, a failed probe included (`undefined`: nothing
 * is rewritten and the probe is not retried on every error).
 */
export function installedParserSplits(): boolean | undefined {
  if (installedSplits !== undefined) return installedSplits;
  if (probeFailed) return undefined;
  try {
    // The copy that matters is the one Marko parses with, not necessarily the
    // one core itself depends on.
    const parser = markoParser();
    if (!parser) throw new Error("no parser");
    installedSplits = parserSplitsAfterValue(parser);
  } catch {
    probeFailed = true;
    return undefined;
  }
  return installedSplits;
}

/** Test seam: forget the probe. */
export function resetInstalledParserProbe(): void {
  installedSplits = undefined;
  probeFailed = false;
  markoParserModule = undefined;
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

export const STOCK_PARSER_MESSAGE = (token: string): string =>
  `\`${token}\` after an attribute value needs the patched htmljs-parser (decision 146): this install's parser reads it as part of the previous value, so it is not a new attribute. Put the sugar on the tag instead (\`<input:email type="email">\`), or write \`name="…"\`, \`id="…"\` or \`class="…"\`. See "the parser after-value rule" in divergences.md.`;

/** A `:` after whitespace that Marko's "more than one expression" failure stopped at. */
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
 * the parser `@marko/compiler` resolves: a default attribute has an empty name
 * and is exempt from the after-value rule on every parser, so a `:` inside its
 * value never starts an attribute. `undefined` when the probe cannot run.
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

export const SUGAR_AFTER_DEFAULT_MESSAGE = (token: string): string =>
  `\`${token}\` right after a default value is not supported (decision 151, ruling 2); put it before the value or on the tag (\`<input:email type="email">\`). See "the parser after-value rule" in divergences.md.`;

/**
 * The one MX error for sugar right after a default attribute's value
 * (`<if=x :b>`, `<let/x=1 :b/>`), on any parser: the default attribute is
 * exempt from the after-value rule (decision 151, ruling 2), so Marko fails on
 * the `:` whichever htmljs-parser is installed. Positioned at the sugar token.
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
 * The positioned MX error for a stock parser's failure on ` :name` after an
 * attribute value, or `undefined` when `error` is not that failure (or the
 * installed parser does split, so the failure is something else, or the value
 * is a default attribute's, where the patched parser fails too).
 *
 * `splits` is the probe result; tests inject it. The position is Marko's own:
 * the `:` that ended the first expression.
 */
export function stockParserError(
  error: unknown,
  source: string,
  splits: boolean | undefined = installedParserSplits(),
): TranslateError | undefined {
  if (splits !== false) return undefined;
  const found = colonFailure(error, source);
  if (!found || offsetInDefaultValue(source, found.offset) === true) {
    return undefined;
  }
  return new TranslateError(
    STOCK_PARSER_MESSAGE(found.token),
    found.at.line,
    found.at.column,
  );
}

/**
 * The same two errors for a recovered parse failure: `parseFragment` asks
 * Marko for an AST, and Marko then leaves a failing attribute value in the tree
 * as a `MarkoParseError` node (label + `errorLoc`) instead of throwing, so the
 * lowerer meets it in `exprOf`. Positions on the node are already shifted into
 * the file `source` belongs to.
 */
export function parseErrorToSugarError(
  node: {
    label?: unknown;
    errorLoc?: { start?: { line: number; column: number; index?: number } };
    loc?: { start?: { line: number; column: number; index?: number } };
  },
  source: string,
  splits: boolean | undefined = installedParserSplits(),
): TranslateError | undefined {
  const label = typeof node.label === "string" ? node.label : "";
  const error = Object.assign(new Error(label), {
    label,
    loc: { start: node.errorLoc?.start ?? node.loc?.start },
  });
  return (
    sugarAfterDefaultError(error, source) ??
    stockParserError(error, source, splits)
  );
}
