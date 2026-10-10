/**
 * A test dialect for core's claim process: a one-character sigil row (`&`) in
 * all three trigger lists, lowered to four shapes:
 *
 * - in an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`;
 * - in an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` whose value is `{ kind: "member", name: "dueOn" }`
 *   (a value after it, `&dueOn=1` or `&dueOn(x) { … }`, is refused);
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`. The tag carries `trigger`
 *   (`{ id: "member", span, text }`), which an authored `<member>` lacks.
 *
 * It is a fixture, not shipped: core is host-agnostic and knows no "member".
 * The sigil, the ids, the `self` receiver and the `member` tag are this
 * file's choices. It uses the public hook API only (`Dialect`, `Trigger` and
 * the `ctx` constructors) and imports types only, so a test can load it
 * through Node's strip-only `require` as a dialect package's module (no enums
 * or parameter properties).
 */
import type { Dialect, Trigger } from "../../index.ts";

/** The member row in all three trigger lists. */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*",
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

const memberSyntax = {
  id: "member",
  name: "Fixture",
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
        // After a kind (`sort asc &dueOn`) a member names a field, so a value
        // after it is refused in the fixture's words.
        if (ctx.valueForm !== null)
          ctx.fail(`\`${text}\` is a member reference and takes no value`);
        return ctx.attribute("member", { kind: "member", name, span });
      case "line":
        return ctx.child("member", [
          ctx.attribute("name", name),
          ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
        ]);
    }
  },
} satisfies Dialect;

export default Object.freeze(memberSyntax) as Dialect;
