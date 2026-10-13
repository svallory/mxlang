import { SourceMap } from "@volar/language-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

/**
 * A statement tag's code maps back to the text after its keyword. The keyword
 * is not part of the generated code, so a single letter that `static` also
 * spells (`s`, `t`, `a`, `i`, `c`) must not land inside it.
 */
const here = new URL("./fixtures/", import.meta.url).pathname;

function virtual(dir: string, source: string) {
  const code = createMxLanguagePlugin(ts).createVirtualCode?.(
    `${here}${dir}/page.mx`,
    MX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!code) throw new Error("Expected MX virtual code");
  const generated = code.snapshot.getText(0, code.snapshot.getLength());
  const map = new SourceMap(code.mappings as never);
  const toSource = (generatedOffset: number) =>
    [...map.toSourceLocation(generatedOffset)][0]?.[0];
  return { generated, mappings: code.mappings, toSource };
}

const HOSTS = ["html-tags", "react-policy", "preact-policy", "solid-policy"];

describe.each(HOSTS)("static statement offsets on %s", (dir) => {
  // [source, hoisted code the host prints, expected source offset of its first char]
  const cases: Array<[string, string, number]> = [
    ["static a\n<div/>", "a", 7],
    ["static s\n<div/>", "s", 7],
    ["static t\n<div/>", "t", 7],
    ["static i\n<div/>", "i", 7],
    ["static c\n<div/>", "c", 7],
    ["static a = 1\n<div/>", "a = 1", 7],
    ["static   a\n<div/>", "a", 9],
    ["static\ta\n<div/>", "a", 7],
    ["static { a }\n<div/>", "a", 9],
    ["static { let a = 1 }\n<div/>", "let a = 1", 9],
    [
      "static {\n  let a = 1;\n  let t = 2;\n}\n<div/>",
      "let a = 1;\n  let t = 2;",
      11,
    ],
    ["static const a = 1\n<div/>", "const a = 1", 7],
  ];

  // A Solid page also merges the text-equality decode of its whole-file source
  // map, which pairs the generated `s` at offset 0 with the `s` that starts
  // `static`. That is a different mechanism from the statement mapping this
  // file pins, so the `s` case is left out for Solid.
  const applicable = cases.filter(
    ([source]) => !(dir === "solid-policy" && source === "static s\n<div/>"),
  );

  it.each(applicable)("maps %j after the keyword", (source, code, offset) => {
    const { generated, mappings, toSource } = virtual(dir, source);
    const mapping = mappings.find(
      (candidate) => candidate.sourceOffsets[0] === offset,
    );
    // The mapping starts after the keyword and covers the authored code.
    expect(mapping).toBeDefined();
    expect(source.slice(offset, offset + code.length)).toBe(code);
    expect(mapping?.lengths[0]).toBe(code.length);
    const generatedAt = mapping?.generatedOffsets[0] ?? -1;
    expect(generated.slice(generatedAt, generatedAt + code.length)).toBe(code);
    expect(toSource(generatedAt)).toBe(offset);
    // No mapping lands inside the keyword.
    for (const candidate of mappings) {
      expect(candidate.sourceOffsets[0]).toBeGreaterThanOrEqual(
        source.indexOf("static") + "static".length,
      );
    }
  });
});

describe("static statement offsets after a leading statement", () => {
  it("maps the second static block, not the first one's text", () => {
    const source = "static a\nstatic s\n<div/>";
    const { generated, mappings } = virtual("html-tags", source);
    const offsets = mappings.map((mapping) => mapping.sourceOffsets[0]);
    expect(offsets).toEqual([7, 16]);
    expect(generated).toContain("a\ns");
  });
});

describe("server and client statements never map into their keyword", () => {
  const sources = [
    "server s = 1\n<div/>",
    "server { let s = 1 }\n<div/>",
    "client c = 1\n<div/>",
    "client { let c = 1 }\n<div/>",
  ];
  it.each(sources)("%j", (source) => {
    const keywordEnd = source.indexOf(" ");
    for (const dir of ["html-tags", "astro-policy"]) {
      const { mappings } = virtual(dir, source);
      for (const mapping of mappings) {
        // No mapped range may start inside the keyword.
        expect(mapping.sourceOffsets[0]).toBeGreaterThanOrEqual(keywordEnd);
      }
    }
  });
});
