/**
 * Printing the names MX generated for a `<const>` or `<define>`
 * (`__mxConst_a`) as the names the author wrote (`a`). One rule, used by
 * `mx-angular ng-build` and by the `.ng.mx` checker.
 */

/**
 * One map from several: a generated name that two maps give different authored
 * names is `null`, meaning "do not guess", not either of them.
 */
export function mergeAuthoredNames(
  maps: Iterable<Record<string, string | null>>,
): Record<string, string | null> {
  const merged: Record<string, string | null> = Object.create(null);
  for (const map of maps) {
    for (const [generated, authored] of Object.entries(map)) {
      const known = merged[generated];
      merged[generated] =
        known === undefined || known === authored ? authored : null;
    }
  }
  return merged;
}

// Colour escapes (`ng build` colours a TTY's names): `\x1b[1m__mxConst_a\x1b[0m`
// has no word character between the escape and the name, but `m` of `[0m` is
// one, so the boundary test below skips escapes first.
const ANSI = "(?:\\x1b\\[[0-9;]*m)*";

/**
 * `text` with each generated name replaced by its authored one, in one pass
 * (a replaced name is never rescanned). A name is matched as a whole
 * identifier, so `__mxConst_a` leaves `__mxConst_ab` alone. A `null` entry
 * (see {@link mergeAuthoredNames}) is left as printed.
 */
export function rewriteAuthoredNames(
  text: string,
  names: Record<string, string | null>,
): string {
  const usable = Object.entries(names).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  if (usable.length === 0) return text;
  // Longest first, so a name that prefixes another cannot win the alternation.
  const alternation = usable
    .map(([generated]) => generated)
    .sort((a, b) => b.length - a.length)
    .map((generated) => generated.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `(?<![\\w$])(?:${ANSI})?(${alternation})(?![\\w$])`,
    "g",
  );
  const byGenerated = new Map(usable);
  return text.replace(pattern, (whole, generated: string) =>
    whole.replace(generated, () => byGenerated.get(generated) as string),
  );
}
