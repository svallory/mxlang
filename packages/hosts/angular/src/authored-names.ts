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

// Colour escapes: `ng build` prints none into a pipe, so they appear only when
// the environment forces colour (`FORCE_COLOR`); `\x1b[1m__mxConst_a\x1b[0m` has
// no word character between the escape and the name, but `m` of `[0m` is one,
// so the boundary test below looks past escapes.
const ANSI = "(?:\\x1b\\[[0-9;]*m)*";

/** One replacement a rewrite made: where in the input, how long it was, how long its replacement is. */
export interface NameEdit {
  index: number;
  removed: number;
  added: number;
}

/**
 * A function that replaces each generated name in `names` with its authored
 * one, in one pass (a replaced name is never rescanned). A name is matched as
 * a whole identifier, so `__mxConst_a` leaves `__mxConst_ab` alone. A `null`
 * entry (see {@link mergeAuthoredNames}) is left as printed. The map is read
 * and the pattern compiled once, so build it once per run. `onEdit` is told
 * each replacement, in input order, for a caller that keeps a second line
 * aligned with the first.
 */
export function createNameRewriter(
  names: Record<string, string | null>,
): (text: string, onEdit?: (edit: NameEdit) => void) => string {
  const usable = Object.entries(names).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  if (usable.length === 0) return (text) => text;
  // Longest first, so a name that prefixes another cannot win the alternation.
  const alternation = usable
    .map(([generated]) => generated)
    .sort((a, b) => b.length - a.length)
    .map((generated) => generated.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `(?<![\\w$])${ANSI}(${alternation})(?![\\w$])`,
    "g",
  );
  const byGenerated = new Map(usable);
  return (text, onEdit) =>
    text.replace(pattern, (whole, generated: string, offset: number) => {
      const authored = byGenerated.get(generated) as string;
      onEdit?.({
        index: offset + whole.indexOf(generated),
        removed: generated.length,
        added: authored.length,
      });
      return whole.replace(generated, () => authored);
    });
}
