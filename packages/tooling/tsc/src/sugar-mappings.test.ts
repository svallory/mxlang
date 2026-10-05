import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMxLanguagePlugin } from "@mxlang/typescript-plugin";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Decision 146 (PR 3): the TypeScript plugin maps each sugar token to the
 * generated attribute it stands for, with the token's exact source range:
 * `:email` to `name`, `.big` to `class`, `#main` to `id`, tag-adjacent
 * `<input:email>` included. (A TS error on the generated prop therefore lands
 * on the token the author wrote; `host-dispatch/sugar-typed` pins that through
 * `mx-tsc`.) The `host-dispatch` golden `sugar-preact` records the same
 * mappings as offsets; this reads them as text.
 */

const dir = join(
  import.meta.dirname,
  "fixtures",
  "host-dispatch",
  "sugar-preact",
);
const file = join(dir, "page.mx");
const source = readFileSync(file, "utf8");

function mapped(): [string, string][] {
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

describe("sugar tokens in the TypeScript plugin's mappings", () => {
  it("maps `:email`, `.big` and `#main` to name, class and id", () => {
    const pairs = mapped();
    expect(pairs).toContainEqual([":email", "name"]);
    expect(pairs).toContainEqual([".big", "class"]);
    expect(pairs).toContainEqual(["#main", "id"]);
  });

  it("maps both the tag-adjacent and the attribute-position `:email`", () => {
    expect(
      mapped().filter(([from, to]) => from === ":email" && to === "name"),
    ).toHaveLength(2);
  });
});

// Decision 146 addendum 4 (PR 4): the value after a sugar (`#x=input.v`) is the
// default attribute's value and keeps its exact source range.
describe("the default value after a sugar, in the TypeScript plugin's mappings", () => {
  const dir2 = join(
    import.meta.dirname,
    "fixtures",
    "host-dispatch",
    "sugar-default-value",
  );
  const file2 = join(dir2, "page.mx");
  const source2 = readFileSync(file2, "utf8");

  function mapped2(): [string, string][] {
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
      file2,
      "mx",
      ts.ScriptSnapshot.fromString(source2),
      {
        getAssociatedScript: () => undefined,
      },
    );
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    return virtual.mappings.map((mapping) => {
      const length = mapping.lengths[0] as number;
      const generatedLength = mapping.generatedLengths?.[0] ?? length;
      const from = mapping.sourceOffsets[0] as number;
      const to = mapping.generatedOffsets[0] as number;
      return [
        source2.slice(from, from + length),
        generated.slice(to, to + generatedLength),
      ];
    });
  }

  it("maps the sugar tokens and each value expression", () => {
    const pairs = mapped2();
    expect(pairs).toContainEqual(["#x", "id"]);
    expect(pairs).toContainEqual([":n", "name"]);
    expect(pairs).toContainEqual([".c", "class"]);
    expect(pairs).toContainEqual(["input.v", "input.v"]);
    expect(pairs).toContainEqual(["input.w", "input.w"]);
    expect(pairs).toContainEqual(["input.q", "input.q"]);
  });
});
