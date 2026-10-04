/**
 * Makes the lookup's tag map prototype-free. Marko's `getTag(name)` is
 * `merged.tags[name]` on a plain object, so a tag named `toString`,
 * `constructor` or `__proto__` resolves to an `Object.prototype` member and
 * Marko dereferences `undefined.filePath` (a raw `TypeError`). Without the
 * prototype those names are unknown tags, like any other.
 *
 * Marko caches a lookup by its taglib ids, not by translator object, so one
 * lookup can be reached through another translator with the same taglibs.
 * Hardening is idempotent, and every `compileSync` caller in a package must
 * harden its own lookup rather than rely on another caller having done it.
 */
export function nullPrototypeTags(lookup: unknown): void {
  const tags = (lookup as { merged?: { tags?: object } } | undefined)?.merged
    ?.tags;
  if (tags && Object.getPrototypeOf(tags) !== null) {
    Object.setPrototypeOf(tags, null);
  }
}
