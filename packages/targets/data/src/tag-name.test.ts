import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

/**
 * Core rejects a tag name outside Marko's charset (`lower.ts` `TAG_NAME`), next
 * to the attribute-name check. The tree target surfaces it as a positioned
 * diagnostic instead of a child tag named `&title`.
 */
function parse(source: string) {
  return parseData(source, "x.mesh.mx");
}

describe("invalid tag names (tree target)", () => {
  it("rejects `&title` under a parent, at the name", () => {
    const { tree, diagnostics } = parse("div\n  &title\n");
    expect(tree).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 2,
      column: 2,
    });
    expect(diagnostics[0]?.message).toContain(
      "Invalid tag name `&title`; Marko rejects it too — a tag name may use letters, digits and `-._:`",
    );
  });

  it("rejects `&amount=qty * price` on the tag name", () => {
    const { tree, diagnostics } = parse("div\n  &amount=qty * price\n");
    expect(tree).toBeUndefined();
    expect(diagnostics[0]?.message).toContain("Invalid tag name `&amount`");
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 2 });
  });

  it("keeps `&dueOn` as an attribute-name error, parallel to the tag-name one", () => {
    const { tree, diagnostics } = parse("entity sort asc &dueOn\n");
    expect(tree).toBeUndefined();
    expect(diagnostics[0]?.message).toContain(
      "Invalid attribute name `&dueOn`",
    );
    expect(diagnostics[0]?.message).toContain("Marko rejects it too");
  });

  it.each(["a-b", "a.b", "a:b", "a_b", "a$b"])(
    "accepts the tag name `%s`",
    (name) => {
      const { tree, diagnostics } = parse(`div\n  ${name}\n`);
      expect(diagnostics).toEqual([]);
      expect(tree).toBeDefined();
    },
  );
});
