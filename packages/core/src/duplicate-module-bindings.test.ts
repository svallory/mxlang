// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * The module statements (`import`, `static`, `server`, `client`, `export`; the
 * block and the block-less form) share one module scope, so a name is declared
 * once across all of them. The rule is JavaScript's, applied after the
 * TypeScript strip:
 *
 * - two `var`s of a name are fine;
 * - so are the merges TypeScript itself accepts (enum with enum or namespace,
 *   a namespace after a function, class, enum or namespace, function overloads,
 *   `declare` ones included);
 * - a type-only name (`type`, `interface`, `import type`) is not a value, so it
 *   never collides;
 * - any other second declaration is refused at its name with
 *   `MX_DUPLICATE_DECLARATION`, in source order.
 *
 * An export list (`export { q }`) naming a binding no module statement
 * declares is refused at the name with `MX_UNDECLARED_EXPORT`: the module it
 * would make cannot load. Declared anywhere counts, before or after it, type
 * or value, ambient or not. A re-export and a type export bind nothing local.
 *
 * Every row was probed on the stock parser (Marko 6.4.4) and through node
 * (`probes/duplicate-module-bindings-7cfaa606/`); positions below are
 * 1-based lines and 0-based columns, as `lowerSource` reports them.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

const DUPLICATE = "MX_DUPLICATE_DECLARATION";
const UNDECLARED = "MX_UNDECLARED_EXPORT";
const RENDER_ONLY = "MX_RENDER_ONLY_IN_MODULE";

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-duplicate-bindings-")));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function diagnostics(
  source: string,
  tagRules: "html" | "markup" | "none" = "html",
) {
  return lowerSource(`${source}\n<div/>\n`, join(dir, "page.mx"), { tagRules })
    .diagnostics;
}

const OURS = [DUPLICATE, UNDECLARED];

/** Our codes' diagnostics only. */
function ours(source: string, tagRules: "html" | "markup" | "none" = "html") {
  return diagnostics(source, tagRules).filter(
    (d) => d.code !== undefined && OURS.includes(d.code),
  );
}

/**
 * Expects exactly one error in `source`, with `code`, at `name` on `line`
 * (1-based) at `column` (0-based), ending where the name does.
 */
function expectRefused(
  source: string,
  code: string,
  name: string,
  line: number,
  column: number,
) {
  const text = source.split("\n")[line - 1] ?? "";
  expect(text.startsWith(name, column), `${name} at ${line}:${column}`).toBe(
    true,
  );
  const all = diagnostics(source).filter((d) => d.severity === "error");
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({
    code,
    line,
    column,
    end: { line, column: column + name.length },
  });
  return all[0] as { message: string };
}

function expectCompiles(source: string) {
  expect(diagnostics(source).filter((d) => d.severity === "error")).toEqual([]);
}

