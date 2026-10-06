import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface Result {
  form: string;
  value: string;
  html?: string;
  error?: string;
}
let rows: Result[];
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
        "html",
        "--primitives",
      ],
      { encoding: "utf8" },
    ),
  );
}, 30_000); // Runs the emitted modules, not an assertion on generated text.

const names = [
  "title",
  "data-x",
  "aria-hidden",
  "is:raw",
  "disabled",
  "hidden",
  "checked",
  "class",
  "style",
];
const forms = [
  "direct",
  "spread",
  "folded",
  "tail",
  "dynamicName",
  "dynamic",
  "dynamicArgs",
  "bound",
];
const values = ["null", "undefined", "false", "true", "zero", "empty", "NaN"];

function result(form: string, value: string): Result {
  const row = rows.find((row) => row.form === form && row.value === value);
  if (!row) throw new Error(`Missing render evidence: ${form}/${value}`);
  return row;
}

// Measured with real Marko 6.3.51 renders. HTML's quoted attributes are
// semantically identical to Marko's minimized quotes and empty valueless attrs.
describe("native primitive attribute presence (Marko 6.3.51)", () => {
  for (const name of names) {
    it(`${name}: direct, merged, computed-name, dynamic and bound paths`, () => {
      for (const form of forms)
        for (const value of values) {
          const row = result(`${name}/${form}`, value);
          const structured = name === "class" || name === "style";
          const omitted =
            ["null", "undefined", "false"].includes(value) ||
            (structured && ["zero", "empty", "NaN"].includes(value));
          // `:raw:=` is a binding refinement, not part of the rendered name:
          // Marko's change handler (`x = raw(next)`) is client-only, and this
          // target renders once, so only the base name and value appear.
          const renderedName =
            name === "is:raw" && form === "bound" ? "is" : name;
          let attribute = "";
          if (!omitted) {
            const checked =
              name === "checked" && ["direct", "bound"].includes(form);
            const text =
              value === "zero" ? "0" : value === "empty" ? "" : value;
            attribute =
              checked || (value === "true" && !structured)
                ? ` ${renderedName}`
                : ` ${renderedName}="${text}"`;
          }
          expect(row.error, `${name}/${form}/${value}`).toBeUndefined();
          expect(row.html, `${name}/${form}/${value}`).toBe(
            name === "checked"
              ? `<input${attribute}>`
              : `<div${attribute}></div>`,
          );
        }
    });
  }
  it("evaluates null-valued getters exactly once on every path", () => {
    for (const form of forms) {
      expect(result(`once/${form}`, "null").html, form).toBe("<div></div>");
      expect(result(`reads/${form}`, "null").html, form).toBe("1");
    }
  });
});
