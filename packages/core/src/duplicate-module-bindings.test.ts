// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * The module statements (`import`, `static`, `server`, `client`, `export`; the
 * block and the block-less form) share one module scope, so a name is declared
 * once across all of them. The rule is JavaScript's, applied after the
 * TypeScript strip:
 *
 * - two `var`s of a name are fine;
 * - so are the merges TypeScript itself accepts (enum with enum or namespace,
 *   a namespace after a function, class, enum or namespace; a `declare`
 *   function, class, enum or namespace and a bodiless signature bind nothing at
 *   run time, so they never collide, and TypeScript's own conflicts (TS2300,
 *   TS2384, TS2434, TS2451) are mx-tsc's; a namespace with values before a
 *   function or class of its name does not load, so it is refused; a `declare
 *   const`, `let` or `var` follows stock Marko's own, order-dependent table);
 * - a `type`, an `interface` and a namespace holding only types are not values,
 *   so they never collide; a type-only import (`import type`) is a binding in
 *   stock's scope, so it follows stock's order-dependent table (a `const`, `let`,
 *   class or `import` before it, a `let` or class after it, are refused);
 * - any other second declaration is refused at its name with
 *   `MX_DUPLICATE_DECLARATION`, in source order.
 *
 * An export list (`export { q }`) naming a binding no module statement
 * declares is refused at the name with `MX_UNDECLARED_EXPORT`: the module it
 * would make cannot load. Declared anywhere counts, before or after it: a
 * type, or a value that survives the TypeScript strip. A value only `declare`
 * introduces, or only a bodiless function signature, is erased, so it does not
 * count. A re-export and a type export bind nothing local.
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
    // Pairs stock Marko compiles and the compiled module then fails to load
    // ("Identifier 'f' has already been declared") or refuses under Bun's or
    // esbuild's strip: MX refuses them (one divergences.md row).
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
    [
      "var + const (stock compiles it)",
      "static var f = 1\nstatic const f = 2",
      "f",
      2,
      13,
    ],
    [
      "var + export const (stock compiles it)",
      "static var f = 1\nstatic export const f = 2",
      "f",
      2,
      20,
    ],
    [
      "var + function (stock compiles it)",
      "static var f = 1\nstatic function f() {}",
      "f",
      2,
      16,
    ],
    [
      "function + import (stock compiles it)",
      `static function x() {}\n${X}`,
      "x",
      2,
      7,
    ],
    [
      "import + namespace with values (stock compiles it)",
      `${X}\nstatic namespace x { export const a = 1 }`,
      "x",
      2,
      17,
    ],
    [
      "const + namespace with values (stock compiles it)",
      "static const N = 1\nstatic namespace N { export const a = 1 }",
      "N",
      2,
      17,
    ],
    [
      "let + namespace with values (stock compiles it)",
      "static let N = 1\nstatic namespace N { export const a = 1 }",
      "N",
      2,
      17,
    ],
    [
      "var + namespace with values (stock compiles it)",
      "static var N = 1\nstatic namespace N { export const a = 1 }",
      "N",
      2,
      17,
    ],
    [
      "namespace with values + let (stock compiles it)",
      "static namespace N { export const a = 1 }\nstatic let N = 1",
      "N",
      2,
      11,
    ],
    [
      "namespace with values + var (stock compiles it)",
      "static namespace N { export const a = 1 }\nstatic var N = 1",
      "N",
      2,
      11,
    ],
    [
      "namespace with values + import (stock compiles it)",
      `static namespace x { export const a = 1 }\n${X}`,
      "x",
      2,
      7,
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
      "declare namespace + function",
      "static declare namespace N { const a: number }\nstatic function N() {}",
    ],
    [
      "declare namespace + class",
      "static declare namespace N { const a: number }\nstatic class N {}",
    ],
    [
      "declare namespace + declare function",
      "static declare namespace N { const a: number }\nstatic declare function N(): void",
    ],
    [
      "declare namespace + two declare function overloads",
      "static declare namespace N { const a: number }\nstatic declare function N(): void\nstatic declare function N(a: number): void",
    ],
    [
      "declare namespace + overloads + implementation",
      "static declare namespace N { const a: number }\nstatic function N(a: string): void;\nstatic function N(a: any) {}",
    ],
    [
      "namespace with values + declare function",
      "static namespace N { export const a = 1 }\nstatic declare function N(): void",
    ],
    [
      "namespace with values + declare class",
      "static namespace N { export const a = 1 }\nstatic declare class N {}",
    ],
    [
      "declare namespace + function in one block",
      "static {\n  declare namespace f { const x: number }\n  function f() {}\n}",
    ],
    [
      "declare namespace + function across blocks and keywords",
      "static { declare namespace f { const x: number } }\nserver function f() {}",
    ],
    [
      "export declare namespace + export function",
      "export declare namespace f { const x: number }\nexport function f() {}",
    ],
    [
      "a namespace of types only + a function",
      "static namespace N { type T = 1 }\nstatic function N() {}",
    ],
    [
      "a namespace of types only + a const",
      "static namespace N { type T = 1 }\nstatic const N = 1",
    ],
    // Ambient declarations and bodiless signatures bind nothing once the
    // strip has run, so only a real binding collides. TypeScript's own
    // ordering and overload errors (TS2300, TS2384, TS2434, TS2451) are
    // mx-tsc's.
    [
      "an implementation + a bodiless signature",
      "static function f(a: any) {}\nstatic function f(a: string): void;",
    ],
    [
      "an overload signature + a declare function",
      "static function f(a: string): void;\nstatic declare function f(): void",
    ],
    [
      "a declare function + its implementation",
      "static declare function f(): void\nstatic function f() {}",
    ],
    [
      "a signature + a declare namespace + its implementation",
      "static function f(a: string): void;\nstatic declare namespace f { const x: number }\nstatic function f(a: any) {}",
    ],
    [
      "a declare namespace with values + a const",
      "static declare namespace N { const a: number }\nstatic const N = 1",
    ],
    [
      "a declare var + a const",
      "static declare var v: number\nstatic const v = 1",
    ],
    [
      "a function + a declare function",
      "static function f() {}\nstatic declare function f(): void",
    ],
    [
      "a declare class + a class",
      "static declare class C {}\nstatic class C {}",
    ],
    [
      "a class + a declare class",
      "static class C {}\nstatic declare class C {}",
    ],
    [
      "a declare class twice",
      "static declare class C {}\nstatic declare class C {}",
    ],
    [
      "a const + a declare namespace with values",
      "static const N = 1\nstatic declare namespace N { const a: number }",
    ],
    [
      "a declare function + a const",
      "static declare function f(): void\nstatic const f = 1",
    ],
    [
      "a bodiless signature + a const",
      "static function f(): void\nstatic const f = 1",
    ],
    [
      "a declare enum + a const",
      "static declare enum E { A }\nstatic const E = 1",
    ],
  ];
  it.each(merges)("%s compiles", (_label, source) => {
    expectCompiles(source);
  });

  const refused: [string, string, string, number, number][] = [
    // A namespace with values before a function or class of its name does not
    // load once the TypeScript is stripped by Bun, esbuild or tsc (`var N` beside
    // `function N`), and Babel's strip reads the class before it is initialised.
    // Stock compiles all of them (divergences.md).
    [
      "a namespace with values before a function",
      "static namespace N { export const a = 1 }\nstatic function N() {}",
      "N",
      2,
      16,
    ],
    [
      "a namespace with values before a function in one block",
      "static {\n  namespace f { export const x = 1 }\n  function f() {}\n}",
      "f",
      3,
      11,
    ],
    [
      "a signature + a namespace + its implementation",
      "static function f(a: string): void;\nstatic namespace f { export const x = 1 }\nstatic function f(a: any) {}",
      "f",
      3,
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
      "an implementation + another implementation",
      "static function f(a: any) {}\nstatic function f(a: string) {}",
      "f",
      2,
      16,
    ],
    [
      "a declare namespace + two classes",
      "static declare namespace C { const a: number }\nstatic class C {}\nstatic class C {}",
      "C",
      3,
      13,
    ],
    [
      "a declare namespace + a class + a function",
      "static declare namespace C { const a: number }\nstatic class C {}\nstatic function C() {}",
      "C",
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
  ];
  it.each(refused)("%s is refused", (_label, source, name, line, column) => {
    expectRefused(source, DUPLICATE, name, line, column);
  });
});

