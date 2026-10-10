import { describe, expect, it } from "vitest";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

/**
 * `lowerSource`'s `imports: "pass" | "reject"` option: under
 * `structural: "reject"` a consumer can still let top-level `import`s through
 * and gets them back verbatim as `ir.imports`.
 */

const STATIC = (construct: string) =>
  `the data tree is static; this file's consumer does not evaluate ${construct}`;

function lower(source: string, options: LowerSourceOptions) {
  return lowerSource(source, "/t.mx", options);
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
    const result = lower(source, options);
    expect(result.diagnostics).toEqual([]);
    const imports = result.ir?.imports;
    expect(imports?.map((i) => i.code)).toEqual([
      `import a from "a"`,
      `import { b, c } from "./b.ts"`,
      `import type { T } from "t"`,
    ]);
    for (const entry of imports ?? []) {
      expect(slice(source, entry.span)).toBe(entry.code);
    }
    // The imports are not repeated among the other module-level statements.
    expect(result.ir?.hoisted).toEqual([]);
    expect(result.ir?.body).toHaveLength(1);
  });

  it("imports interleaved with the tag are still in file order", () => {
    const source = `import a from "a"\n<x/>\nimport b from "b"\n`;
    const imports = lower(source, options).ir?.imports;
    expect(imports?.map((i) => slice(source, i.span))).toEqual([
      `import a from "a"`,
      `import b from "b"`,
    ]);
  });

  it("a file with no import has an empty list", () => {
    expect(lower(`<x/>\n`, options).ir?.imports).toEqual([]);
  });

  it("control flow stays rejected", () => {
    const result = lower(`import a from "a"\n<if=a>t</if>\n`, options);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`<if>`"));
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("export and static stay rejected", () => {
    const result = lower(
      `import a from "a"\nexport const e = 1\n<x/>\n`,
      options,
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`export`"));
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("an import inside a tag body is body text, not an import", () => {
    const source = `<x>\n  import a from "a"\n</x>\n`;
    const result = lower(source, options);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.message).toBe(STATIC("text"));
    expect(result.diagnostics[0]?.line).toBe(2);
    // `imports` never sees it: with `structural: "pass"` it is plain text,
    // even under `imports: "reject"`.
    const text = lower(source, { imports: "reject" });
    expect(text.diagnostics).toEqual([]);
    expect(text.ir?.imports).toEqual([]);
  });

  it("keeps import attributes, multi-line and side-effect imports verbatim", () => {
    const source = `import data from "./d.json" with { type: "json" }\nimport {\n  a,\n  b,\n} from "./m.ts"\nimport "./side.ts"\n<x/>\n`;
    const imports = lower(source, options).ir?.imports;
    expect(imports?.map((i) => i.code)).toEqual([
      `import data from "./d.json" with { type: "json" }`,
      `import {\n  a,\n  b,\n} from "./m.ts"`,
      `import "./side.ts"`,
    ]);
    for (const entry of imports ?? []) {
      expect(slice(source, entry.span)).toBe(entry.code);
    }
  });

  it("CRLF: spans slice the authored text, line terminators excluded", () => {
    const source = `import a from "a"\r\nimport b from "b"\r\n<x/>\r\n`;
    const imports = lower(source, options).ir?.imports ?? [];
    expect(imports.map((i) => slice(source, i.span))).toEqual([
      `import a from "a"`,
      `import b from "b"`,
    ]);
    expect(imports[1]?.span.sourceStart).toBe(source.indexOf("import b"));
  });

  it("UTF-16: a non-ASCII line before the import shifts spans by code units", () => {
    // `😀` is two UTF-16 code units, `é` one.
    const source = `<x a="😀 é"/>\nimport a from "a"\n`;
    const result = lower(source, options);
    expect(result.diagnostics).toEqual([]);
    const [entry] = result.ir?.imports ?? [];
    expect(entry?.span.sourceStart).toBe(source.indexOf("import"));
    expect(slice(source, entry?.span ?? { sourceStart: 0, sourceEnd: 0 })).toBe(
      `import a from "a"`,
    );
  });
});

describe("imports: option defaults and reject", () => {
  it("defaults to the structural value: reject rejects an import", () => {
    const source = `import a from "a"\n<x/>\n`;
    const result = lower(source, { structural: "reject" });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`import`"));
  });

  it('explicit imports: "reject" matches the structural: "reject" default', () => {
    const result = lower(`import a from "a"\n<x/>\n`, {
      structural: "reject",
      imports: "reject",
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe(STATIC("`import`"));
  });

  // The data tree listed imports under `statements` here and only added a
  // separate `imports` list for `structural: "reject"`; the IR has one list.
  it("structural: pass keeps imports in `ir.imports`", () => {
    const ir = lower(`import a from "a"\n<x/>\n`, {}).ir;
    expect(ir?.imports.map((s) => s.code)).toEqual([`import a from "a"`]);
    expect(ir?.hoisted).toEqual([]);
  });

  it('structural: pass + imports: "reject" rejects only the import', () => {
    const ok = lower(`<if=a>t</if>\nexport const e = 1\n`, {
      imports: "reject",
    });
    expect(ok.diagnostics).toEqual([]);
    const bad = lower(`<if=a>t</if>\nimport a from "a"\n`, {
      imports: "reject",
    });
    expect(bad.ir).toBeUndefined();
    expect(bad.diagnostics[0]?.message).toBe(STATIC("`import`"));
    expect(bad.diagnostics[0]?.line).toBe(2);
  });

  it('structural: pass + imports: "pass" is the default shape', () => {
    const ir = lower(`import a from "a"\n<x/>\n`, { imports: "pass" }).ir;
    expect(ir?.imports).toHaveLength(1);
    expect(ir?.hoisted).toEqual([]);
  });
});
