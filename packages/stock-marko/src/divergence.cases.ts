/**
 * The divergence table (the package's reason to exist): inputs where the
 * stock htmljs-parser 5.18.0 and MX's template parser read differently by
 * design, plus tree-level rows where the parsers agree and the divergence
 * is in what `@marko/compiler` versus MX core makes of the events, plus
 * controls that must stay equal.
 *
 * Expected streams live in `divergence.expected.json`, rendered by the
 * grammar corpus's own `renderProbe` and regenerated (never hand-typed)
 * with:
 *
 *   GRAMMAR_SPEC_UPDATE=1 bunx vitest run --root ../.. --project @mxlang/stock-marko divergence
 *
 * These are observations of stock, not rulings: a row records what stock
 * 5.18.0 does, so a "Marko does X" sentence can be checked against a real
 * Marko parser.
 */

export interface DivergenceRow {
  id: string;
  input: string;
  /** Where the difference is ruled / recorded. */
  note: string;
}

/**
 * Parser-level rows: the stock and MX event streams differ. Ranges below
 * cite `divergences.md` rows and the decisions behind them.
 */
export const EVENT_ROWS: DivergenceRow[] = [
  // The after-value rule (decision 146; divergences.md "The parser
  // after-value rule"). Stock continues the value across the whitespace.
  {
    id: "after-value-colon",
    input: "<div a=b :c/>",
    note: "decision 146: stock reads one value `b :c`; MX splits `:c`",
  },
  {
    id: "after-value-quoted-colon",
    input: '<a x="1" :b/>',
    note: 'decision 146: stock continues a quoted value, `"1" :b`; MX splits',
  },
  {
    id: "after-value-quoted-dot",
    input: '<a x="1" .b/>',
    note: 'decision 146: stock continues a quoted value, `"1" .b`; MX splits',
  },
  {
    id: "after-value-dot",
    input: "<a x=a.b .c/>",
    note: "decision 146: stock member access across the space; MX splits `.c`",
  },
  {
    id: "after-value-call-dot",
    input: "<a x=fn(a) .b/>",
    note: "decision 146: stock one value `fn(a) .b`; MX splits `.b`",
  },
  {
    id: "after-value-chain-newline",
    input: "<div x=foo\n  .bar()/>",
    note: "decision 146: stock multi-line chain; MX splits `.bar()`",
  },
  {
    id: "after-value-colon-newline",
    input: "<div x=a\n  :b/>",
    note: "decision 146: the split works across a newline; stock continues",
  },
  {
    id: "after-value-postfix",
    input: "<div x=a! .b/>",
    note: "decision 146: stock one value `a! .b`; MX splits `.b`",
  },
  {
    id: "return-type-space-colon",
    input: "<div x=(a) :T => a/>",
    note: "decision 146's known cost: stock keeps the TS return type one value; MX splits `:T`",
  },
  {
    id: "function-return-type-space-colon",
    input: "<div x=function (a) :T { return a }/>",
    note: "decision 146's known cost: stock one value; MX splits `:T` and `{ return a }`",
  },
  // Atoms (decision 156; divergences.md "Atoms"). Stock has no atoms.
  {
    id: "atom-value",
    input: "<div x=:a/>",
    note: "decision 156: stock's value is `:a` (Marko then fails it in Babel); MX lexes an atom",
  },
  {
    id: "atom-ternary",
    input: "<div x=a ? :b :c/>",
    note: "decision 156: stock one plain value; MX two atoms, ternary `:` skipped",
  },
  {
    id: "atom-array",
    input: "<div x=[:a, :b]/>",
    note: "decision 156: stock plain value; MX two atoms",
  },
  {
    id: "atom-placeholder",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source itself contains Marko placeholder syntax
    input: "<div>${:a}</div>",
    note: "decision 156: atoms in placeholders; stock plain content",
  },
  {
    id: "atom-new-key",
    input: "<div x={ new :a }/>",
    note: "decision 156: MX reads keyword + atom; stock's `{ new :a }` is the key `new`",
  },
  {
    id: "atom-reserved-double-colon",
    input: "<div x=::a/>",
    note: "decision 156: `::` is a positioned reserved-token error in MX; stock reads the value `::a`",
  },
  {
    id: "default-single-atom-split",
    input: "belongs-to=:Customer :customer",
    note: "decision 146 addendum 5: MX splits a single-atom default value at ` :customer`; stock one value",
  },
  // Non-ASCII word characters in look-behinds (decision 156 addendum 13;
  // unicode-rules-research.md). Stock is ASCII-only.
  {
    id: "nonascii-division",
    input: "<div x=é / 2/>",
    note: "addendum 13: stock reads a regex after `é` (swallows `/>`); MX divides",
  },
  {
    id: "nonascii-keyword-lookbehind",
    input: "<div x=énew y=1/>",
    note: "addendum 13: stock sees the keyword `new` inside `énew`; MX sees one identifier",
  },
  {
    id: "nbsp-division",
    input: "<div x=(é)\u00a0/ 2/>",
    note: "addenda 10/11: NBSP is not whitespace to stock (regex misread); MX divides",
  },
  {
    id: "nbsp-default-attr",
    input: "<if=count\u00a0>= 10></if>",
    note: "addenda 10/11: stock ends the value at NBSP (`= 10>` is body text); MX reads `count >= 10`",
  },
  // The spaced `< >` known limit (decision 156 addendum 4).
  {
    id: "spaced-type-args-atom",
    input: "<div x=(c ? a < b > :z)/>",
    note: "addendum 4: MX lexes the atom `:z` where TypeScript owns the `:`; stock reads type arguments",
  },
  // Never-throw (decision 165): stock throws a TypeError, MX reports an
  // onError and returns.
  {
    id: "comment-in-text-tag-open-tag",
    input: "<script x=1 // </script>\n>a</script>",
    note: "decision 165: a `//` in a text tag's open tag throws in stock",
  },
  {
    id: "stray-close-after-nameless",
    input: ",--/</e>",
    note: "decision 165: a stray closing tag after a nameless concise tag throws in stock",
  },
  {
    id: "nameless-tag-at-eof",
    input: "<,>a",
    note: "decision 165: a nameless tag open at EOF throws in stock",
  },
];

