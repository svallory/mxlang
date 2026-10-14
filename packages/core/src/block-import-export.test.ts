// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `import` and `export` inside a `static`, `server` or `client` block.
 *
 * Marko reads the statements inside the one block as the module's own, so an
 * `import` or an `export` there is valid (stock Marko 6.4.4 compiles every row
 * below; `packages/targets/html/src/block-import-export.test.ts` pins the
 * module code it emits). The block's braces used to reach the statement check
 * ("'import' and 'export' may only appear at the top level.") and the
 * TypeScript strip (`export default` crashed it with an internal TypeError).
 * Only an `import` or `export` below the block's own statements is still
 * refused, and a real syntax error in the block is reported ahead of it.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

const PLACEMENT =
  "An `import` or `export` must be a statement of the module: at the top of the file, after `static`, `server` or `client`, or directly inside that statement's `{ … }` block. This one is inside a nested block, an `if` or a function body; move it out to the block's own statements.";

function lower(source: string) {
  return lowerSource(source, "/f/t.mx", { tagRules: "html" });
}

/** The code of every `Static` statement lowered to module scope. */
function hoisted(source: string): string[] {
  const { ir, diagnostics } = lower(source);
  expect(diagnostics).toEqual([]);
  return (ir?.hoisted ?? []).map((statement) => statement.code);
}

describe("an import or export in a static block is a module statement", () => {
  it.each([
    [
      "an import",
      'static { import x from "./x" }\n<div/>',
      'import x from "./x"',
    ],
    ["a bare import", 'static { import "./side" }\n<div/>', 'import "./side"'],
    [
      "a type-only import",
      'static { import type { T } from "./x"; const a: T = 1 }\n<div/>',
      'import type { T } from "./x"; const a: T = 1',
    ],
    [
      "an export of a declaration",
      "static { export const z = 1 }\n<div/>",
      "export const z = 1",
    ],
    [
      "an export of a function",
      "static { export function f() {} }\n<div/>",
      "export function f() {}",
    ],
    [
      "an export list after a declaration",
      "static { const y = 1; export { y } }\n<div/>",
      "const y = 1; export { y }",
    ],
    [
      "an export from",
      'static { export { a } from "./x" }\n<div/>',
      'export { a } from "./x"',
    ],
    [
      "an export star",
      'static { export * from "./x" }\n<div/>',
      'export * from "./x"',
    ],
    [
      "type exports",
      "static { export type T = number; export interface I {} }\n<div/>",
      "export type T = number; export interface I {}",
    ],
    [
      "a default export",
      "static { const foo = 1; export default foo }\n<div/>",
      "const foo = 1; export default foo",
    ],
    [
      "an import used by a later statement",
      'static { import x from "./x"; const y = x; }\n<div>${y}</div>',
      'import x from "./x"; const y = x;',
    ],
    [
      "a block over several lines",
      'static {\n  import x from "./x";\n  export const y = x;\n}\n<div/>',
      'import x from "./x";\n  export const y = x;',
    ],
    [
      "a namespace's own exports",
      "static { export namespace N { export const a = 1 } }\n<div/>",
      "export namespace N { export const a = 1 }",
    ],
  ])("%s", (_name, source, code) => {
    expect(hoisted(source)).toEqual([code]);
  });

  it("is the same module code as the statement written without the block", () => {
    expect(hoisted('static import x from "./x"\n<div/>')).toEqual(
      hoisted('static { import x from "./x" }\n<div/>'),
    );
  });
});

describe("server and client blocks with an import or export lower without an error", () => {
  it.each([
    ["server import", 'server { import x from "./x" }\n<div/>'],
    ["server export const", "server { export const z = 1 }\n<div/>"],
    ["server export star", 'server { export * from "./x" }\n<div/>'],
    [
      "server export default",
      "server { const foo = 1; export default foo }\n<div/>",
    ],
    [
      "server export default function",
      "server { export default function f() {} }\n<div/>",
    ],
    ["client import", 'client { import x from "./x"; }\n<div/>'],
    ["client export const", "client { export const y = 1 }\n<div/>"],
    [
      "client export default",
      "client { const foo = 1; export default foo }\n<div/>",
    ],
    ["client export from", 'client { export { a } from "./x" }\n<div/>'],
  ])("%s", (_name, source) => {
    const { ir, diagnostics } = lower(source);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });

  it("raises no internal error for `export default` in a block", () => {
    for (const keyword of ["static", "server", "client"]) {
      expect(() =>
        lower(`${keyword} { export default foo }\n<div/>`),
      ).not.toThrow();
    }
  });
});

describe("a block without an import or export keeps its module code", () => {
  it.each([
    ["a declaration", "static { let q = 1 }\n<div/>", "let q = 1"],
    [
      "several statements",
      "static { let a = 1; let b = a }\n<div/>",
      "let a = 1; let b = a",
    ],
    [
      "a typed declaration",
      "static { let x: number = 1 }\n<div/>",
      "let x: number = 1",
    ],
    [
      "two blocks",
      "static { let a = 1 } { let b = 2 }\n<div/>",
      "{ let a = 1 } { let b = 2 }",
    ],
  ])("%s", (_name, source, code) => {
    expect(hoisted(source)).toEqual([code]);
  });
});

describe("an import or export below the block's statements is still refused", () => {
  /** [source, line, column] of the refused declaration: 1-based line, 0-based column. */
  it.each([
    ["a nested block", 'static { { import x from "./x" } }\n<div/>', 1, 11],
    ["an if body", "static { if (a) { export const q = 1 } }\n<div/>", 1, 18],
    [
      "a function body",
      'static { function f() { import x from "./x" } }\n<div/>',
      1,
      24,
    ],
    [
      "a second block",
      'static { import x from "./x" } { import y from "./y" }\n<div/>',
      1,
      9,
    ],
    [
      "a server block nested",
      'server { { import x from "./x" } }\n<div/>',
      1,
      11,
    ],
    [
      "a client block nested",
      'client { { import x from "./x" } }\n<div/>',
      1,
      11,
    ],
    [
      "the second line of a block",
      'static {\n  { import x from "./x" }\n}\n<div/>',
      2,
      4,
    ],
  ])("%s", (_name, source, line, column) => {
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "MX_INVALID_STATEMENT",
      message: PLACEMENT,
      line,
      column,
    });
  });

  it("refuses a top-level statement that is not in a block, as before", () => {
    const { diagnostics } = lower(
      'static if (a) { import x from "./x" }\n<div/>',
    );
    expect(diagnostics[0]?.message).toBe(PLACEMENT);
  });
});

describe("a syntax error in a block with an import is reported where it is", () => {
  it("a plain syntax error, not the import", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  let a = ;\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_STATEMENT",
      message: "Unexpected token",
      line: 3,
      column: 10,
    });
  });

  it("a decorator", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  @d class C {}\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /^Decorators are not read inside a `static` statement/,
    );
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([3, 2]);
  });

  it("JSX", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  const a = <b/>;\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /^JSX is not read inside a `static` statement/,
    );
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([3, 12]);
  });

  it("the same errors in a block without an import keep their position", () => {
    const { diagnostics } = lower("static {\n  let a = ;\n}\n<div/>");
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([2, 10]);
  });
});
