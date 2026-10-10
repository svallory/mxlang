/**
 * `@mxlang/core/syntax/member`: a reference dialect for extension
 * authors (decision 182 addendum 5): Mesh's `&` member sigil, in all three
 * trigger lists, lowered to four shapes:
 *
 * - in an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`;
 * - in an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` whose value is `{ kind: "member", name: "dueOn" }`
 *   (a value after it, `&dueOn=1` or `&dueOn(x) { … }`, is refused at the
 *   member);
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`. The tag carries `trigger`
 *   (`{ id: "member", span, text }`), which an authored `<member>` lacks.
 *
 * This is a reference, not a host: core stays host-agnostic and knows no
 * "member". The dialect is built on the public hook API only (`Dialect`,
 * `Trigger` and the `ctx` constructors) and imports types only, so it is
 * either used as is,
 *
 * ```ts
 * import { lowerSource } from "@mxlang/core";
 * import memberSyntax from "@mxlang/core/syntax/member";
 * lowerSource(source, file, { dialect: memberSyntax });
 * ```
 *
 * or copied into a project and renamed (the sigil, the `member` id, the
 * `self` receiver and the `member` tag are this file's choices, not core's):
 * change the type import below to `@mxlang/core`, give the row your own `id`
 * and `chars`, and name the copy in your dialect package's
 * `package.json#mx.dialect.module`. It loads
 * through Node's strip-only `require`, so keep it free of enums and
 * parameter properties.
 */
import type { Dialect, Trigger } from "../index.ts";

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
  name: "Mesh",
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
        // After a kind (`sort asc &dueOn`) a member names a field; Mesh's
        // review of PR 460 (F6) asked for this refusal in the module's words.
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
