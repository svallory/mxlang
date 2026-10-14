// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `import` and `export` inside a `static`, `server` or `client` block.
 *
 * Stock Marko 6.4.4 hoists the statements inside the block to the module, so
 * an `import` or `export` there is a module-level statement (probed with
 * `stockMarkoCompile` in `packages/stock-marko`; the `block-import-export`
 * fixture in `fixtures-marko` locks the render). A `client` block still only
 * declares its names (`var x;`), as in `client-block.test.ts`.
 *
 * The expectations are MX's module text: the statements as authored, not the
 * semicolon-terminated reprint stock Marko's generator makes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/** The hoisted module code: what sits between the runtime import and `export interface Input`. */
function hoisted(source: string): string {
  const { code } = compile(source, "/f/t.mx");
  const from = code.indexOf("\n", code.indexOf("@mxlang/target-html")) + 1;
  return code.slice(from, code.indexOf("export interface Input")).trim();
}

const TEMPLATE = "\n<div/>\n";

describe("html: an import or export in a block is a module-level statement", () => {
  it.each([
    ["static import", 'static { import x from "./x" }', 'import x from "./x"'],
    ["server import", 'server { import x from "./x" }', 'import x from "./x"'],
    [
      "static export const",
      "static { export const z = 1 }",
      "export const z = 1",
    ],
    [
      "static export function",
      "static { export function f() {} }",
      "export function f() {}",
    ],
    [
      "static export list",
      "static { const y = 1; export { y } }",
      "const y = 1; export { y }",
    ],
    [
      "static export from",
      'static { export { a } from "./x" }',
      'export { a } from "./x"',
    ],
    [
      "static export star",
      'static { export * from "./x" }',
      'export * from "./x"',
    ],
    ["static bare import", 'static { import "./side" }', 'import "./side"'],
    [
      "static type import",
      'static { import type { T } from "./x"; const a: T = 1 }',
      'import type { T } from "./x"; const a: T = 1',
    ],
    [
      "server export star",
      'server { export * from "./x" }',
      'export * from "./x"',
    ],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("keeps the imported name readable by a later statement and the template", () => {
    const { code } = compile(
      'static { import x from "./x"; const y = x; }\n<div>${y}</div>\n',
      "/f/t.mx",
    );
    expect(code).toContain('import x from "./x"; const y = x;');
    expect(code).toMatch(/escape\(y\)|__mxTextOf\(y\)/);
  });

  it("is the module code the statement has without the block", () => {
    expect(hoisted(`static import x from "./x"${TEMPLATE}`)).toBe(
      hoisted(`static { import x from "./x" }${TEMPLATE}`),
    );
  });

  it.each([
    ["static", "static { export default foo }"],
    ["client", "client { export default foo }"],
    ["server", "server { export default function f() {} }"],
    ["static", "static { const a = 1; export default a }"],
  ])(
    "raises no internal error for a default export in a %s block: %s",
    (_keyword, statement) => {
      expect(() => compile(`${statement}${TEMPLATE}`, "/f/t.mx")).not.toThrow();
    },
  );

  it("compiles `server { export default foo }` beside the template's own export, as stock does", () => {
    const { code } = compile(
      "server { export default foo }\n<div/>\n",
      "/f/t.mx",
    );
    expect(code).toContain("export default foo");
    expect(code.split("export default").length - 1).toBe(2);
  });
});

describe("html: a `client` block's import or export declares its names", () => {
  it.each([
    ["an import", 'client { import x from "./x"; }', "var x;"],
    ["an export const", "client { export const y = 1 }", "var y;"],
    [
      "an export function and class",
      "client { export class C {} export function f() {} }",
      "var C, f;",
    ],
    ["a type-only import", 'client { import type { T } from "./x" }', ""],
    ["an export star", 'client { export * from "./x" }', ""],
    ["an export from", 'client { export { a } from "./x" }', ""],
    ["a default export", "client { export default function f() {} }", "var f;"],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("emits none of the client block's code", () => {
    const { code } = compile(
      'client { import x from "./x"; export const y = x }\n<div/>\n',
      "/f/t.mx",
    );
    expect(code).not.toContain("./x");
    expect(code).toContain("var x, y;");
  });
});

describe("html: an import or export below the block's statements is refused with a position", () => {
  it.each([
    ["a nested block", 'static { { import x from "./x" } }', 1, 11],
    ["an if body", "static { if (a) { export const q = 1 } }", 1, 18],
    ["a client nested block", 'client { { import x from "./x" } }', 1, 11],
  ])("%s", (_name, statement, line, column) => {
    let error: { line?: number; column?: number; message?: string } = {};
    try {
      compile(`${statement}${TEMPLATE}`, "/f/t.mx");
    } catch (thrown) {
      error = thrown as typeof error;
    }
    expect(error.message).toBe(
      "An `import` or `export` must be a statement of the module: at the top of the file, after `static`, `server` or `client`, or directly inside that statement's `{ … }` block. This one is inside a nested block, an `if` or a function body; move it out to the block's own statements.",
    );
    expect([error.line, error.column]).toEqual([line, column]);
  });
});
