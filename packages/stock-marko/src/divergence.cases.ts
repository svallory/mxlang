/**
 * The divergence table (the package's reason to exist): inputs where the
 * stock htmljs-parser 5.18.0 and MX's template parser read differently by
 * design, plus controls that must stay equal.
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
    id: "default-atom-value-continues",
    input: "belongs-to=:Customer :customer",
    note: "decision 156: MX lexes the atom `:Customer`; both read one value `:Customer :customer`",
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
    id: "nonascii-member-dot",
    input: "<div x=a .é/>",
    note: "addendum 13: stock's word test is ASCII-only, so it ends the value before `.é`; MX reads member access `a .é`",
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
 * Controls: streams must stay equal. Each guards a place a past or
 * documented MX rule did (or could) diverge.
 */
export const CONTROL_ROWS: DivergenceRow[] = [
  // The name sugars left core: a space before `:` or `.` no longer ends an
  // attribute value, so these read as stock reads them.
  {
    id: "after-value-colon",
    input: "<div a=b :c/>",
    note: "one value `b :c` in both, as Marko reads it",
  },
  {
    id: "after-value-quoted-colon",
    input: '<a x="1" :b/>',
    note: 'one value `"1" :b` in both, as Marko reads it',
  },
  {
    id: "after-value-quoted-dot",
    input: '<a x="1" .b/>',
    note: 'one value `"1" .b` in both, as Marko reads it',
  },
  {
    id: "after-value-dot",
    input: "<a x=a.b .c/>",
    note: "member access across the space in both, as Marko reads it",
  },
  {
    id: "after-value-call-dot",
    input: "<a x=fn(a) .b/>",
    note: "one value `fn(a) .b` in both, as Marko reads it",
  },
  {
    id: "after-value-chain-newline",
    input: "<div x=foo\n  .bar()/>",
    note: "a multi-line chain in both, as Marko reads it",
  },
  {
    id: "after-value-colon-newline",
    input: "<div x=a\n  :b/>",
    note: "one value across the newline in both, as Marko reads it",
  },
  {
    id: "after-value-postfix",
    input: "<div x=a! .b/>",
    note: "one value `a! .b` in both, as Marko reads it",
  },
  {
    id: "return-type-space-colon",
    input: "<div x=(a) :T => a/>",
    note: "a TypeScript return type stays in the value in both",
  },
  {
    id: "function-return-type-space-colon",
    input: "<div x=function (a) :T { return a }/>",
    note: "a TypeScript return type stays in the value in both",
  },
  {
    id: "tag-colon",
    input: "<a:b/>",
    note: "one tag name `a:b` in both; Marko's tree is pinned in divergence.test.ts",
  },
  {
    id: "bare-sugar",
    input: "<div :x/>",
    note: "the attribute `:x` in both; Marko fills the empty name with `value`",
  },
  {
    id: "shorthand-colon",
    input: "<a.hover:x/>",
    note: "the class shorthand `hover:x` in both; Marko's class is `hover:x`",
  },
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
    note: "one value `1 :é` in both",
  },
];
