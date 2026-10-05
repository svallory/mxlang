import coreTags from "./taglib/core-tags.json" with { type: "json" };

/**
 * Marko's core tags as MX knows them (`if`, `else`, `for`, `await`, `try`,
 * `define`, `html-script`, ...): the taglib a translator registers under
 * `mx-translator-core`. One copy, here, so every target and the default-tag
 * check judge a name against the same set of language tags. A host's own
 * translator adds this to Marko's registered element taglibs.
 */
export const CORE_TAGLIB: unknown = coreTags;
