// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `export = x` and `import x = require("m")` in a `static`, `server`, `client`
 * or `export` statement, compiled through the html target.
 *
 * They used to throw Babel's CommonJS error from a position of the generated
 * code (189:16) with no code. They are refused at the statement now, with the
 * line and column of the TypeScript statement (`packages/core/src/
 * commonjs-statements.test.ts` pins the IR entry).
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const EXPORT_EQUALS =
  "`export = <value>;` is only supported when compiling modules to CommonJS. Use a named export instead (`export const x = …`, or `export { x }`).";
const IMPORT_REQUIRE =
  '`import T = require(...);` is only supported when compiling modules to CommonJS. Write `import T from "x"`';
const IMPORT_TYPE_REQUIRE =
  '`import T = require(...);` is only supported when compiling modules to CommonJS. Write `import type T from "x"`';

const TEMPLATE = "\n<div/>\n";

type Thrown = {
  line?: number;
  column?: number;
  end?: { line: number; column: number };
  message?: string;
};

function thrownBy(source: string): Thrown {
  try {
    compile(`${source}${TEMPLATE}`, "/f/t.mx");
  } catch (error) {
    return error as Thrown;
  }
  return {};
}

describe("html: a CommonJS form in a module statement is refused with a position", () => {
  it.each([
    ["static export =", "static export = foo;", EXPORT_EQUALS, 1, 7, 13],
    ["server export =", "server export = foo;", EXPORT_EQUALS, 1, 7, 13],
    ["client export =", "client export = foo;", EXPORT_EQUALS, 1, 7, 13],
    [
      "static import = require",
      'static import T = require("x");',
      IMPORT_REQUIRE,
      1,
      7,
      24,
    ],
    [
      "server import = require",
      'server import T = require("x");',
      IMPORT_REQUIRE,
      1,
      7,
      24,
    ],
    [
      "client import = require",
      'client import T = require("x");',
      IMPORT_REQUIRE,
      1,
      7,
      24,
    ],
    [
      "static import type = require",
      'static import type T = require("x");',
      IMPORT_TYPE_REQUIRE,
      1,
      7,
      29,
    ],
    [
      "a static block, export =",
      "static { export = foo; }",
      EXPORT_EQUALS,
      1,
      9,
      13,
    ],
    [
      "a server block, import = require",
      'server { import T = require("x"); }',
      IMPORT_REQUIRE,
      1,
      9,
      24,
    ],
    [
      "a client block, export =",
      "client { export = foo }",
      EXPORT_EQUALS,
      1,
      9,
      12,
    ],
    [
      "a block on its own lines",
      "static {\n  const a = 1;\n  export = a;\n}",
      EXPORT_EQUALS,
      3,
      2,
      11,
    ],
    ["a top-level export =", "export = foo;", EXPORT_EQUALS, 1, 0, 13],
  ])("%s", (_name, statement, message, line, column, length) => {
    const error = thrownBy(statement);
    expect(error.message).toBe(message);
    expect([error.line, error.column]).toEqual([line, column]);
    // The span ends where the TypeScript statement ends, on the same line.
    expect(error.end?.line).toBe(line);
    expect(error.end?.column).toBe(column + length);
  });

  it("is never Babel's error from the generated code", () => {
    const error = thrownBy("static export = foo;");
    expect(error.line).toBeLessThan(10);
    expect(error.message).not.toMatch(/plugin-transform-modules-commonjs/);
  });

  it("still refuses a top-level `import T = require()` as before", () => {
    const error = thrownBy('import T = require("x");');
    expect(error.message).toMatch(/^an `import` statement must be one ES/);
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it.each([
    "static import A = B.C;",
    "static export import A = B.C;",
    "static { import A = B.C; }",
    "static export const a = 1;",
  ])("compiles %s", (statement) => {
    expect(() => compile(`${statement}${TEMPLATE}`, "/f/t.mx")).not.toThrow();
  });
});