describe("the message for a namespace before a function or class", () => {
  it("says to declare the function or class first", () => {
    const fn = expectRefused(
      "static namespace N { export const a = 1 }\nstatic function N() {}",
      DUPLICATE,
      "N",
      2,
      16,
    );
    expect(fn.message).toContain("Declare the function before the namespace");
    const cls = expectRefused(
      "static namespace N { export const a = 1 }\nstatic class N {}",
      DUPLICATE,
      "N",
      2,
      13,
    );
    expect(cls.message).toContain("Declare the class before the namespace");
  });

  it("does not say it for other pairs", () => {
    const error = expectRefused(
      "static function f() {}\nstatic const f = 1",
      DUPLICATE,
      "f",
      2,
      13,
    );
    expect(error.message).not.toContain("before the namespace");
  });
});

describe("a declare const, let or var beside another declaration follows stock Marko", () => {
  // Babel's scope registers `declare const`, `let` and `var`, and not as one
  // rule: stock 6.4.4 refuses some orders and compiles others. Every pair below
  // was run through stock (`Duplicate declaration` at the second name), and MX
  // refuses exactly those, at the same position; the rest compile (the strip
  // erases the `declare`). A `declare function`, `class` and `namespace` is
  // accepted beside anything.
  const kinds: Record<string, string> = {
    const: "static const x = 1",
    let: "static let x = 1",
    var: "static var x = 1",
    fn: "static function x() {}",
    cls: "static class x {}",
    ns: "static namespace x { export const a = 1 }",
    imp: 'import x from "./x"',
    dconst: "static declare const x: number",
    dlet: "static declare let x: number",
    dvar: "static declare var x: number",
    dfn: "static declare function x(): void",
    dclass: "static declare class x {}",
    dns: "static declare namespace x { const a: number }",
    sig: "static function x(): void",
  };
  const stockRefuses = new Set(
    `const>dconst const>dlet const>dvar let>dconst let>dlet let>dvar var>dlet fn>dlet cls>dconst cls>dlet cls>dvar imp>dconst imp>dlet imp>dvar dconst>const dconst>let dconst>var dconst>fn dconst>cls dconst>imp dconst>dconst dconst>dlet dconst>dvar dlet>const dlet>let dlet>var dlet>fn dlet>cls dlet>imp dlet>dconst dlet>dlet dlet>dvar dvar>let dvar>cls dvar>dlet`.split(
      " ",
    ),
  );
  const declares = new Set(["dconst", "dlet", "dvar"]);
  const pairs: [string, string, string][] = [];
  for (const first of Object.keys(kinds)) {
    for (const second of Object.keys(kinds)) {
      if (declares.has(first) || declares.has(second)) {
        pairs.push([`${first} > ${second}`, first, second]);
      }
    }
  }
  it.each(pairs)("%s", (_label, first, second) => {
    const source = `${kinds[first]}\n${kinds[second]}`;
    if (stockRefuses.has(`${first}>${second}`)) {
      const column = (kinds[second] as string).search(/\bx\b/);
      expectRefused(source, DUPLICATE, "x", 2, column);
    } else {
      expectCompiles(source);
    }
  });

  it("refuses one in a block beside a real one in another, at the second name", () => {
    expectRefused(
      "static { declare const d: number }\nserver { const d = 1 }",
      DUPLICATE,
      "d",
      2,
      15,
    );
  });
});

