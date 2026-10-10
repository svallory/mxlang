/**
 * Every difference between the built-in atoms and sugars and the
 * atoms-and-sugars dialect (`test-support/sugar-rows.ts`) over the
 * parser's corpora (`lang-ext-move-sugars-to-mesh`, slice a1), with the
 * ruling that accepts it. `mx-sugar-module.test.ts` (atom corpora) and
 * `mx-after-value.test.ts` (after-value tables) assert this list is exact:
 * no unlisted difference, no stale row.
 *
 * - `build`: `atoms-row` loads the `:` expression row only;
 *   `mesh-syntax` loads the member row, the atom row and the three
 *   attribute sugars (Mesh's combined shape).
 * - `suite`: `atoms`, `reserved`, `not-atoms`, `sugar-forms`
 *   (`mx-atoms.cases.ts`), `module-forms` (`mx-sugar-module.test.ts`) or
 *   `after-value` (`mx-after-value.test.ts`).
 * - `builtIn` / `module`: the rendering of each path, in the suite's
 *   own format (the module's triggers rendered as built-in events by
 *   `test-support/sugar-module.ts`).
 * - `ruling`: `single-atom-default` (decision 182 addendum 1),
 *   `colon-colon-after-word` and `colon-colon-in-names` (lead ruling Q4),
 *   `bare-colon-end` (decision 183), `refuse-value` (decision 183, lead
 *   ruling Q5), `placeholder-in-attribute-sugar`, `async-method` (review 460
 *   L2), `trigger-announced-on-completion` (review 460 F3), or `NEW` (no
 *   ruling yet; reported to the lead).
 */

export type SugarRuling =
  | "single-atom-default"
  | "colon-colon-after-word"
  | "colon-colon-in-names"
  | "bare-colon-end"
  | "refuse-value"
  | "placeholder-in-attribute-sugar"
  | "async-method"
  | "trigger-announced-on-completion"
  | "NEW";

export interface SugarDelta {
  readonly build: "atoms-row" | "mesh-syntax";
  readonly suite:
    | "atoms"
    | "reserved"
    | "not-atoms"
    | "sugar-forms"
    | "module-forms"
    | "after-value";
  readonly input: string;
  readonly builtIn: string;
  readonly module: string;
  readonly ruling: SugarRuling;
  /** Why the ruling applies, where the ruling's own name does not say. */
  readonly note?: string;
}

