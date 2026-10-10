import { describe, expect, it } from "vitest";
import { lowerSource } from "./index.ts";

/**
 * Core rejects a tag name outside Marko's charset (`lower.ts` `TAG_NAME`), next
 * to the attribute-name check. `lowerSource` surfaces it as a positioned
 * diagnostic instead of a child tag named `&title`.
 */
function parse(source: string) {
  return lowerSource(source, "x.mesh.mx");
}

describe("invalid tag names (IR entry point)", () => {
  it("rejects `&title` under a parent, at the name", () => {
    const { ir, diagnostics } = parse("div\n  &title\n");
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 2,
      column: 2,
    });
    expect(diagnostics[0]?.message).toContain(
      "Invalid tag name `&title`; Marko rejects it too — a tag name may use letters (any script), digits and `-._:$`",
    );
  });

  it("rejects `&amount=qty * price` on the tag name", () => {
    const { ir, diagnostics } = parse("div\n  &amount=qty * price\n");
    expect(ir).toBeUndefined();
    expect(diagnostics[0]?.message).toContain("Invalid tag name `&amount`");
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 2 });
  });

  it("keeps `&dueOn` as an attribute-name error, parallel to the tag-name one", () => {
    const { ir, diagnostics } = parse("entity sort asc &dueOn\n");
    expect(ir).toBeUndefined();
    expect(diagnostics[0]?.message).toContain(
      "Invalid attribute name `&dueOn`",
    );
    expect(diagnostics[0]?.message).toContain("Marko rejects it too");
  });

  it.each(["a-b", "a.b", "a:b", "a_b", "a$b"])(
    "accepts the tag name `%s`",
    (name) => {
      const { ir, diagnostics } = parse(`div\n  ${name}\n`);
      expect(diagnostics).toEqual([]);
      expect(ir).toBeDefined();
    },
  );
});