describe("a type-only import beside a real declaration follows stock Marko", () => {
  // Babel's scope registers a type-only import as a binding, and not as one
  // rule: stock 6.4.4 refuses some orders and compiles others, the same for
  // `import type x`, `import type { x }`, `import { type x }` and `import type
  // * as x`. Every pair below was run through `stockMarkoCompile` (read
  // `result.error.loc`: `Duplicate declaration` at the second name), and MX
  // refuses exactly those, at the same position. Stock refuses:
  //   - a type-only import after a `const`, `let`, class, value import,
  //     `declare const` or `declare let`;
  //   - a `let`, a class or a `declare let` after a type-only import.
  // It compiles everything else, a `var`, a function, a `declare var`, an
  // enum, a namespace, a type and another type-only import included.
  // (`static enum` is not probeable on stock: it throws "Unexpected enum
  // parent"; `export enum` is, and compiles in both orders.)
  const spellings: Record<string, string> = {
    default: 'import type x from "./x"',
    named: 'import type { x } from "./x"',
    inline: 'import { type x } from "./x"',
    star: 'import type * as x from "./x"',
    mixed: 'import y, { type x } from "./x"',
  };
  const kinds: Record<string, string> = {
    const: "static const x = 1",
    let: "static let x = 1",
    var: "static var x = 1",
    fn: "static function x() {}",
    sig: "static function x(): void",
    cls: "static class x {}",
    imp: 'import x from "./x"',
    // A TypeScript alias is not a value import to stock's scope: it compiles
    // beside every spelling, in both orders.
    importEquals: "static import x = M.N",
    exportImportEquals: "static export import x = M.N",
    dconst: "static declare const x: number",
    dlet: "static declare let x: number",
    dvar: "static declare var x: number",
    dfn: "static declare function x(): void",
    dcls: "static declare class x {}",
    enum: "export enum x { A }",
    ns: "static namespace x { export const a = 1 }",
    tns: "static namespace x { export type a = 1 }",
    iface: "static interface x {}",
    typeAlias: "static type x = number",
    typeImport: 'import type { x } from "./y"',
  };
  // `kind>type` and `type>kind`: the pairs stock refuses.
  const typeAfter = new Set(["const", "let", "cls", "imp", "dconst", "dlet"]);
  const typeBefore = new Set(["let", "cls", "dlet"]);
  const pairs: [string, string, string, boolean][] = [];
  for (const spelling of Object.keys(spellings)) {
    for (const kind of Object.keys(kinds)) {
      pairs.push([`${kind} > ${spelling}`, kind, spelling, true]);
      pairs.push([`${spelling} > ${kind}`, kind, spelling, false]);
    }
  }
  it.each(pairs)("%s", (_label, kind, spelling, typeSecond) => {
    const type = spellings[spelling] as string;
    const real = kinds[kind] as string;
    const source = typeSecond ? `${real}\n${type}` : `${type}\n${real}`;
    const refused = typeSecond ? typeAfter.has(kind) : typeBefore.has(kind);
    if (refused) {
      const second = typeSecond ? type : real;
      expectRefused(source, DUPLICATE, "x", 2, second.search(/\bx\b/));
    } else {
      expectCompiles(source);
    }
  });

  // The same answers in a `server`, `client` or `static` block, and with
  // `export`: stock's table does not depend on where the statement sits.
  const wraps: Record<string, (body: string) => string[]> = {
    "static block": (body) => ["static {", `  ${body}`, "}"],
    server: (body) => ["server {", `  ${body}`, "}"],
    client: (body) => ["client {", `  ${body}`, "}"],
    export: (body) => [`export ${body}`],
  };
  const bodies: Record<string, string> = {
    const: "const x = 1",
    let: "let x = 1",
    class: "class x {}",
    var: "var x = 1",
    function: "function x() {}",
  };
  const where: [string, string, string, boolean, boolean][] = [];
  for (const wrap of Object.keys(wraps)) {
    for (const body of Object.keys(bodies)) {
      where.push([
        `${wrap}: ${body} > type`,
        wrap,
        body,
        true,
        ["const", "let", "class"].includes(body),
      ]);
      where.push([
        `${wrap}: type > ${body}`,
        wrap,
        body,
        false,
        ["let", "class"].includes(body),
      ]);
    }
  }
  it.each(where)("%s", (_label, wrap, body, typeSecond, refused) => {
    const type = 'import type { x } from "./x"';
    const lines = (wraps[wrap] as (b: string) => string[])(
      bodies[body] as string,
    );
    const source = typeSecond
      ? [...lines, type].join("\n")
      : [type, ...lines].join("\n");
    if (!refused) return expectCompiles(source);
    const all = source.split("\n");
    const line = typeSecond
      ? all.length
      : all.findIndex((text, i) => i > 0 && /\bx\b/.test(text)) + 1;
    const text = all[line - 1] as string;
    expectRefused(source, DUPLICATE, "x", line, text.search(/\bx\b/));
  });

  it("says where the first declaration is, and how to resolve it", () => {
    const error = expectRefused(
      'import type { x } from "./x"\nstatic let x = 1',
      DUPLICATE,
      "x",
      2,
      11,
    );
    expect(error.message).toContain('Duplicate declaration "x"');
    expect(error.message).toContain("already declared at 1:15");
  });

  it("refuses across a server block and a client block", () => {
    expectRefused(
      'import type { x } from "./x"\nserver { const y = 1 }\nclient { class x {} }',
      DUPLICATE,
      "x",
      3,
      15,
    );
  });

  it("refuses a name an alias binds, not the imported name", () => {
    expectRefused(
      'import type { a as y } from "./x"\nstatic let y = 1',
      DUPLICATE,
      "y",
      2,
      11,
    );
    expectCompiles('import type { y as a } from "./x"\nstatic let y = 1');
  });

  it("keeps a type-only import beside a type-only import legal", () => {
    expectCompiles(
      'import type { x } from "./a"\nimport type { x } from "./b"\nstatic type x = 1',
    );
  });

  it("does not make an export list of a type-only name stop working", () => {
    expectCompiles('import type { x } from "./x"\nstatic export { x }');
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
    // A signature with no body binds nothing (Node: "Export 'f' is not
    // defined in module"; tsc: TS2391).
    [
      "an overload signature with no implementation",
      "static function f(a: string): void;\nstatic export { f }",
      "f",
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

  it("says where an ambient-only name is declared", () => {
    const error = expectRefused(
      "static declare const d: number\nstatic export { d }",
      UNDECLARED,
      "d",
      2,
      16,
    );
    expect(error.message).toContain(
      "only declared with `declare` at 1:22, which the TypeScript strip erases",
    );
  });

  it("says where a signature-only name is declared", () => {
    const error = expectRefused(
      "static function f(a: string): void;\nstatic export { f }",
      UNDECLARED,
      "f",
      2,
      16,
    );
    expect(error.message).toContain(
      "only declared by the function signature at 1:17, which has no body",
    );
  });

  it("names no earlier declaration for a name nothing declares", () => {
    const error = expectRefused("static export { q }", UNDECLARED, "q", 1, 16);
    expect(error.message).not.toContain("only declared");
  });

  const compiles: [string, string][] = [
    ["declared later", "static export { q }\nstatic const q = 1"],
    [
      "an overload signature with its implementation",
      "static function f(a: string): void;\nstatic function f(a: any) {}\nstatic export { f }",
    ],

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
