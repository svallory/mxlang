/**
 * A test dialect whose members are a node type: `Member` (`member:Member`), a
 * name the author writes `&name`. It registers the type itself, with a schema,
 * as a real dialect must. Core has no member vocabulary: it knows a member
 * only as a node of a registered type (`Attr.node`, `Expr.nodes`) and its
 * forward. The sigil row is a one-character `&` in three places:
 *
 * - in an expression (`&status`), the expression row claims a `Member` node,
 *   whose forward is `self.status`, a `MemberExpression`, listed in
 *   `Expr.nodes`; `on:load=&visible` is a dynamic attribute whose value is
 *   exactly that forward, and a `type: "member:Member"` slot accepts it;
 * - in an attribute list (after a kind, `sort asc &dueOn`), the `{ call }` row
 *   places a `member:Member` node as the value of a static attribute `member`
 *   (`ctx.attribute`); a value after it (`&dueOn=1` or `&dueOn(x) { … }`) is
 *   refused;
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`. The tag carries `trigger`
 *   (`{ id: "member", span, text }`), which an authored `<member>` lacks.
 *
 * Core has no "one member per name slot" check. This file asks for one with
 * the generic `once` option of `ctx.attribute`, which refuses a second
 * attribute of the same name at the later one (`sort asc &c &d` is refused at
 * `&d`). `afterLower` cannot do it: core has already dropped the earlier of
 * two same-named attributes by then.
 *
 * It is a fixture, not shipped: core is host-agnostic and knows no "member".
 * The sigil, the ids, the `self` receiver and the `member` tag are this
 * file's choices. It uses the public hook API only (`Dialect`, `Trigger` and
 * the `ctx` constructors) and imports types only, so a test can load it
 * through Node's strip-only `require` as a dialect package's module (no enums
 * or parameter properties).
 */
import type { Dialect, Trigger } from "../../index.ts";

const NAME = "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*";

/** The member row in an attribute list and on a tagless line (`{ call }`). */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

/** The member row in an expression: the node type below lowers it. */
export const MEMBER_NODE: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ type: "Member", dialect: "member" }),
});

/** The node a `Member` is: its name, without the sigil. */
export interface MemberNode {
  readonly type: "member:Member";
  readonly name: string;
  readonly span: { readonly sourceStart: number; readonly sourceEnd: number };
}

const memberSyntax = {
  id: "member",
  name: "Fixture",
  table: Object.freeze({
    expressionTriggers: [MEMBER_NODE],
    attributeTriggers: [MEMBER],
    lineTriggers: [MEMBER],
  }),
  nodeTypes: {
    Member: {
      keys: [],
      schema: { fields: { name: "data" }, slot: ["expression", "value"] },
      parse: (text: string) => ({ name: text.slice(1) }),
      print: (node: { name: string }) => `&${node.name}`,
      lower: (node: { name: string }, ctx) =>
        // In an expression the member reads the record (`self.status`); as a
        // whole attribute value it is its name as a string literal, which is
        // what every target emits.
        ctx.position === "expression"
          ? ctx.expression({
              type: "MemberExpression",
              object: { type: "Identifier", name: "self" },
              property: { type: "Identifier", name: node.name },
              computed: false,
            })
          : ctx.expression({
              type: "StringLiteral",
              value: node.name,
              extra: { raw: JSON.stringify(node.name), rawValue: node.name },
            }),
    },
  },
  lowerTrigger(_id, text, span, ctx) {
    const name = text.slice(1);
    switch (ctx.position) {
      case "expression":
        // A `{ call }` expression row is not in this table.
        return ctx.fail("the member row in an expression is a node row");
      case "attribute":
        // After a kind (`sort asc &dueOn`) a member names a field, so a value
        // after it is refused in the fixture's words.
        if (ctx.valueForm !== null)
          ctx.fail(`\`${text}\` is a member reference and takes no value`);
        return ctx.attribute(
          "member",
          { type: "member:Member", name, span },
          {
            once: "one member per slot: `{written}` cannot also set `member`, which the member at {first} already holds",
          },
        );
      case "line":
        return ctx.child("member", [
          ctx.attribute("name", name),
          ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
        ]);
    }
  },
} satisfies Dialect;

export default Object.freeze(memberSyntax) as Dialect;
