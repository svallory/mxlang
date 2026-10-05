/**
 * Wildcard children (decision 147, ADR 147): a contract's `children["*"]`.
 *
 * The pure half: reading a `children` record into its explicit names and its
 * ordered `"*"` entries, compiling an entry's pattern, and matching a name.
 * Which tags are eligible, and the per-node record of what matched, live in
 * `wildcard-resolve.ts`, which runs over the Marko tree; registration checks
 * live with the other declaration checks in `custom-tags.ts`.
 */

import type {
  CustomTagChild,
  CustomTagChildren,
  WildcardChildEntry,
} from "./custom-tags.ts";

/**
 * The code of the did-you-mean guard's warning (decision 147): a wildcard
 * child one typo from an explicit child of the same parent. `mx-tsc`'s data
 * check promotes it to an error.
 */
export const WILDCARD_NEAR_EXPLICIT = "wildcard-near-explicit";

/** The `children` key that holds the wildcard entries. */
export const WILDCARD = "*";

/** The keys an entry may have: a selector, a reference, or an inline contract. */
export const WILDCARD_ENTRY_KEYS = [
  "pattern",
  "contract",
  "attributes",
  "attributeTags",
  "children",
  "defaultTag",
] as const;

/** The inline-contract keys, the ones `contract` excludes. */
export const INLINE_CONTRACT_KEYS = [
  "attributes",
  "attributeTags",
  "children",
  "defaultTag",
] as const;

/** The explicit entries of a `children` record, `"*"` excluded. */
export function explicitChildEntries(
  children: CustomTagChildren | undefined,
): Array<[string, CustomTagChild]> {
  if (!children) return [];
  return Object.entries(children).filter(
    (entry): entry is [string, CustomTagChild] =>
      entry[0] !== WILDCARD && entry[1] !== undefined,
  );
}

/** Whether `name` is an explicit entry (never `"*"` itself). */
export function hasExplicitChild(
  children: CustomTagChildren | undefined,
  name: string,
): boolean {
  return (
    children !== undefined && name !== WILDCARD && Object.hasOwn(children, name)
  );
}

/** The `"*"` entries in declaration order; one object reads as a list of one. */
export function wildcardEntries(
  children: CustomTagChildren | undefined,
): readonly WildcardChildEntry[] {
  if (!children || !Object.hasOwn(children, WILDCARD)) return [];
  const value = children[WILDCARD];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as WildcardChildEntry];
}

const compiled = new WeakMap<WildcardChildEntry, RegExp>();

/**
 * The entry's anchored regex: `^(?:pattern)$`, no flags, so an author never
 * writes `^`/`$` and a pattern that already has them still means the same.
 * Throws the engine's `SyntaxError` for an invalid source; registration calls
 * it first, so a compile never meets one.
 */
export function entryRegExp(entry: WildcardChildEntry): RegExp | undefined {
  if (entry.pattern === undefined) return undefined;
  let regex = compiled.get(entry);
  if (!regex) {
    regex = new RegExp(`^(?:${entry.pattern})$`);
    compiled.set(entry, regex);
  }
  return regex;
}

/** The first entry whose pattern matches the whole name; no pattern matches every name. */
export function matchWildcardEntry(
  children: CustomTagChildren | undefined,
  name: string,
): { entry: WildcardChildEntry; groups: Record<string, string> } | undefined {
  for (const entry of wildcardEntries(children)) {
    const regex = entryRegExp(entry);
    if (!regex) return { entry, groups: {} };
    const found = regex.exec(name);
    if (!found) continue;
    const groups: Record<string, string> = {};
    for (const [key, value] of Object.entries(found.groups ?? {})) {
      if (value !== undefined) groups[key] = value;
    }
    return { entry, groups };
  }
  return undefined;
}

/**
 * How a tag is named in a message: `` `<title>` (as `attribute`) `` for a
 * wildcard child matched by reference, `` `<PORT>` (inline contract) `` for
 * one matched by an inline contract, otherwise `` `<name>` ``.
 */
export function tagLabel(
  name: string,
  alias: { authored: string } | undefined,
): string {
  if (!alias) return `\`<${name}>\``;
  return alias.authored === name
    ? `\`<${name}>\` (inline contract)`
    : `\`<${alias.authored}>\` (as \`${name}\`)`;
}
