/**
 * The entire runtime of a standalone MX template.
 *
 * A compiled `.mx` module imports exactly this function and nothing else — no
 * scheduler, no signals, no hydration. Everything else in the emitted module is
 * plain string concatenation, which is what makes "no runtime beyond an escape
 * helper" a checkable claim rather than a slogan.
 */

/**
 * Escapes a value for interpolation into HTML text or a quoted attribute.
 *
 * All five of `& < > " '` are escaped, not just the three that matter in text
 * position. One helper serves both positions, and an attribute value is where
 * the quote characters are dangerous: escaping them here means the emitter
 * never has to reason about which quote style it used, and no attribute value
 * can break out of its quotes.
 *
 * `&` is replaced first. Any other order would re-escape the ampersands that
 * the later replacements themselves introduce, turning `<` into `&amp;lt;`.
 *
 * `null` and `undefined` render as the empty string rather than the words
 * "null"/"undefined", which is what a template author means by a missing
 * value; every other non-string is `String()`-coerced.
 *
 * This is the rule for an attribute value (`NaN` prints `NaN`, `0n` prints
 * `0`). Text position follows Marko's other rule, where `false`, `NaN`, `0n`
 * and `""` print nothing; the html target applies that rule before calling this
 * function, which is why this one is unchanged.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name is part of the emitted module's contract — every compiled template imports `escape` by this name, and the global it shadows is deprecated and never used here
export function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
