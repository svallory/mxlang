/**
 * The combined reference module Mesh copies as its `MESH_SYNTAX`
 * (lang-ext-move-sugars-to-mesh, slice a1): the member sigil `&`
 * (`member.ts`) plus atoms and the name sugars (`atoms-sugars.ts`).
 * One row per first character in each list, so the two never compete.
 * The atom contract checks (`contractFields`, `checkContract`,
 * `afterLower`) are the atoms module's (slice a2). Types only, like its
 * parts, so a manifest can `require` it.
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
