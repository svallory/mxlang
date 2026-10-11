/**
 * Every difference between the built-in atoms and the atom row
 * (`test-support/sugar-rows.ts`, `ATOMS_SYNTAX`) over the parser's atom
 * corpora (`lang-ext-move-sugars-to-mesh`, slice a1), with the ruling that
 * accepts it. `mx-sugar-module.test.ts` asserts this list is exact: no
 * unlisted difference, no stale row.
 *
 * - `build`: `atoms-row` loads the `:` expression row only.
 * - `suite`: `atoms`, `reserved`, `not-atoms`, `sugar-forms`
 *   (`mx-atoms.cases.ts`) or `module-forms` (`mx-sugar-module.test.ts`).
 * - `builtIn` / `module`: the rendering of each path, in the suite's
 *   own format (the module's triggers rendered as built-in events by
 *   `test-support/sugar-module.ts`).
 * - `ruling`: `colon-colon-after-word` (lead ruling Q4), or `NEW` (no
 *   ruling yet; reported to the lead).
 */

export type SugarRuling = "colon-colon-after-word" | "NEW";

export interface SugarDelta {
  readonly build: "atoms-row";
  readonly suite:
    | "atoms"
    | "reserved"
    | "not-atoms"
    | "sugar-forms"
    | "module-forms";
  readonly input: string;
  readonly builtIn: string;
  readonly module: string;
  readonly ruling: SugarRuling;
  /** Why the ruling applies, where the ruling's own name does not say. */
  readonly note?: string;
}

export const DELTAS: readonly SugarDelta[] = [
  // colon-colon-after-word (lead ruling Q4).
  {
    build: "atoms-row",
    suite: "reserved",
    input: "<div x={k::a}/>",
    builtIn:
      "<div> @x ERR(9-12 `::a` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for an atom)",
    module: '<div> @x ="{k::a}"',
    ruling: "colon-colon-after-word",
  },
  {
    build: "atoms-row",
    suite: "reserved",
    input: "<div x=a?b::c/>",
    builtIn:
      "<div> @x ERR(10-13 `::c` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:c` for an atom)",
    module: '<div> @x ="a?b::c"',
    ruling: "colon-colon-after-word",
  },
];
