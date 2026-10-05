import { createRequire } from "node:module";
import { TranslateError } from "./core.ts";

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

/**
 * Whether the `htmljs-parser` that `@marko/compiler` resolves splits after a
 * value. Probed once per process; `undefined` when the probe itself fails, in
 * which case nothing is rewritten.
 */
export function installedParserSplits(): boolean | undefined {
  if (installedSplits !== undefined) return installedSplits;
  try {
    const here = createRequire(import.meta.url);
    // The copy that matters is the one Marko parses with, not necessarily the
    // one core itself depends on.
    const marko = createRequire(here.resolve("@marko/compiler"));
    installedSplits = parserSplitsAfterValue(
      marko("htmljs-parser") as ParserModule,
    );
  } catch {
    return undefined;
  }
  return installedSplits;
}

/** Test seam: forget the probe. */
export function resetInstalledParserProbe(): void {
  installedSplits = undefined;
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

/**
 * The positioned MX error for a stock parser's failure on ` :name` after an
 * attribute value, or `undefined` when `error` is not that failure (or the
 * installed parser does split, so the failure is something else).
 *
 * `splits` is the probe result; tests inject it. The position is Marko's own:
 * the `:` that ended the first expression.
 */
export function stockParserError(
  error: unknown,
  source: string,
  splits: boolean | undefined = installedParserSplits(),
): TranslateError | undefined {
  if (splits !== false || !(error instanceof Error)) return undefined;
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
    return new TranslateError(STOCK_PARSER_MESSAGE(token), at.line, at.column);
  }
  return undefined;
}
