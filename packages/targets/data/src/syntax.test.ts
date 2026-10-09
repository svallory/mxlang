/**
 * `parseData`'s `syntax` option (decision 182, PR C): a consumer's own table
 * (Mesh builds a frozen one) reaches core; until core lowers triggers, a
 * trigger in the file is a positioned diagnostic, and a file without one
 * gives the default row's tree.
 */
import { defaultSyntax, type SyntaxTable, type Trigger } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: { call: "member" },
};

const MESH: SyntaxTable = Object.freeze({
  ...defaultSyntax(),
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
});

describe("parseData's syntax option", () => {
  it("a trigger the table produces is a positioned diagnostic", () => {
    const result = parseData("entity Order\n  &title\n", "/v/order.mx", {
      syntax: MESH,
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      message: "`member` trigger has no lowering yet",
      line: 2,
      column: 2,
    });
  });

  it("a file without a trigger gives the default row's tree", () => {
    const source = "entity Order\n  field title\n";
    expect(parseData(source, "/v/order.mx", { syntax: MESH })).toEqual(
      parseData(source, "/v/order.mx"),
    );
  });

  it("an invalid table is a diagnostic naming the option, not an internal error", () => {
    const bad = Object.freeze({
      ...MESH,
      expressionTriggers: [{ ...MEMBER, match: "&[" }],
    });
    const result = parseData("div\n", "/v/a.mx", { syntax: bad });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(
      /^the `syntax` option is not a valid syntax table: `syntax\.expressionTriggers\[0\]\.match`/,
    );
    expect(result.diagnostics[0]?.message).not.toContain("internal error");
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 0 });
  });

  it("the default row is frozen and has no triggers", () => {
    const row = defaultSyntax();
    expect(Object.isFrozen(row)).toBe(true);
    expect(row.expressionTriggers).toEqual([]);
  });
});
