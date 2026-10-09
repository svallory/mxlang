/**
 * `@mxlang/core/syntax/mesh` (@unstable): the combined reference module Mesh
 * copies as its `MESH_SYNTAX` (lang-ext-move-sugars-to-mesh, slice a1): the
 * member sigil `&` (`member.ts`) plus atoms and the name sugars
 * (`atoms-sugars.ts`). One row per first character in each list, so the two
 * never compete.
 *
 * Lifetime (decision 183 addendum 6): exported, `@unstable`, through the
 * beta, as reference material, not a host's API. Mesh vendors (copies) it
 * at the alpha.15 pin and owns its copy from then on.
 *
 * Rows: `atom` (`:name` in an expression), `name` (spaced `kind :name`) and
 * `member` (`&name`) are Mesh's forms. `id` (spaced `#id`) and `class`
 * (spaced `.class`) are carried for parity with MX's built-in sugars only;
 * Mesh writes neither, and its copy may drop both rows.
 *
 * The atom contract checks (`contractFields`, `checkContract`,
 * `afterLower`) are the atoms module's (slice a2).
 *
 * It imports its two siblings as values (their rows and hooks) and types
 * only from core, so a manifest can `require` it with its siblings beside
 * it.
 */
import type { SyntaxModule } from "../index.ts";
import atomsSugars, {
  ATOM,
  CLASS_SUGAR,
  ID_SUGAR,
  NAME_SUGAR,
} from "./atoms-sugars.ts";
import memberSyntax, { MEMBER } from "./member.ts";

const meshSyntax = {
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM, MEMBER]),
    attributeTriggers: Object.freeze([
      NAME_SUGAR,
      ID_SUGAR,
      CLASS_SUGAR,
      MEMBER,
    ]),
    lineTriggers: Object.freeze([MEMBER]),
  }),
  lowerTrigger(id, text, span, ctx) {
    const module = id === MEMBER.id ? memberSyntax : atomsSugars;
    return (module.lowerTrigger as NonNullable<SyntaxModule["lowerTrigger"]>)(
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
} satisfies SyntaxModule;

export default Object.freeze(meshSyntax) as SyntaxModule;
