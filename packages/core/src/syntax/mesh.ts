/**
 * `@mxlang/core/syntax/mesh` (@unstable): the combined reference dialect Mesh
 * copies as its `MESH_SYNTAX` (lang-ext-move-sugars-to-mesh, slice a1): the
 * member sigil `&` (`member.ts`) plus atoms and the name sugars
 * (`atoms-sugars.ts`). One row per first character in each list, so the two
 * never compete.
 *
 * Lifetime (decision 183 addendum 6): exported, `@unstable`, through the
 * beta, as reference material, not a host's API. Mesh vendors (copies) it
 * at the alpha.15 pin and owns its copy from then on.
 *
 * Rows: `atom` (`:name` in an expression), `atom-value` (`:name` as a whole
 * attribute value, `belongs-to=:List`), `name` (spaced `kind :name`) and
 * `member` (`&name`) are Mesh's forms. `id` (spaced `#id`) and `class`
 * (spaced `.class`) are carried for parity with MX's built-in sugars only;
 * Mesh writes neither, and its copy may drop both rows.
 *
 * The atom contract checks (`contractFields`, `checkContract`,
 * `afterLower`) are the atoms dialect's (slice a2).
 *
 * It imports its two siblings as values (their rows and hooks) and types
 * only from core, so a manifest can `require` it with its siblings beside
 * it.
 */
import type { Dialect, DialectNode, NodeType, Trigger } from "../index.ts";
import atomsSugars, {
  ATOM,
  CLASS_SUGAR,
  ID_SUGAR,
  NAME_SUGAR,
} from "./atoms-sugars.ts";
import memberSyntax, { MEMBER } from "./member.ts";

/** A whole attribute value `:name`, claimed in the value position. */
interface Atom extends DialectNode {
  readonly name: string;
}

/**
 * `:name` as a whole attribute value: the value row claims it as a
 * `mesh:Atom`. `::x` is left to the `atom` expression row, whose error
 * names it reserved. A claimed default value ends where a spaced `:name`
 * starts, so `belongs-to=:List :list` is the default `:List` and the name
 * `:list`.
 */
export const ATOM_VALUE: Trigger = Object.freeze({
  id: "atom-value",
  chars: ":",
  match: ":[A-Za-z_$][\\w$]*(?:-[\\w$]+)*",
  standIn: "keep",
  node: Object.freeze({ type: "Atom", dialect: "mesh" }),
});

/**
 * Lowers to the literal the `atom` expression row builds (a `StringLiteral`
 * marked `extra.mxAtom`), so the attribute keeps its atom mark and the atom
 * contracts read it as before. A plain string would drop the mark.
 */
const atomValue: NodeType<Atom> = {
  keys: [],
  parse: (text) => ({ name: text.slice(1) }),
  print: (node) => `:${node.name}`,
  lower: (node, ctx) =>
    ctx.expression({
      type: "StringLiteral",
      value: node.name,
      extra: {
        raw: JSON.stringify(node.name),
        rawValue: node.name,
        mxAtom: { span: node.span },
      },
    }),
};
export const AtomValue: NodeType<Atom> = Object.freeze(atomValue);

const meshSyntax = {
  id: "mesh",
  name: "Mesh",
  // Mesh files are data, not HTML: no native elements, no HTML tag rules.
  tagRules: "none",
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM, MEMBER]),
    attributeTriggers: Object.freeze([
      NAME_SUGAR,
      ID_SUGAR,
      CLASS_SUGAR,
      MEMBER,
    ]),
    lineTriggers: Object.freeze([MEMBER]),
    valueTriggers: Object.freeze([ATOM_VALUE]),
  }),
  nodeTypes: Object.freeze({ Atom: AtomValue }),
  lowerTrigger(id, text, span, ctx) {
    const dialect = id === MEMBER.id ? memberSyntax : atomsSugars;
    return (dialect.lowerTrigger as NonNullable<Dialect["lowerTrigger"]>)(
      id,
      text,
      span,
      ctx,
    );
  },
  contractFields: atomsSugars.contractFields,
  checkContract: atomsSugars.checkContract,
  describeAttribute: atomsSugars.describeAttribute,
  afterLower: atomsSugars.afterLower,
} satisfies Dialect;

export default Object.freeze(meshSyntax) as Dialect;