/**
 * Tree-level rows: the two parsers emit identical events; the divergence
 * is above the parser. `stockMarkoTree` pins what stock Marko makes of
 * them; MX's reading is core's (divergences.md, name-sugar rows).
 */
export const TREE_ROWS: DivergenceRow[] = [
  {
    id: "tag-colon",
    input: "<a:b/>",
    note: 'decision 146: Marko\'s tree is one tag named `a:b`; MX is the tag `a` plus `name="b"`',
  },
  {
    id: "bare-sugar",
    input: "<div :x/>",
    note: 'decision 146: Marko\'s tree is the attribute `value:x` (empty head filled with `value`); MX is `name="x"`',
  },
  {
    id: "shorthand-colon",
    input: "<a.hover:x/>",
    note: 'decision 146: Marko\'s class is `hover:x`; MX is class `hover` plus `name="x"`',
  },
];

/**
 * Controls: streams must stay equal. Each guards a place a past or
 * documented MX rule did (or could) diverge.
 */
export const CONTROL_ROWS: DivergenceRow[] = [
  {
    id: "control-ternary",
    input: "<a x=1 ? y : z/>",
    note: "an open `?` owns its `:` in both (decision 146)",
  },
  {
    id: "control-parenthesized-dot",
    input: "<a x=(a.b .c)/>",
    note: "parentheses keep member access in both (decision 146)",
  },
  {
    id: "copyright-ambiguous-close",
    input: "<div x=a >©>c</div>",
    note: "decision 156 addendum 13 (ID_Continue only): `©` is no word character in either, so the ambiguous-`>` check agrees — pre-addendum-13 MX errored here",
  },
  {
    id: "nbsp-before-comment-in-text",
    input: "<p>Visit\u00a0//cdn.example/x.js</p>",
    note: "addendum 13 item 1: in HTML body text only ASCII whitespace starts a `//` comment, in both",
  },
  {
    id: "control-nonascii-colon",
    input: "<div x=1 :é/>",
    note: "the after-value `:` split is ASCII-only (decision 156 addendum 15, on hold): both keep one value",
  },
];
