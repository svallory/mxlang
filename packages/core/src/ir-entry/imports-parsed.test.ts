import { describe, expect, it } from "vitest";
import { lowerSource, type SpannedIr } from "./index.ts";

/**
 * `ir.imports[].from` and `.names`: read from the Babel `ImportDeclaration`
 * the MX front end parsed (core's `Import.declaration`), never from the
 * statement text.
 */

const options = { structural: "reject", imports: "pass" } as const;

type ImportNode = SpannedIr["imports"][number];

function importsOf(source: string): ImportNode[] {
  const result = lowerSource(source, "/t.mx", options);
  expect(result.diagnostics).toEqual([]);
  return result.ir?.imports ?? [];
}

/** An authored import always carries `names` (empty for a side-effect import). */
function namesOf(entry: ImportNode | undefined) {
  return entry?.names ?? [];
}

describe("Import.from / names", () => {
  it("default import", () => {
    const [entry] = importsOf(`import Icon from "./icon.mx"\n<x/>\n`);
    expect(entry?.from).toBe("./icon.mx");
    expect(namesOf(entry)).toMatchObject([
      { imported: "default", local: "Icon", kind: "default" },
    ]);
    expect(entry && "typeOnly" in entry).toBe(false);
  });

  it("named imports, with and without an alias", () => {
    const [entry] = importsOf(`import { a, b as c } from "m"\n<x/>\n`);
    expect(entry?.from).toBe("m");
    expect(namesOf(entry)).toMatchObject([
      { imported: "a", local: "a", kind: "named" },
      { imported: "b", local: "c", kind: "named" },
    ]);
  });

  it("namespace import", () => {
    const [entry] = importsOf(`import * as ns from "m"\n<x/>\n`);
    expect(namesOf(entry)).toMatchObject([
      { imported: "*", local: "ns", kind: "namespace" },
    ]);
  });

  it("mixed: default first, then the named ones, in written order", () => {
    const [entry] = importsOf(`import d, { z, a as b } from "m"\n<x/>\n`);
    expect(namesOf(entry)).toMatchObject([
      { imported: "default", local: "d", kind: "default" },
      { imported: "z", local: "z", kind: "named" },
      { imported: "a", local: "b", kind: "named" },
    ]);
    const [withNamespace] = importsOf(`import d, * as ns from "m"\n<x/>\n`);
    expect(namesOf(withNamespace)).toMatchObject([
      { imported: "default", local: "d", kind: "default" },
      { imported: "*", local: "ns", kind: "namespace" },
    ]);
  });

  it("type-only: `import type` flags the entry, `{ type X }` flags the name", () => {
    const [whole, inline] = importsOf(
      `import type { T, U as V } from "t"\nimport { type W, x } from "t"\n<x/>\n`,
    );
    expect(whole?.typeOnly).toBe(true);
    expect(namesOf(whole)).toMatchObject([
      { imported: "T", local: "T", kind: "named" },
      { imported: "U", local: "V", kind: "named" },
    ]);
    expect(inline && "typeOnly" in inline).toBe(false);
    expect(namesOf(inline)).toMatchObject([
      { imported: "W", local: "W", kind: "named", typeOnly: true },
      { imported: "x", local: "x", kind: "named" },
    ]);
  });

  it("type-only default and namespace", () => {
    const [def, ns] = importsOf(
      `import type D from "t"\nimport type * as N from "t"\n<x/>\n`,
    );
    expect(def?.typeOnly).toBe(true);
    expect(namesOf(def)).toMatchObject([
      { imported: "default", local: "D", kind: "default" },
    ]);
    expect(ns?.typeOnly).toBe(true);
    expect(namesOf(ns)).toMatchObject([
      { imported: "*", local: "N", kind: "namespace" },
    ]);
  });

  it("multi-line import with comments inside", () => {
    const source = `import {\n  a, // first\n  b as c,\n  /* third */ d,\n} from\n  './m.ts'\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(entry?.from).toBe("./m.ts");
    expect(namesOf(entry).map((n) => [n.imported, n.local])).toEqual([
      ["a", "a"],
      ["b", "c"],
      ["d", "d"],
    ]);
    expect(source.slice(entry?.span.sourceStart, entry?.span.sourceEnd)).toBe(
      entry?.code,
    );
  });

  it("two imports of the same module stay two entries, in file order", () => {
    const entries = importsOf(
      `import a from "m"\n<x/>\nimport { b } from 'm'\n`,
    );
    expect(
      entries.map((e) => [e.from, namesOf(e).map((n) => n.local)]),
    ).toEqual([
      ["m", ["a"]],
      ["m", ["b"]],
    ]);
  });

  it("side-effect import has no names", () => {
    const [entry] = importsOf(`import "./side.ts"\n<x/>\n`);
    expect(entry?.from).toBe("./side.ts");
    expect(entry?.names).toEqual([]);
  });

  it("string-literal export name and import attributes", () => {
    const [str, json] = importsOf(
      `import { "a-b" as ab } from "m"\nimport data from "./d.json" with { type: "json" }\n<x/>\n`,
    );
    expect(namesOf(str)).toMatchObject([
      { imported: "a-b", local: "ab", kind: "named" },
    ]);
    expect(json?.from).toBe("./d.json");
  });

  it("pins the exact entry shape and leaves code and span as before", () => {
    const source = `import d, { a as b } from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(importsOf(source)).toHaveLength(1);
    expect(entry).toMatchObject({
      kind: "Import",
      code: `import d, { a as b } from "m"`,
      span: { sourceStart: 0, sourceEnd: 29 },
      from: "m",
    });
    // `names` is pinned with `toEqual`: no field beyond the ones listed.
    expect(entry?.names).toEqual([
      {
        imported: "default",
        local: "d",
        kind: "default",
        span: { sourceStart: 7, sourceEnd: 8 },
      },
      {
        imported: "a",
        local: "b",
        kind: "named",
        span: { sourceStart: 12, sourceEnd: 13 },
        localSpan: { sourceStart: 17, sourceEnd: 18 },
      },
    ]);
  });

  it("`names` is plain data: JSON round-trips and carries no Babel node", () => {
    const [entry] = importsOf(`import d, { type a } from "m"\n<x/>\n`);
    const names = namesOf(entry);
    expect(JSON.parse(JSON.stringify(names))).toEqual(names);
  });
});

