/**
 * The atoms-and-sugars dialect's rows (`lang-ext-move-sugars-to-mesh`,
 * slice a1): MX's atoms (decision 156) and name sugars (decision 146) as
 * layer-2 syntax-table rows. The parser's differential tests
 * (`mx-sugar-module.test.ts`) run the atom and after-value corpora through
 * them.
 *
 * The attribute rows' matchers take exactly the attribute-name extent the
 * built-in lexer gives a static sugar (`#a.b:c`, `.c:b`, `::x`, `:a:b`,
 * `.a+b`, `.bg-[#fff]`, `.w-1/2`), so core's hook sees the token today's
 * per-token diagnostics read. One body item (`ITEM`) is any character the
 * attribute-name lexer continues a name through:
 *
 * - `PLAIN`: anything but ASCII whitespace or a control character (the
 *   lexer's `isWhitespaceCode`), and `,` `=` `(` `)` `<` `>` `/` `:` `;`
 *   quotes, `[` `]` `{` `}`; `$` is plain, so `${…}` stops the match at
 *   `{` (a placeholder inside a sugar is a delta, below);
 * - `/` before a plain character (division, `.w-1/2`; never `/>`, `//`,
 *   `/*`);
 * - a bracketed run of at most 64 characters without whitespace, quotes,
 *   brackets or braces (`.bg-[#fff]`), bounded so the repeat stays one the
 *   validator's nested-quantifier rule admits;
 * - one or two `:` before a plain character (`#a:b`, `:a::b`), never `:=`
 *   (the bound operator) and never a trailing `:`.
 *
 * The first character after the sigil decides whether the row arms at all,
 * which is also what `terminatesValue` reads after a value, so each row
 * starts with the character the built-in after-value rule accepts:
 *
 * - `NAME` (`:`): an ASCII identifier start (`isIdentStartCode`), or `:`
 *   and one (`::x`, so the hook can name it reserved); bare `:` never
 *   matches, `:1a` and `:é` stay built-in;
 * - `CLASS` (`.`): a name start (`isNameStartAt`: a word character that is
 *   not an ASCII digit; written as letters, `$`, `_`, ID_Start, Mn, Mc, Pc,
 *   ZWNJ and ZWJ, which leaves out the rare non-ASCII decimal digits and
 *   Other_ID_Continue), so `x=a .5` stays one value and `.1` stays built-in;
 * - `ID` (`#`): any body item, since `#` never continues a value (`#1a`
 *   matches).
 */
import type { SyntaxTable, Trigger } from "../index.ts";
import { DEFAULT_SYNTAX } from "../index.ts";

const PLAIN = "[^\\x00-\\x20,=()<>/:;\"'`[\\]{}]";
const SLASH = "/[^\\x00-\\x20,=()<>/:;\"'`[\\]{}*]";
const BRACKETS = "\\[[^\\x00-\\x20\"'`[\\]{}]{0,64}\\]";
const COLONS = `:{1,2}${PLAIN}`;
/** One character (or short run) the attribute-name lexer continues a static name through. */
export const ITEM = `(?:${PLAIN}|${SLASH}|${BRACKETS}|${COLONS})`;
const NAME_START = "[A-Za-z_$\\u200c\\u200d\\p{ID_Start}\\p{Mn}\\p{Mc}\\p{Pc}]";

/** `:name` as a value (decision 156), and the reserved `::name` (the hook reports it). */
export const ATOM: Trigger = {
  id: "atom",
  chars: ":",
  match:
    "::(?:[A-Za-z_$][\\w$]*(?:-[\\w$]+)*)?|:[A-Za-z_$][\\w$]*(?:-[\\w$]+)*",
  standIn: "number",
  node: { call: "atom" },
};

/** `:name` in attribute position: the `name` attribute (decision 146). */
export const NAME: Trigger = {
  id: "name",
  chars: ":",
  match: `::?[A-Za-z_$]${ITEM}*`,
  standIn: "keep",
  node: { call: "name" },
  terminatesValue: true,
};

/** Spaced `#id` (decision 146): no value (decision 183). */
export const ID: Trigger = {
  id: "id",
  chars: "#",
  match: `#${ITEM}+`,
  standIn: "keep",
  node: { call: "shorthand" },
  terminatesValue: true,
  value: "refuse",
};

/** Spaced `.class` (decision 146): no value (decision 183). */
export const CLASS: Trigger = {
  id: "class",
  chars: ".",
  match: `\\.${NAME_START}${ITEM}*`,
  standIn: "keep",
  node: { call: "shorthand" },
  terminatesValue: true,
  value: "refuse",
};

/** A one-character sigil row (`&name`) in all three positions, as a dialect's member row. */
export const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: { call: "member" },
};

const table = (patch: Partial<SyntaxTable>): SyntaxTable => ({
  ...DEFAULT_SYNTAX,
  ...patch,
});

/** Atoms only: the expression row. */
export const ATOMS_SYNTAX = table({ expressionTriggers: [ATOM] });

/** The atoms-and-sugars module: atoms and the three attribute sugars. */
export const SUGARS_SYNTAX = table({
  expressionTriggers: [ATOM],
  attributeTriggers: [NAME, ID, CLASS],
});

/** The combined shape Mesh copies: the member row plus atoms and sugars. */
export const MESH_SYNTAX = table({
  expressionTriggers: [MEMBER, ATOM],
  attributeTriggers: [MEMBER, NAME, ID, CLASS],
  lineTriggers: [MEMBER],
});