export const DELTAS: readonly SugarDelta[] = [
  // single-atom-default: decision 182 addendum 1 item 3: the exemption is dropped with the built-in atom.
  {
    build: "atoms-row",
    suite: "atoms",
    input: "<has-many=:X :y/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y',
    module: '<has-many> @ atom(X@10-12) ="0. :y"',
    ruling: "single-atom-default",
  },
  {
    build: "atoms-row",
    suite: "atoms",
    input: "has-many=:X :y",
    builtIn: '<has-many> @ atom(X@9-11) ="0." @:y',
    module: '<has-many> @ atom(X@9-11) ="0. :y"',
    ruling: "single-atom-default",
  },
  {
    build: "atoms-row",
    suite: "atoms",
    input: "<has-many=:X :y required/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y @required',
    module: '<has-many> @ atom(X@10-12) ="0. :y" @required',
    ruling: "single-atom-default",
  },
  {
    build: "atoms-row",
    suite: "atoms",
    input: "<has-many=:X  :y/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y',
    module: '<has-many> @ atom(X@10-12) ="0.  :y"',
    ruling: "single-atom-default",
  },
  {
    build: "atoms-row",
    suite: "atoms",
    input: "<belongs-to=:Customer :customer/>",
    builtIn: '<belongs-to> @ atom(Customer@12-21) ="0.0000000" @:customer',
    module: '<belongs-to> @ atom(Customer@12-21) ="0.0000000 :customer"',
    ruling: "single-atom-default",
  },
  {
    build: "mesh-syntax",
    suite: "atoms",
    input: "<has-many=:X :y/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y',
    module: '<has-many> @ atom(X@10-12) ="0. :y"',
    ruling: "single-atom-default",
  },
  {
    build: "mesh-syntax",
    suite: "atoms",
    input: "has-many=:X :y",
    builtIn: '<has-many> @ atom(X@9-11) ="0." @:y',
    module: '<has-many> @ atom(X@9-11) ="0. :y"',
    ruling: "single-atom-default",
  },
  {
    build: "mesh-syntax",
    suite: "atoms",
    input: "<has-many=:X :y required/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y @required',
    module: '<has-many> @ atom(X@10-12) ="0. :y" @required',
    ruling: "single-atom-default",
  },
  {
    build: "mesh-syntax",
    suite: "atoms",
    input: "<has-many=:X  :y/>",
    builtIn: '<has-many> @ atom(X@10-12) ="0." @:y',
    module: '<has-many> @ atom(X@10-12) ="0.  :y"',
    ruling: "single-atom-default",
  },
  {
    build: "mesh-syntax",
    suite: "atoms",
    input: "<belongs-to=:Customer :customer/>",
    builtIn: '<belongs-to> @ atom(Customer@12-21) ="0.0000000" @:customer',
    module: '<belongs-to> @ atom(Customer@12-21) ="0.0000000 :customer"',
    ruling: "single-atom-default",
  },
  // colon-colon-after-word: the trigger never arms after a word, so the reserved-token error is not reported (plan P3).
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
  {
    build: "mesh-syntax",
    suite: "reserved",
    input: "<div x={k::a}/>",
    builtIn:
      "<div> @x ERR(9-12 `::a` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for an atom)",
    module: '<div> @x ="{k::a}"',
    ruling: "colon-colon-after-word",
  },
  {
    build: "mesh-syntax",
    suite: "reserved",
    input: "<div x=a?b::c/>",
    builtIn:
      "<div> @x ERR(10-13 `::c` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:c` for an atom)",
    module: '<div> @x ="a?b::c"',
    ruling: "colon-colon-after-word",
  },
  // bare-colon-end: decision 183: a bare `:` is Marko's; no row matches it, so it no longer ends a value.
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=(a) :\n T => a/>",
    builtIn: '<a> @x ="(a)" @: @T ERR(Missing value for attribute)',
    module: '<a> @x ="(a) :\\n T => a"',
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=1 :/>",
    builtIn: '<a> @x ="1" @:',
    module: "<a> @x ERR(EOF reached while parsing regular expression)",
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=1 :>y</a>",
    builtIn: '<a> @x ="1" @:',
    module:
      '<a> @x ERR(Mismatched group. A closing ">" character was found but it is not matc)',
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: '<a x="1" :/>',
    builtIn: '<a> @x ="\\"1\\"" @:',
    module: "<a> @x ERR(EOF reached while parsing regular expression)",
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=a.b :/>",
    builtIn: '<a> @x ="a.b" @:',
    module: "<a> @x ERR(EOF reached while parsing regular expression)",
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=1 :\n/>",
    builtIn: '<a> @x ="1" @:',
    module: "<a> @x ERR(EOF reached while parsing regular expression)",
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "a x=1 :",
    builtIn: '<a> @x ="1" @:',
    module: '<a> @x ="1 :"',
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "div x=1 :\n  span",
    builtIn: '<div> @x ="1" @: <span>',
    module: '<div> @x ="1 :\\n  span"',
    ruling: "bare-colon-end",
  },
  {
    build: "mesh-syntax",
    suite: "sugar-forms",
    input: "<input x=1 :/>",
    builtIn: '<input> @x ="1" @:',
    module:
      "<input> @x ERR(12-12 EOF reached while parsing regular expression)",
    ruling: "bare-colon-end",
  },
  // refuse-value: decision 183 (withdrawn 146 addendum 4): `#id` and `.class` take no value.
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=1 .b=2/>",
    builtIn: '<a> @x ="1" @.b ="2"',
    module: '<a> @x ="1" ERR(The `.b` shorthand takes no value.)',
    ruling: "refuse-value",
  },
  {
    build: "mesh-syntax",
    suite: "sugar-forms",
    input: "<input #main(a) { return a; }/>",
    builtIn: '<input> @#main method:" return a; "',
    module: "<input> ERR(12-13 The `#main` shorthand takes no value.)",
    ruling: "refuse-value",
  },
  {
    build: "mesh-syntax",
    suite: "module-forms",
    input: "<x #i:=y/>",
    builtIn: '<x> @#i ="y"',
    module: "<x> ERR(5-7 The `#i` shorthand takes no value.)",
    ruling: "refuse-value",
  },
  {
    build: "mesh-syntax",
    suite: "module-forms",
    input: "<x .c(p)/>",
    builtIn: '<x> @.c aargs:"p"',
    module: "<x> ERR(5-6 The `.c` shorthand takes no value.)",
    ruling: "refuse-value",
  },
  // async-method: review 460 L2.
  {
    build: "mesh-syntax",
    suite: "module-forms",
    input: "<x async :n(p) { b }/>",
    builtIn: '<x> @async @:n method:" b "',
    module: '<x> @:n method:" b "',
    ruling: "async-method",
    note: "module path: `async` before an attribute trigger's method is the method's modifier, as `<x async(p){}/>` (lead 14:36, review 460 L2)",
  },
  // trigger-announced-on-completion: review 460 F3. An attribute trigger is
  // announced once its value is complete; here the value fails, so the
  // module path reports the same error (code 3, "Missing value for
  // attribute") at the same offset (13 and 17), with no `@:T` before it.
  // Confirmed against the parser's raw events: only the `onAttrName` for
  // `:T` is missing.
  {
    build: "mesh-syntax",
    suite: "after-value",
    input: "<a x=(a) :T => a/>",
    builtIn: '<a> @x ="(a)" @:T ERR(Missing value for attribute)',
    module: '<a> @x ="(a)" ERR(Missing value for attribute)',
    ruling: "trigger-announced-on-completion",
  },
  {
    build: "mesh-syntax",
    suite: "sugar-forms",
    input: "<input x=(a) :T => a/>",
    builtIn: '<input> @x ="(a)" @:T ERR(17-17 Missing value for attribute)',
    module: '<input> @x ="(a)" ERR(17-17 Missing value for attribute)',
    ruling: "trigger-announced-on-completion",
  },
];
