import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";
import type { DataImport } from "./tree.ts";

/**
 * `tree.imports[].from` and `.names`: read from the Babel `ImportDeclaration`
 * the MX front end parsed (core's `Import.declaration`), never from the
 * statement text.
 */

const options = { structural: "reject", imports: "pass" } as const;

function importsOf(source: string): DataImport[] {
  const result = parseData(source, "/t.mx", options);
  expect(result.diagnostics).toEqual([]);
  return result.tree?.imports ?? [];
}

describe("DataImport.from / names", () => {
  it("default import", () => {
    const [entry] = importsOf(`import Icon from "./icon.mx"\n<x/>\n`);
    expect(entry?.from).toBe("./icon.mx");
    expect(entry?.names).toEqual([
      { imported: "default", local: "Icon", kind: "default" },
    ]);
    expect(entry && "typeOnly" in entry).toBe(false);
  });

  it("named imports, with and without an alias", () => {
    const [entry] = importsOf(`import { a, b as c } from "m"\n<x/>\n`);
    expect(entry?.from).toBe("m");
    expect(entry?.names).toEqual([
      { imported: "a", local: "a", kind: "named" },
      { imported: "b", local: "c", kind: "named" },
    ]);
  });

  it("namespace import", () => {
    const [entry] = importsOf(`import * as ns from "m"\n<x/>\n`);
    expect(entry?.names).toEqual([
      { imported: "*", local: "ns", kind: "namespace" },
    ]);
  });

  it("mixed: default first, then the named ones, in written order", () => {
    const [entry] = importsOf(`import d, { z, a as b } from "m"\n<x/>\n`);
    expect(entry?.names).toEqual([
      { imported: "default", local: "d", kind: "default" },
      { imported: "z", local: "z", kind: "named" },
      { imported: "a", local: "b", kind: "named" },
    ]);
    const [withNamespace] = importsOf(`import d, * as ns from "m"\n<x/>\n`);
    expect(withNamespace?.names).toEqual([
      { imported: "default", local: "d", kind: "default" },
      { imported: "*", local: "ns", kind: "namespace" },
    ]);
  });

  it("type-only: `import type` flags the entry, `{ type X }` flags the name", () => {
    const [whole, inline] = importsOf(
      `import type { T, U as V } from "t"\nimport { type W, x } from "t"\n<x/>\n`,
    );
    expect(whole?.typeOnly).toBe(true);
    expect(whole?.names).toEqual([
      { imported: "T", local: "T", kind: "named" },
      { imported: "U", local: "V", kind: "named" },
    ]);
    expect(inline && "typeOnly" in inline).toBe(false);
    expect(inline?.names).toEqual([
      { imported: "W", local: "W", kind: "named", typeOnly: true },
      { imported: "x", local: "x", kind: "named" },
    ]);
  });

  it("type-only default and namespace", () => {
    const [def, ns] = importsOf(
      `import type D from "t"\nimport type * as N from "t"\n<x/>\n`,
    );
    expect(def?.typeOnly).toBe(true);
    expect(def?.names).toEqual([
      { imported: "default", local: "D", kind: "default" },
    ]);
    expect(ns?.typeOnly).toBe(true);
    expect(ns?.names).toEqual([
      { imported: "*", local: "N", kind: "namespace" },
    ]);
  });

  it("multi-line import with comments inside", () => {
    const source = `import {\n  a, // first\n  b as c,\n  /* third */ d,\n} from\n  './m.ts'\n<x/>\n`;
    const [entry] = importsOf(source);
    expect(entry?.from).toBe("./m.ts");
    expect(entry?.names.map((n) => [n.imported, n.local])).toEqual([
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
    expect(entries.map((e) => [e.from, e.names.map((n) => n.local)])).toEqual([
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
    expect(str?.names).toEqual([
      { imported: "a-b", local: "ab", kind: "named" },
    ]);
    expect(json?.from).toBe("./d.json");
  });

  it("pins the exact entry shape and leaves code and span as before", () => {
    const source = `import d, { a as b } from "m"\n<x/>\n`;
    expect(importsOf(source)).toEqual([
      {
        code: `import d, { a as b } from "m"`,
        span: { sourceStart: 0, sourceEnd: 29 },
        from: "m",
        names: [
          { imported: "default", local: "d", kind: "default" },
          { imported: "a", local: "b", kind: "named" },
        ],
      },
    ]);
  });

  it("is plain data: JSON round-trips and carries no Babel node", () => {
    const entries = importsOf(`import d, { type a } from "m"\n<x/>\n`);
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});

describe("DataImport.from: string-literal escapes", () => {
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
  ])("%s is a positioned error, no tree", (_, source, message, line) => {
    const result = parseData(source, "/t.mx", options);
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      message,
      line,
      column: 0,
    });
  });
});
