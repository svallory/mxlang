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

const withStatements = new WeakMap<object, unknown>();

/**
 * `translator` with core's statement tags declared (decision 168): the one
 * generic point every translator passes before Marko builds a lookup from it,
 * so a translator not built with `createTranslator` (a third-party target's)
 * still parses `static`, `import`, `export`, `client`, `server` and `class` as
 * statements. A translator that already lists core's taglib or the statement
 * taglib, or says `statementTags: false` (data's own three), is returned as it
 * is. The result is cached per input: Marko keys its lookup on the object.
 */
export function withStatementTags(translator: unknown): unknown {
  if (translator === null || typeof translator !== "object") return translator;
  const given = translator as {
    taglibs?: Array<[string, unknown]>;
    statementTags?: false;
  };
  if (!Array.isArray(given.taglibs) || given.statementTags === false) {
    return translator;
  }
  if (
    given.taglibs.some(
      ([id]) => id === STATEMENT_TAGLIB_ID || id === CORE_TAGLIB_ID,
    )
  ) {
    return translator;
  }
  let wrapped = withStatements.get(translator);
  if (!wrapped) {
    wrapped = {
      ...given,
      taglibs: [[STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB], ...given.taglibs],
    };
    withStatements.set(translator, wrapped);
  }
  return wrapped;
}

/**
 * The names of core's own taglib entries (`let`, `effect`, `script`, ...):
 * core's data, so a question about "a core tag" never needs a host to answer.
 */
export const CORE_TAG_NAMES: ReadonlySet<string> = new Set(
  Object.keys(coreTags)
    .filter((key) => key.startsWith("<") && key.endsWith(">"))
    .map((key) => key.slice(1, -1)),
);