describe("a module name declared twice is refused at the second declaration", () => {
  const X = 'import x from "./x"';
  const A = 'import { a } from "./m"';
  // [label, source, name, line, column]
  const rows: [string, string, string, number, number][] = [
    ["import + static import", `${X}\nstatic import x from "./x"`, "x", 2, 14],
    [
      "import + static block import",
      `${X}\nstatic { import x from "./x" }`,
      "x",
      2,
      16,
    ],
    ["import + server import", `${X}\nserver import x from "./x"`, "x", 2, 14],
    ["import + client import", `${X}\nclient import x from "./x"`, "x", 2, 14],
    ["import + import", `${X}\n${X}`, "x", 2, 7],
    [
      "named import + static import",
      `${A}\nstatic import { a } from "./m"`,
      "a",
      2,
      16,
    ],
    [
      "named import + renamed import",
      `${A}\nimport { b as a } from "./m"`,
      "a",
      2,
      14,
    ],
    ["import + static const", `${X}\nstatic const x = 1`, "x", 2, 13],
    [
      "namespace import + static const",
      'import * as ns from "./m"\nstatic const ns = 1',
      "ns",
      2,
      13,
    ],
    [
      "static const twice",
      "static const q = 1\nstatic const q = 2",
      "q",
      2,
      13,
    ],
    [
      "static const + server const",
      "static const q = 1\nserver const q = 2",
      "q",
      2,
      13,
    ],
    [
      "static const + client const",
      "static const q = 1\nclient const q = 2",
      "q",
      2,
      13,
    ],
    [
      "server const + client const",
      "server const q = 1\nclient const q = 2",
      "q",
      2,
      13,
    ],
    [
      "server const twice",
      "server const q = 1\nserver const q = 2",
      "q",
      2,
      13,
    ],
    [
      "static const + static block const",
      "static const q = 1\nstatic { const q = 2 }",
      "q",
      2,
      15,
    ],
    [
      "static block const twice",
      "static { const q = 1 }\nstatic { const q = 2 }",
      "q",
      2,
      15,
    ],
    [
      "static block class + client block class",
      "static { class C {} }\nclient { class C {} }",
      "C",
      2,
      15,
    ],
    [
      "static let + static var",
      "static let v = 1\nstatic var v = 2",
      "v",
      2,
      11,
    ],
    [
      "static class + static const",
      "static class C {}\nstatic const C = 1",
      "C",
      2,
      13,
    ],
    [
      "static const + static function",
      "static const f = 1\nstatic function f() {}",
      "f",
      2,
      16,
    ],
    [
      "destructured name + const",
      "static const { a } = { a: 1 }\nstatic const a = 2",
      "a",
      2,
      13,
    ],
    [
      "export const + static const",
      "export const q = 1\nstatic const q = 2",
      "q",
      2,
      13,
    ],
    [
      "static export const + server const",
      "static export const q = 1\nserver const q = 2",
      "q",
      2,
      13,
    ],
    [
      "static declare const + static const",
      "static declare const d: number\nstatic const d = 1",
      "d",
      2,
      13,
    ],
    [
      "the third of three statements",
      `${X}\nstatic const y = 1\nserver const x = 2`,
      "x",
      3,
      13,
    ],
    [
      "a later line of a multi-line block",
      `${X}\n\nstatic {\n  const y = 1\n  const x = 2\n}`,
      "x",
      5,
      8,
    ],
    // The five forms stock Marko compiles and node then refuses to load
    // ("Identifier 'f' has already been declared"): MX refuses them (one
    // divergences.md row).
    [
      "function + function (stock compiles it)",
      "static function f() {}\nstatic function f() {}",
      "f",
      2,
      16,
    ],
    [
      "function + var (stock compiles it)",
      "static function f() {}\nstatic var f = 1",
      "f",
      2,
      11,
    ],
    ["var + import (stock compiles it)", `static var x = 1\n${X}`, "x", 2, 7],
    [
      "function + const (stock compiles it)",
      "static function f() {}\nstatic const f = 1",
      "f",
      2,
      13,
    ],
    [
      "export function + static const (stock compiles it)",
      "export function f() {}\nstatic const f = 1",
      "f",
      2,
      13,
    ],
    // Stock Marko crashes on an enum parent; the rule refuses it.
    [
      "enum + const (stock crashes)",
      "static enum E { A }\nstatic const E = 1",
      "E",
      2,
      13,
    ],
    // JavaScript's rule, whichever way round.
    ["const + var", "static const q = 1\nstatic var q = 2", "q", 2, 11],
    ["var + let", "static var q = 1\nstatic let q = 2", "q", 2, 11],
    ["var + class", "static var C = 1\nstatic class C {}", "C", 2, 13],
    ["import + var", `${X}\nstatic var x = 1`, "x", 2, 11],
    [
      "default export function + const",
      "export default function f() {}\nstatic const f = 1",
      "f",
      2,
      13,
    ],
  ];

  it.each(rows)("%s", (_label, source, name, line, column) => {
    const error = expectRefused(source, DUPLICATE, name, line, column);
    // Stock's wording first, then where the first declaration is.
    expect(error.message).toMatch(
      new RegExp(
        `^Duplicate declaration "${name}": it is already declared at \\d+:\\d+\\.`,
      ),
    );
  });

  it("names where the first declaration is, as line:column (1-based)", () => {
    const error = expectRefused(
      `${X}\n\nstatic const x = 1`,
      DUPLICATE,
      "x",
      3,
      13,
    );
    expect(error.message).toContain("already declared at 1:8.");
    const block = expectRefused(
      "static {\n  const q = 1\n}\nserver const q = 2",
      DUPLICATE,
      "q",
      4,
      13,
    );
    expect(block.message).toContain("already declared at 2:9.");
  });

  it("names the first declaration also when it is the second statement's own earlier name", () => {
    const error = expectRefused(
      "static const y = 1\nstatic const x = 2\nserver const x = 3",
      DUPLICATE,
      "x",
      3,
      13,
    );
    expect(error.message).toContain("already declared at 2:14.");
  });

  it("refuses each later declaration at its own name, against the first", () => {
    const found = ours(`${X}\nstatic const x = 1\nserver const x = 2`);
    expect(found.map((d) => [d.code, d.line, d.column])).toEqual([
      [DUPLICATE, 2, 13],
      [DUPLICATE, 3, 13],
    ]);
    for (const d of found) expect(d.message).toContain("declared at 1:8.");
  });

  it("refuses a var that hoists out of a block against a lexical name", () => {
    expectRefused(
      "static const q = 1\nstatic { if (c) { var q = 2 } }",
      DUPLICATE,
      "q",
      2,
      22,
    );
    expectRefused(
      "static { if (c) { var q = 1 } }\nstatic const q = 2",
      DUPLICATE,
      "q",
      2,
      13,
    );
  });

  it("keeps one statement's own duplicate as it was", () => {
    // The statement check refuses it; this item does not touch it.
    const all = diagnostics("static { const q = 1; const q = 2 }");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("already been declared");
    expect(all[0]?.code).not.toBe(DUPLICATE);
    expect(ours("static { const q = 1; const q = 2 }")).toEqual([]);
  });
});