/** The text a name's span slices out of `source`. */
function slice(
  source: string,
  span: { sourceStart: number; sourceEnd: number },
) {
  return source.slice(span.sourceStart, span.sourceEnd);
}

describe("ImportName.span / localSpan", () => {
  it("default: the binding", () => {
    const source = `import Icon from "./icon.mx"\n<x/>\n`;
    const [entry] = importsOf(source);
    const [name] = namesOf(entry);
    expect(slice(source, name?.span as never)).toBe("Icon");
    expect(name && "localSpan" in name).toBe(false);
  });

  it("named: the imported name, no localSpan without an alias", () => {
    const source = `import { a,  b } from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(namesOf(entry).map((n) => slice(source, n.span))).toEqual([
      "a",
      "b",
    ]);
    expect(namesOf(entry).some((n) => "localSpan" in n)).toBe(false);
  });

  it("aliased: span is the imported name, localSpan the alias", () => {
    const source = `import { first as one,\n  second as two } from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(
      namesOf(entry).map((n) => [
        slice(source, n.span),
        n.localSpan && slice(source, n.localSpan),
      ]),
    ).toEqual([
      ["first", "one"],
      ["second", "two"],
    ]);
  });

  it("an alias spelled like the name still has a localSpan; no `as` has none", () => {
    const source = `import { a as a, "b" as b, c } from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    const names = namesOf(entry);
    expect(
      names.map((n) => [
        slice(source, n.span),
        n.localSpan && slice(source, n.localSpan),
      ]),
    ).toEqual([
      ["a", "a"],
      ['"b"', "b"],
      ["c", undefined],
    ]);
    expect(names[0]?.localSpan?.sourceStart).not.toBe(
      names[0]?.span.sourceStart,
    );
    expect(names[2] && "localSpan" in names[2]).toBe(false);
  });

  it("namespace: the binding after `* as`", () => {
    const source = `import * as ns from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(slice(source, namesOf(entry)[0]?.span as never)).toBe("ns");
  });

  it("mixed default and namespace", () => {
    const source = `import d, * as ns from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(namesOf(entry).map((n) => slice(source, n.span))).toEqual([
      "d",
      "ns",
    ]);
  });

  it("`type` specifiers: the span leaves the keyword out", () => {
    const source = `import { type W, type U as V } from "t"\nimport type T from "t"\nimport type * as N from "t"\n<x/>\n`;
    const [inline, whole, ns] = importsOf(source);
    expect(namesOf(inline).map((n) => slice(source, n.span))).toEqual([
      "W",
      "U",
    ]);
    expect(slice(source, namesOf(inline)[1]?.localSpan as never)).toBe("V");
    expect(slice(source, namesOf(whole)[0]?.span as never)).toBe("T");
    expect(slice(source, namesOf(ns)[0]?.span as never)).toBe("N");
  });

  it("string-literal export name: the literal, quotes included", () => {
    const source = `import { "a-b" as ab } from "m"\n<x/>\n`;
    const [entry] = importsOf(source);
    const [name] = namesOf(entry);
    expect(slice(source, name?.span as never)).toBe('"a-b"');
    expect(slice(source, name?.localSpan as never)).toBe("ab");
  });

  it("offsets are UTF-16 and file-absolute after earlier lines and emoji", () => {
    const source = `<x/>\n// 😀\nimport { é as ü } from "m"\n`;
    const [entry] = importsOf(source);
    const [name] = namesOf(entry);
    expect(slice(source, name?.span as never)).toBe("é");
    expect(slice(source, name?.localSpan as never)).toBe("ü");
  });
});

describe("Import.from: string-literal escapes", () => {
  it("reads the cooked value, not the source text", () => {
    const entries = importsOf(
      `import a from "./a\\"bA.mx"\nimport b from './it\\'s'\n<x/>\n`,
    );
    expect(entries.map((e) => e.from)).toEqual(['./a"bA.mx', "./it's"]);
  });
});

describe("an import that is not one ES import declaration", () => {
  const NOT_ES =
    'an `import` statement must be one ES import declaration (`import … from "…"`); `import x = …` and several statements in one `import` are not supported';
  const FLOW =
    "`import typeof` is Flow syntax; MX is TypeScript. Use `import type` for an import that binds no value";

  it.each([
    ["import-equals", `import x = M.N\n<x/>\n`, NOT_ES, 1],
    [
      "two statements on one line",
      `<x/>\nimport a from "a"; import b from "b"\n`,
      NOT_ES,
      2,
    ],
    [
      "a continued line",
      `import a from "a"\n  import x = M.N\n<x/>\n`,
      NOT_ES,
      1,
    ],
    ["require on line 2", `<x/>\nimport x = require("y")\n`, NOT_ES, 2],
    [
      "type require on line 3",
      `<x/>\n<x/>\nimport type X = require("y")\n`,
      NOT_ES,
      3,
    ],
    ["import typeof", `<x/>\nimport typeof T from "m"\n`, FLOW, 2],
  ])("%s is a positioned error, no IR", (_, source, message, line) => {
    const result = lowerSource(source, "/t.mx", options);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      message,
      line,
      column: 0,
    });
  });
});
