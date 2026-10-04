import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const host = "html";
interface RenderResult {
  form: string;
  value: string;
  html?: string;
  error?: string;
}
let rows: RenderResult[] = [];
beforeAll(() => {
  rows = JSON.parse(
    execFileSync(
      "bun",
      [
        fileURLToPath(
          new URL(
            "../../../../scripts/attribute-value-probe.ts",
            import.meta.url,
          ),
        ),
        host,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(rows.length).toBeGreaterThan(50);
}, 30_000); // Real host compiler/renderer startup in a separate Bun process.

function result(form: string, value: string): RenderResult {
  const row = rows.find(
    (entry) => entry.form === form && entry.value === value,
  );
  if (!row)
    throw new Error(`Missing real-render evidence: ${host}/${form}/${value}`);
  return row;
}

describe("native attribute object values (real renders)", () => {
  it("rejects functions and symbols with Marko's debug text", () => {
    for (const form of [
      "direct",
      "spread",
      "folded",
      "colon",
      "foldedColon",
      "survivingSpread",
      "dynamic",
      "dynamicArgs",
    ])
      for (const value of ["function", "symbol"]) {
        const name =
          form.includes("Colon") || form === "colon" ? "is:raw" : "data-x";
        expect(result(form, value).error, `${form}/${value}`).toBe(
          `The \`${name}\` attribute cannot be a ${value}.`,
        );
      }
  });
  it("rejects unrenderable objects with Marko's exact error on every native path", () => {
    const forms = [
      "direct",
      "spread",
      "folded",
      "colon",
      "foldedColon",
      "inputSpread",
      "survivingSpread",
      "dynamic",
      "dynamicArgs",
    ];
    for (const form of forms)
      for (const value of ["plain", "nullproto"]) {
        const name =
          form === "colon" || form === "foldedColon" ? "is:raw" : "data-x";
        expect(result(form, value).error, `${form}/${value}`).toBe(
          `The \`${name}\` attribute cannot be a plain object (it would render as \`[object Object]\`).`,
        );
      }
  });
  it("accepts arrays, meaningful toString values, Dates, zero and null", () => {
    for (const form of ["direct", "spread", "folded"]) {
      for (const [value, expected] of [
        ["array", "1,2"],
        ["custom", "custom"],
        ["date", new Date("2020-01-01T00:00:00Z").toString()],
        ["zero", "0"],
      ] as const) {
        const row = result(form, value);
        expect(row.error).toBeUndefined();
        expect(row.html).toContain(expected);
      }
      expect(result(form, "null").error).toBeUndefined();
    }
  });
  it("validates only surviving merged values, evaluating authored getters once", () => {
    for (const form of ["overwritten", "overwrittenSpread", "overwrittenColon"])
      for (const value of ["plain", "nullproto"]) {
        expect(result(form, value).error).toBeUndefined();
        expect(result(form, value).html).toContain("safe");
      }
    expect(result("once", "getter").html).toContain("once");
    expect(result("reads", "getter").html).toBe("1");
    for (const form of ["coercion", "coercionSpread"]) {
      expect(result(form, "custom").html).toContain("second");
      expect(result(`${form}Count`, "custom").html).toBe("2");
    }
  });
  it("does not reject class/style objects or controlled values", () => {
    const structured = result("structured", "plain");
    expect(structured.error).toBeUndefined();
    expect(/class="([^"]*)"/.exec(structured.html ?? "")?.[1]?.trim()).toBe(
      "a",
    );
    expect(structured.html).toContain("color:red");
    for (const form of [
      "classAcrossSpread",
      "spreadStructured",
      "checked",
      "open",
      "selectValue",
    ])
      expect(result(form, "plain").error, form).toBeUndefined();
  });
  it("guards attribute-tag fields when a dynamic target is native", () => {
    expect(result("dynamicDataTag", "plain").error).toBe(
      "The `meta` attribute cannot be a plain object (it would render as `[object Object]`).",
    );
  });
  it("keeps object-valued component props out of the native attribute guard", () => {
    expect(result("component", "plain").error).toBeUndefined();
    expect(result("component", "plain").html).toContain("1");
  });
});
