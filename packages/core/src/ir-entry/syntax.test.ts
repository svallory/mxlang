/**
 * `lowerSource`'s `dialect` option (decision 182, PR C): a consumer's own table
 * (Mesh builds a frozen one) reaches core; until core lowers triggers, a
 * trigger in the file is a positioned diagnostic, and a file without one
 * gives the default row's IR.
 *
 * Core's `syntax-table.test.ts` pins the same table errors on `compileSource`
 * (a thrown `TranslateError`) and the frozen default row. These cases keep
 * what only the entry point does with them: the error arrives as a positioned
 * diagnostic, not an `internal error`, and the option reaches the lowering.
 */
import { describe, expect, it } from "vitest";
import {
  defaultSyntax,
  type SyntaxTable,
  type Trigger,
} from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

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

describe("lowerSource's dialect option", () => {
  it("a trigger the table produces is a positioned diagnostic", () => {
    const result = lowerSource("entity Order\n  &title\n", "/v/order.mx", {
      dialect: MESH,
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      message: "`member` trigger has no lowering yet",
      line: 2,
      column: 2,
    });
  });

  it("a file without a trigger gives the default row's IR", () => {
    const source = "entity Order\n  field title\n";
    expect(lowerSource(source, "/v/order.mx", { dialect: MESH })).toEqual(
      lowerSource(source, "/v/order.mx"),
    );
  });

  it("an invalid table is a diagnostic naming the option, not an internal error", () => {
    const bad = Object.freeze({
      ...MESH,
      expressionTriggers: [{ ...MEMBER, match: "&[" }],
    });
    const result = lowerSource("div\n", "/v/a.mx", { dialect: bad });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(
      /^the `dialect` option is not a valid syntax table: `dialect\.expressionTriggers\[0\]\.match`/,
    );
    expect(result.diagnostics[0]?.message).not.toContain("internal error");
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 0 });
  });

  it("an explicit null is a diagnostic, not read as omitted", () => {
    const result = lowerSource("div\n", "/v/a.mx", {
      dialect: null as unknown as SyntaxTable,
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "the `dialect` option must be a dialect or a syntax table object, not null; omit it to use the dialect that claims the file's extension",
    ]);
  });
});
