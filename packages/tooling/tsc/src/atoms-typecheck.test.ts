import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMxLanguagePlugin } from "@mxlang/typescript-plugin";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * Decision 156 in the type-check projection: core splices `"name"` at every
 * atom inside the authored expression slice (never `:a` verbatim in virtual
 * code), and maps each atom to its string literal, so a TypeScript error on a
 * misspelled atom lands on the atom the author wrote.
 */

const fixtures = join(import.meta.dirname, "fixtures", "atoms");

function virtualCode(file: string) {
  const source = readFileSync(file, "utf8");
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
  const pairs = virtual.mappings.flatMap((mapping) =>
    mapping.sourceOffsets.map((from, index) => {
      const length = mapping.lengths[index] as number;
      const to = mapping.generatedOffsets[index] as number;
      const generatedLength = mapping.generatedLengths?.[index] ?? length;
      return [
        source.slice(from, from + length),
        generated.slice(to, to + generatedLength),
      ];
    }),
  );
  return { generated, pairs };
}

describe("atoms in the TypeScript plugin's virtual code", () => {
  const { generated, pairs } = virtualCode(join(fixtures, "preact", "page.mx"));

  it("never holds an atom verbatim", () => {
    expect(generated).not.toMatch(/[[(,{\s]:(?:a|rename-all|hello|email)\b/);
    expect(generated).toContain('["a", "rename-all"]');
    expect(generated).toContain('"hello"');
  });

  it("maps each atom to its string literal", () => {
    expect(pairs).toContainEqual([":a", '"a"']);
    expect(pairs).toContainEqual([":rename-all", '"rename-all"']);
  });
});

describe("mx-tsc reports a misspelled whole-value atom", () => {
  it('`mode=:stirct` lands on its attribute, as `mode="stirct"` does', () => {
    const project = join(fixtures, "preact");
    const run = runInProcess(
      ["--noEmit", "--pretty", "false", "-p", join(project, "tsconfig.json")],
      project,
    );
    const lines = `${run.stdout}\n${run.stderr}`
      .split("\n")
      .filter((line) => line.includes("page.mx"));
    // 1-based. TypeScript reports a property's type error on the property
    // name, which maps to the attribute name (4,8). The nested atom in a
    // component prop (`modes=[:strict, :lose]`, line 5) is reported on the atom
    // itself (5,36): component prop values are mapped, per atom.
    expect(lines).toEqual([
      expect.stringMatching(/page\.mx\(4,8\): error TS2820: .*"stirct"/),
      expect.stringMatching(/page\.mx\(5,36\): error TS2820: .*"lose"/),
    ]);
    expect(run.status).not.toBe(0);
    // A whole mx-tsc run: 6.5 s seen under load, past the 5 s default.
  }, 60_000);
});