describe("what compiles", () => {
  const cases: [string, string][] = [
    ["static var twice", "static var v = 1\nstatic var v = 2"],
    ["client var twice", "client var v = 1\nclient var v = 2"],
    ["server var + client var", "server var v = 1\nclient var v = 2"],
    ["a var twice in one statement", "static { var q = 1; var q = 2 }"],
    [
      "a var hoisted out of a block + a var",
      "static { if (c) { var q = 1 } }\nstatic var q = 2",
    ],
    ["a type + a const", "static type T = 1\nstatic const T = 2"],
    ["a const + a type", "static const T = 2\nstatic type T = 1"],
    [
      "a type import + a const",
      'import type { T } from "./t"\nstatic const T = 1',
    ],
    [
      "an inline type import + a const",
      'import { type T } from "./t"\nstatic const T = 1',
    ],
    [
      "an interface + a const",
      "static interface I { a: 1 }\nstatic const I = 1",
    ],
    ["two types", "static type T = 1\nstatic type T = 2"],
    [
      "two interfaces",
      "static interface I { a: 1 }\nstatic interface I { b: 2 }",
    ],
    [
      "a class + an interface",
      "static class C {}\nstatic interface C { x: number }",
    ],
    [
      "different names",
      'import x from "./x"\nstatic const y = 1\nserver const z = 2',
    ],
    [
      "the same name in an inner scope",
      "static const q = 1\nstatic function f() { const q = 2; return q }",
    ],
    [
      "a parameter that shares a module name",
      "static const q = 1\nstatic function f(q) { return q }",
    ],
    ["a property name", "static const q = 1\nstatic const o = { q: 2 }"],
    [
      "an enclosed block's own let",
      "static const q = 1\nstatic { { let q = 2 } }",
    ],
    // Out of scope: stock compiles these and the module then throws at load.
    ["an assignment + a const", "static count = 1\nstatic const count = 2"],
    ["an assignment twice", "static count = 1\nstatic count = 2"],
    // A tag variable is not a module binding: the render-only check owns it.
  ];
  it.each(cases)("%s", (_label, source) => {
    expectCompiles(source);
  });

  it("refuses nothing under the `none` tag rules, where a dialect owns its statements", () => {
    expect(ours("static const q = 1\nstatic const q = 2", "none")).toEqual([]);
    expect(ours("static export { q }", "none")).toEqual([]);
  });

  it("leaves a tag variable to the render-only check", () => {
    const found = diagnostics("<let/q=0/>\nstatic const q = 1").filter(
      (d) => d.severity === "error",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(RENDER_ONLY);
  });
});

describe("TypeScript's merges", () => {
  const merges: [string, string][] = [
    ["enum + enum", "static enum E { A = 0 }\nstatic enum E { B = 1 }"],
    ["enum + enum in blocks", "static { enum E { A = 0 }\nenum E { B = 1 } }"],
    [
      "const enum + const enum",
      "static const enum E { A = 0 }\nstatic const enum E { B = 1 }",
    ],
    [
      "enum + namespace",
      "static enum E { A }\nstatic namespace E { export const a = 1 }",
    ],
    [
      "namespace + enum",
      "static namespace E { export const a = 1 }\nstatic enum E { A }",
    ],
    [
      "namespace + namespace",
      "static namespace N { export const a = 1 }\nstatic namespace N { export const b = 2 }",
    ],
    [
      "function + namespace",
      "static function N() {}\nstatic namespace N { export const a = 1 }",
    ],
    [
      "class + namespace",
      "static class C {}\nstatic namespace C { export const a = 1 }",
    ],
    [
      "declare class + namespace",
      "static declare class C {}\nstatic namespace C { export const a = 1 }",
    ],
    [
      "function + declare namespace",
      "static function N() {}\nstatic declare namespace N { const a: number }",
    ],
    [
      "overloads in a block",
      "static {\nfunction f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: any) {}\n}",
    ],
    [
      "overloads across statements",
      "static function f(a: string): void;\nstatic function f(a: number): void;\nstatic function f(a: any) {}",
    ],
    [
      "overloads across server and client",
      "server function f(a: string): void;\nclient function f(a: any) {}",
    ],
    [
      "declare function + declare function",
      "static declare function f(): void\nstatic declare function f(a: number): void",
    ],
    [
      "declare enum + declare enum",
      "static declare enum E { A = 0 }\nstatic declare enum E { B = 1 }",
    ],
    [
      "declare namespace + declare namespace",
      "static declare namespace N { const a: number }\nstatic declare namespace N { const b: number }",
    ],
    [
      "a namespace of types only + a function",
      "static namespace N { type T = 1 }\nstatic function N() {}",
    ],
    [
      "a namespace of types only + a const",
      "static namespace N { type T = 1 }\nstatic const N = 1",
    ],
  ];
  it.each(merges)("%s compiles", (_label, source) => {
    expectCompiles(source);
  });

  const refused: [string, string, string, number, number][] = [
    [
      "a namespace before the function it would merge with",
      "static namespace N { export const a = 1 }\nstatic function N() {}",
      "N",
      2,
      16,
    ],
    [
      "a namespace before the class it would merge with",
      "static namespace C { export const a = 1 }\nstatic class C {}",
      "C",
      2,
      13,
    ],
    [
      "a const enum + an enum",
      "static const enum E { A = 0 }\nstatic enum E { B = 1 }",
      "E",
      2,
      12,
    ],
    [
      "an implementation + another signature",
      "static function f(a: any) {}\nstatic function f(a: string): void;",
      "f",
      2,
      16,
    ],
    [
      "an implementation + another implementation",
      "static function f(a: any) {}\nstatic function f(a: string) {}",
      "f",
      2,
      16,
    ],
    [
      "an overload signature + a declare function",
      "static function f(a: string): void;\nstatic declare function f(): void",
      "f",
      2,
      24,
    ],
    [
      "a declare function + its implementation",
      "static declare function f(): void\nstatic function f() {}",
      "f",
      2,
      16,
    ],
    [
      "a function + a namespace + a function",
      "static function f(a: string): void;\nstatic namespace f { export const a = 1 }\nstatic function f(a: any) {}",
      "f",
      3,
      16,
    ],
    ["an enum + a class", "static enum E { A }\nstatic class E {}", "E", 2, 13],
    [
      "a class + a function",
      "static class C {}\nstatic function C() {}",
      "C",
      2,
      16,
    ],
    ["a class + a class", "static class C {}\nstatic class C {}", "C", 2, 13],
    [
      "a namespace with values + a const",
      "static namespace N { export const a = 1 }\nstatic const N = 1",
      "N",
      2,
      13,
    ],
    [
      "a declare namespace with values + a const",
      "static declare namespace N { const a: number }\nstatic const N = 1",
      "N",
      2,
      13,
    ],
    [
      "a declare var + a const",
      "static declare var v: number\nstatic const v = 1",
      "v",
      2,
      13,
    ],
  ];
  it.each(refused)("%s is refused", (_label, source, name, line, column) => {
    expectRefused(source, DUPLICATE, name, line, column);
  });
});

describe("an export list names a declared binding", () => {
  // [label, source, name, line, column]
  const refused: [string, string, string, number, number][] = [
    ["static export", "static export { q }", "q", 1, 16],
    ["static block export", "static { export { q } }", "q", 1, 18],
    ["server export", "server export { q }", "q", 1, 16],
    ["client block export", "client { export { q } }", "q", 1, 18],
    ["top level export", "export { q }", "q", 1, 9],
    ["renamed", "static export { q as r }", "q", 1, 16],
    ["top level renamed", "export { q as r }", "q", 1, 9],
    [
      "the undeclared one of several",
      "static const a = 1\nstatic export { a, z }",
      "z",
      2,
      19,
    ],
    [
      "the first undeclared one of two",
      "static const a = 1\nstatic export { a, z, y }",
      "z",
      2,
      19,
    ],
    [
      "a name only an assignment gives (stock's module does not load)",
      "static q = 1\nstatic export { q }",
      "q",
      2,
      16,
    ],
    [
      "a name only declared inside a function",
      "static function f() { const q = 1 }\nstatic export { q }",
      "q",
      2,
      16,
    ],
    [
      "a name only a type-only namespace member is",
      "static namespace N { export type T = 1 }\nstatic export { T }",
      "T",
      2,
      16,
    ],
    // A value only `declare` introduces is erased by the TypeScript strip, so
    // the export list names nothing at run time (Node: "Export 'd' is not
    // defined in module"). A type name is erased from the list too, so it loads.
    [
      "an ambient const",
      "static declare const d: number\nstatic export { d }",
      "d",
      2,
      16,
    ],
    [
      "an ambient let",
      "static declare let d: number\nstatic export { d }",
      "d",
      2,
      16,
    ],
    [
      "an ambient var",
      "static declare var d: number\nstatic export { d }",
      "d",
      2,
      16,
    ],
    [
      "an ambient function",
      "static declare function d(): void\nstatic export { d }",
      "d",
      2,
      16,
    ],
    [
      "an ambient class",
      "static declare class C {}\nstatic export { C }",
      "C",
      2,
      16,
    ],
    [
      "an ambient enum",
      "static declare enum E { A }\nstatic export { E }",
      "E",
      2,
      16,
    ],
    [
      "an ambient namespace with values",
      "static declare namespace N { const a: number }\nstatic export { N }",
      "N",
      2,
      16,
    ],
    [
      "an ambient const in a block, exported by another statement",
      "static { declare const d: number }\nserver export { d }",
      "d",
      2,
      16,
    ],
    [
      "an ambient const exported in the same block",
      "static { declare const d: number; export { d } }",
      "d",
      1,
      43,
    ],
    [
      "an `export declare const`",
      "export declare const d: number\nstatic export { d }",
      "d",
      2,
      16,
    ],
    [
      "an `export default` default alias",
      "static export { q as default }",
      "q",
      1,
      16,
    ],
  ];
  it.each(refused)(
    "%s is refused at the name",
    (_label, source, name, line, column) => {
      if (source.includes("as default")) {
        // The template is its own default export: that refusal comes as well.
        const found = ours(source);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          code: UNDECLARED,
          line,
          column,
          end: { line, column: column + name.length },
        });
        return;
      }
      const error = expectRefused(source, UNDECLARED, name, line, column);
      expect(error.message).toMatch(
        new RegExp(`^Export '${name}' is not defined in module: `),
      );
      expect(error.message).toContain(`Declare \`${name}\``);
    },
  );

  const compiles: [string, string][] = [
    ["declared later", "static export { q }\nstatic const q = 1"],
    ["declared later, top level export", "export { q }\nstatic const q = 1"],
    ["declared earlier", "static const q = 1\nstatic export { q }"],
    [
      "declared in a block, exported in a block",
      "static { const q = 1 }\nserver { export { q } }",
    ],
    [
      "declared by server, exported by client",
      "server const q = 1\nclient export { q }",
    ],
    ["declared by an export", "export const q = 1\nstatic export { q as r }"],
    [
      "renamed, the local declared",
      "static const q = 1\nstatic export { q as r }",
    ],
    [
      "a destructured name",
      "static const { a, b: [c] } = o\nstatic export { a, c }",
    ],
    ["an import", 'import x from "./x"\nstatic export { x }'],
    ["an import declared later", 'static export { x }\nimport x from "./x"'],
    ["a namespace import", 'import * as ns from "./m"\nstatic export { ns }'],
    ["a type import", 'import type { T } from "./t"\nstatic export { T }'],
    [
      "an inline type import",
      'import { type T } from "./t"\nstatic export { T }',
    ],
    ["a type alias", "static type T = 1\nstatic export { T }"],
    ["an interface", "static interface I { a: 1 }\nstatic export { I }"],
    [
      "an ambient namespace with only types",
      "static declare namespace N { type A = 1 }\nstatic export { N }",
    ],
    [
      "an ambient const beside a real one that is exported",
      "static declare const d: number\nstatic const e = 1\nstatic export { e }",
    ],
    [
      "a declare class merged with a namespace that has values",
      "static declare class C {}\nstatic namespace C { export const a = 1 }\nstatic export { C }",
    ],
    [
      "a function, a class, an enum",
      "static function f() {}\nstatic class C {}\nstatic enum E { A }\nstatic export { f, C, E }",
    ],
    [
      "a namespace",
      "static namespace N { export const a = 1 }\nstatic export { N }",
    ],
    [
      "a var in a block",
      "static { if (c) { var q = 1 } }\nstatic export { q }",
    ],
    [
      "a default export function",
      "export default function f() {}\nstatic export { f }",
    ],
    // A re-export binds nothing locally.
    ["a re-export", 'export { q } from "./m"'],
    ["a static re-export", 'static export { q } from "./m"'],
    ["a renamed re-export", 'export { q as r } from "./m"'],
    ["export all", 'export * from "./m"'],
    ["export all as", 'export * as ns from "./m"'],
    // A type export is erased.
    ["a type export of an undeclared name", "static export type { T }"],
    ["a top level type export", "export type { T }"],
    ["an inline type export", "static export { type T }"],
  ];
  it.each(compiles)("%s compiles", (_label, source) => {
    expectCompiles(source);
  });

  it("leaves a tag variable to the render-only check, one error", () => {
    const found = diagnostics("<const/q=1/>\nstatic export { q }").filter(
      (d) => d.severity === "error",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(RENDER_ONLY);
  });

  it("waits for a statement it cannot read: that statement's own error is the one", () => {
    const found = diagnostics("static export { q }\nstatic const = ;").filter(
      (d) => d.severity === "error",
    );
    expect(found.some((d) => d.code === UNDECLARED)).toBe(false);
    expect(found.length).toBeGreaterThan(0);
  });
});
