// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A module name is declared once across the module statements, for the html
 * target as for every other (the check is core's). Stock Marko refuses
 * `import x` + `static const x` at compile time; the html target does too,
 * with a positioned error, instead of emitting a module that cannot load. Two
 * `var`s of a name merge and still compile.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

function failure(source: string): Error & { line?: number; column?: number } {
  try {
    compile(source, "/f/t.mx");
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a compile error");
}

describe("html: a module name declared twice", () => {
  it("is refused at the second declaration, with where the first is", () => {
    const error = failure('import x from "./x"\nstatic const x = 1\n<div/>\n');
    expect(error).toMatchObject({ line: 2, column: 13 });
    expect(error.message).toContain(
      'Duplicate declaration "x": it is already declared at 1:8.',
    );
  });

  it("is refused across `static` and `server` too", () => {
    const error = failure(
      "static const q = 1\nserver const q = 2\n<div>${q}</div>\n",
    );
    expect(error).toMatchObject({ line: 2, column: 13 });
  });

  it("compiles when both declarations are `var`", () => {
    const { code } = compile(
      "static var v = 1\nstatic var v = 2\n<div>${v}</div>\n",
      "/f/t.mx",
    );
    expect(code).toContain("var v = 1");
    expect(code).toContain("var v = 2");
  });

  it("refuses a name exported by two statements, at the second export", () => {
    const error = failure(
      "static const q = 1\nstatic export { q }\nserver export { q }\n<div/>\n",
    );
    expect(error).toMatchObject({ line: 3, column: 16 });
    expect(error.message).toContain(
      'Duplicate export "q": the module already exports that name at 2:17',
    );
  });

  it("refuses an exported enum and its list in one block, positioned at the list", () => {
    const error = failure(
      "static { export enum q { A }; export { q } }\n<div/>\n",
    );
    expect(error).toMatchObject({ line: 1, column: 39 });
    expect(error.message).toContain(
      'Duplicate export "q": the module already exports that name at 1:22',
    );
  });

  it("refuses an export list naming nothing the module declares", () => {
    const error = failure("static export { q }\n<div/>\n");
    expect(error).toMatchObject({ line: 1, column: 16 });
    expect(error.message).toContain("Export 'q' is not defined in module");
  });
});
