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
 * The names of core's own taglib entries (`let`, `effect`, `script`, ...):
 * core's data, so a question about "a core tag" never needs a host to answer.
 */
export const CORE_TAG_NAMES: ReadonlySet<string> = new Set(
  Object.keys(coreTags)
    .filter((key) => key.startsWith("<") && key.endsWith(">"))
    .map((key) => key.slice(1, -1)),
);
