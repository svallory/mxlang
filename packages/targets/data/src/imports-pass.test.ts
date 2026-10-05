import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

/**
 * `parseData`'s `imports: "pass" | "reject"` option: under
 * `structural: "reject"` a consumer can still let top-level `import`s through
 * and gets them back verbatim as `tree.imports`.
 */

const STATIC = (construct: string) =>
  `the data tree is static; this file's consumer does not evaluate ${construct}`;

function parse(source: string, options: Parameters<typeof parseData>[2]) {
  return parseData(source, "/t.mx", options);
}

function slice(
  source: string,
  span: { sourceStart: number; sourceEnd: number },
) {
  return source.slice(span.sourceStart, span.sourceEnd);
}

describe('imports: "pass" with structural: "reject"', () => {
  const options = { structural: "reject", imports: "pass" } as const;

  it("returns each top-level import verbatim, in file order, with spans", () => {
    const source = `import a from "a"\nimport { b, c } from "./b.ts"\nimport type { T } from "t"\n<x a=1/>\n`;
    const result = parse(source, options);
    expect(result.diagnostics).toEqual([]);
    const imports = result.tree?.imports;
    expect(imports?.map((i) => i.code)).toEqual([
      `import a from "a"`,
      `import { b, c } from "./b.ts"`,
      `import type { T } from "t"`,
    ]);
    for (const entry of imports ?? []) {
      expect(slice(source, entry.span)).toBe(entry.code);
    }
    expect(result.tree?.statements).toEqual([]);
    expect(result.tree?.children).toHaveLength(1);
  });

  it("imports interleaved with the tag are still in file order", () => {
    const source = `import a from "a"\n<x/>\nimport b from "b"\n`;
    const imports = parse(source, options).tree?.imports;
    expect(imports?.map((i) => slice(source, i.span))).toEqual([
      `import a from "a"`,
      `import b from "b"`,
    ]);
  });

  it("a file with no import has an empty list", () => {
    expect(parse(`<x/>\n`, options).tree?.imports).toEqual([]);
  });

  it("control flow stays rejected", () => {
    const result = parse(`import a from "a"\n<if=a>t</if>\n`, options);
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`<if>`"));
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("export and static stay rejected", () => {
    const result = parse(
      `import a from "a"\nexport const e = 1\n<x/>\n`,
      options,
    );
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`export`"));
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("an import inside a tag body is still an error", () => {
    const result = parse(`<x>\n  import a from "a"\n</x>\n`, options);
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("CRLF: spans slice the authored text, line terminators excluded", () => {
    const source = `import a from "a"\r\nimport b from "b"\r\n<x/>\r\n`;
    const imports = parse(source, options).tree?.imports ?? [];
    expect(imports.map((i) => slice(source, i.span))).toEqual([
      `import a from "a"`,
      `import b from "b"`,
    ]);
    expect(imports[1]?.span.sourceStart).toBe(source.indexOf("import b"));
  });

  it("UTF-16: a non-ASCII line before the import shifts spans by code units", () => {
    // `😀` is two UTF-16 code units, `é` one.
    const source = `<x a="😀 é"/>\nimport a from "a"\n`;
    const result = parse(source, options);
    expect(result.diagnostics).toEqual([]);
    const [entry] = result.tree?.imports ?? [];
    expect(entry?.span.sourceStart).toBe(source.indexOf("import"));
    expect(slice(source, entry?.span ?? { sourceStart: 0, sourceEnd: 0 })).toBe(
      `import a from "a"`,
    );
  });
});

describe("imports: option defaults and reject", () => {
  it("defaults to the structural value: reject rejects an import", () => {
    const source = `import a from "a"\n<x/>\n`;
    const result = parse(source, { structural: "reject" });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`import`"));
  });

  it('explicit imports: "reject" matches the structural: "reject" default', () => {
    const result = parse(`import a from "a"\n<x/>\n`, {
      structural: "reject",
      imports: "reject",
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`import`"));
  });

  it("structural: pass keeps imports in statements and adds no `imports`", () => {
    const tree = parse(`import a from "a"\n<x/>\n`, {}).tree;
    expect(tree?.statements.map((s) => s.code)).toEqual([`import a from "a"`]);
    expect(tree && "imports" in tree).toBe(false);
  });

  it('structural: pass + imports: "reject" rejects only the import', () => {
    const ok = parse(`<if=a>t</if>\nexport const e = 1\n`, {
      imports: "reject",
    });
    expect(ok.diagnostics).toEqual([]);
    const bad = parse(`<if=a>t</if>\nimport a from "a"\n`, {
      imports: "reject",
    });
    expect(bad.tree).toBeUndefined();
    expect(bad.diagnostics[0]?.message).toBe(STATIC("`import`"));
    expect(bad.diagnostics[0]?.line).toBe(2);
  });

  it('structural: pass + imports: "pass" is the default shape', () => {
    const tree = parse(`import a from "a"\n<x/>\n`, { imports: "pass" }).tree;
    expect(tree?.statements).toHaveLength(1);
    expect(tree && "imports" in tree).toBe(false);
  });
});
