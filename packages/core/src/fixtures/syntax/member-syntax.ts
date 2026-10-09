/**
 * Test-only syntax module (decision 182 addendum 5 item 4): Mesh's `&`
 * member sigil, in all three trigger lists, lowered to the four shapes the
 * Mesh lead confirmed (`notes/mesh/language-extensions-for-mesh.md`, updates
 * 03:10, 03:40, 03:42):
 *
 * - in an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`;
 * - in an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` whose value is `{ kind: "member", name: "dueOn" }`;
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`.
 *
 * Mesh copies this file as its layer-2 module. It loads through Node's
 * strip-only `require` from a manifest's `mx.syntax`, so it imports types
 * only.
 */
import type { SyntaxModule, Trigger } from "../../syntax-table.ts";

/** The member row (the parser half's test row). */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*",
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

const memberSyntax = {
  table: Object.freeze({
    expressionTriggers: [MEMBER],
    attributeTriggers: [MEMBER],
    lineTriggers: [MEMBER],
  }),
  lowerTrigger(_id, text, span, ctx) {
    const name = text.slice(1);
    switch (ctx.position) {
      case "expression":
        return ctx.expression({
          type: "MemberExpression",
          object: { type: "Identifier", name: "self" },
          property: { type: "Identifier", name },
          computed: false,
          extra: { mxMember: { span, name } },
        });
      case "attribute":
        return ctx.attribute("member", { kind: "member", name, span });
      case "line":
        return ctx.child("member", [
          ctx.attribute("name", name),
          ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
        ]);
    }
  },
} satisfies SyntaxModule;

export default Object.freeze(memberSyntax) as SyntaxModule;
