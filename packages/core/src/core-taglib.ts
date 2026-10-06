import coreTags from "./taglib/core-tags.json" with { type: "json" };

/**
 * Marko's core tags as MX knows them (`if`, `else`, `for`, `await`, `try`,
 * `define`, `html-script`, ...): the taglib a translator registers under
 * `mx-translator-core`. One copy, here, so every target and the default-tag
 * check judge a name against the same set of language tags. A host's own
 * translator adds this to Marko's registered element taglibs.
 */
export const CORE_TAGLIB: unknown = coreTags;

/** The id the core taglib registers under. */
export const CORE_TAGLIB_ID = "mx-translator-core";

/**
 * Only the statement entries of the core taglib (`import`, `static`, `export`,
 * `client`, `server`, `class`): what every parse registers (decision 168), so
 * their text is code on every target. The rest of the core taglib (`if`,
 * `for`, `script`, ...) carries semantics a host opts into, so a host adds
 * the whole `CORE_TAGLIB` itself (html does).
 */
export const STATEMENT_TAGLIB: unknown = Object.fromEntries(
  Object.entries(
    coreTags as Record<string, { parseOptions?: { statement?: boolean } }>,
  ).filter(([key, tag]) => key.startsWith("<") && tag?.parseOptions?.statement),
);

/** The id the statement-only taglib registers under. */
export const STATEMENT_TAGLIB_ID = "mx-statement-tags";

/**
 * The names of core's own taglib entries (`let`, `effect`, `script`, ...):
 * core's data, so a question about "a core tag" never needs a host to answer.
 */
export const CORE_TAG_NAMES: ReadonlySet<string> = new Set(
  Object.keys(coreTags)
    .filter((key) => key.startsWith("<") && key.endsWith(">"))
    .map((key) => key.slice(1, -1)),
);
