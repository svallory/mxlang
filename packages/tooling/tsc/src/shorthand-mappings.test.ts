import { join } from "node:path";
import { createMxLanguagePlugin } from "@mxlang/typescript-plugin";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The TypeScript plugin maps each tag-adjacent shorthand token to the
 * generated attribute it stands for, with the token's exact source range:
 * `.big` to `class`, `#main` to `id`. A `:` reads as stock Marko reads it: in
 * a tag head it is part of the tag name (`<input:email>`), and an
 * attribute-position `:email` is the default attribute's `value:email`, so it
 * maps to `value:email`, never to a generated `name`.
 */

// A file in the `preact` fixture directory: its package.json picks the host.
const file = join(
  import.meta.dirname,
  "fixtures",
  "host-dispatch",
  "preact",
  "shorthand-mappings.mx",
);

function mapped(source: string): [string, string][] {
  const plugin = createMxLanguagePlugin(ts) as unknown as {
    createVirtualCode(
      fileName: string,
      languageId: string,
      snapshot: ts.IScriptSnapshot,
      ctx: unknown,
    ): {
      snapshot: ts.IScriptSnapshot;
      mappings: {
        sourceOffsets: number[];
        lengths: number[];
        generatedOffsets: number[];
        generatedLengths?: number[];
      }[];
    };
  };
  const virtual = plugin.createVirtualCode(
    file,
    "mx",
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
  return virtual.mappings.map((mapping) => {
    const length = mapping.lengths[0] as number;
    const generatedLength = mapping.generatedLengths?.[0] ?? length;
    const from = mapping.sourceOffsets[0] as number;
    const to = mapping.generatedOffsets[0] as number;
    return [
      source.slice(from, from + length),
      generated.slice(to, to + generatedLength),
    ];
  });
}

describe("shorthand tokens in the TypeScript plugin's mappings", () => {
  it("maps the tag-adjacent `.big` and `#main` to class and id", () => {
    const pairs = mapped('<input.big#main type="email"/>\n');
    expect(pairs).toContainEqual([".big", "class"]);
    expect(pairs).toContainEqual(["#main", "id"]);
  });

  it("maps the shorthand's value expression after a default value", () => {
    const pairs = mapped("<input#x=input.v/>\n");
    expect(pairs).toContainEqual(["#x", "id"]);
    expect(pairs).toContainEqual(["input.v", "input.v"]);
  });

  it("maps `:email` to `value:email`, never to `name`", () => {
    const pairs = mapped('<input :email/>\n<input type="email"/>\n');
    expect(pairs).toContainEqual([":email", "value:email"]);
    expect(pairs.filter(([, to]) => to === "name")).toEqual([]);
  });
});
