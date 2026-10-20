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

const STRIP_DUPLICATE_MESSAGE =
  'Duplicate declaration "q": it is already declared at 1:20. A namespace with values followed by an enum of its name in one block creates two bindings. Declare the enum first, or put the namespace\'s values in a namespace after an earlier enum of that name.';

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
    expect(error).toMatchObject({
      line: 1,
      column: 39,
      end: { line: 1, column: 40 },
    });
    expect(error.message).toContain(
      'Duplicate export "q": the module already exports that name at 1:22',
    );
  });

  it("refuses an export list naming nothing the module declares", () => {
    const error = failure("static export { q }\n<div/>\n");
    expect(error).toMatchObject({ line: 1, column: 16 });
    expect(error.message).toContain("Export 'q' is not defined in module");
  });

  it("refuses a namespace with values and an enum of its name in one block, at the enum", () => {
    const error = failure(
      "static { namespace q { export const b = 1 }; export enum q {A} }\n<div/>\n",
    );
    expect(error).toMatchObject({ line: 1, column: 57 });
    expect(error.message).toBe(STRIP_DUPLICATE_MESSAGE);
  });

  it.each([
    [
      "a trailing namespace",
      "static { namespace q { export const b = 1 }; export enum q {A}; namespace q { export const c = 2 } }",
      1,
      57,
    ],
    [
      "a trailing enum",
      "static { namespace q { export const b = 1 }; export enum q {A}; export enum q {B = 2} }",
      1,
      57,
    ],
    [
      "a trailing namespace in a function",
      "static function f() { namespace q { export const b = 1 }; enum q {A}; namespace q { export const c = 2 } }",
      1,
      63,
    ],
    [
      "a trailing enum on another line",
      "static {\n  namespace q { export const b = 1 }\n  export enum q {A}\n  export enum q {B = 2}\n}",
      3,
      14,
    ],
  ])(
    "positions the colliding enum despite %s",
    (_label, source, line, column) => {
      expect(failure(`${source}\n<div/>\n`)).toMatchObject({
        diagnosticCode: "MX_DUPLICATE_DECLARATION",
        line,
        column,
        end: { line, column: column + 1 },
      });
    },
  );

  it("positions a collision with only an ambient namespace partner", () => {
    const error = failure(
      "static { namespace o { declare namespace q { const b: number }; enum q {A} } }\n<div/>\n",
    );
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 1,
      column: 69,
      end: { line: 1, column: 70 },
    });
    expect(error.message).toBe(STRIP_DUPLICATE_MESSAGE.replace("1:20", "1:42"));
  });

  it.each([
    [
      "function",
      "static function f() { namespace q { export const b = 1 }; enum q {A} }",
      63,
    ],
    [
      "if",
      "static if (true) { namespace q { export const b = 1 }; enum q {A} }",
      60,
    ],
  ])("gives loadable advice for a %s body", (_label, source, column) => {
    const error = failure(`${source}\n<div/>\n`);
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 1,
      column,
      end: { line: 1, column: column + 1 },
    });
    expect(error.message).toContain(
      "A namespace is only allowed at the top level of a module or of another namespace. Move the namespace there.",
    );
    expect(error.message).not.toContain("Declare the enum first");
  });

  it.each([
    [
      "Z1: alias before an exported enum",
      "static { import q = Math; export enum q {A} }",
    ],
    [
      "Z2: exported enum before an alias",
      "static { export enum q {A}; import q = Math }",
    ],
    [
      "Z9: alias and enum in a function",
      "static function f() { import q = Math; enum q {A} }",
    ],
    [
      "Y11: alias before a plain enum",
      "static { import q = Math; enum q {A} }",
    ],
    [
      "Y12: plain enum before an alias",
      "static { enum q {A}; import q = Math }",
    ],
    [
      "K25: alias before an enum, namespace after",
      "static { import q = Math; export enum q {A}; export namespace q { export const b = 1 } }",
    ],
    [
      "K26: enum, alias, namespace after",
      "static { export enum q {A}; import q = Math; export namespace q { export const b = 1 } }",
    ],
    [
      "K29: enum, namespace, alias last",
      "static { export enum q {A}; export namespace q { export const b = 1 }; import q = Math }",
    ],
  ])("keeps %s as the unchanged raw strip error", (_label, source) => {
    const error = failure(`${source}\n<div/>\n`);
    expect(error).toBeInstanceOf(TypeError);
    // The strip's code frame is coloured when the run has a colour mode
    // (CI, the gate), and plain under NO_COLOR: compare without escapes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
    const plain = error.message.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toBe('Duplicate declaration "q"\n> 1 |\n    | ^');
    expect(error).not.toHaveProperty("diagnosticCode");
    expect(error).not.toHaveProperty("end");
  });

  it("compiles a namespace with values beside a const enum of its name", () => {
    const { code } = compile(
      "static { namespace q { export const b = 1 }; export const enum q {A} }\n<div/>\n",
      "/f/t.mx",
    );
    // The `const enum` is erased by the strip, so the pair binds one value;
    // stock 6.4.4 loads the form and the module loads under MX's own strips
    // (tsc, Bun.Transpiler, esbuild).
    expect(code).toContain("namespace q");
    expect(code).toContain("export const enum q {A}");
  });

  it("compiles an enum after a namespace whose members bind nothing", () => {
    const { code } = compile(
      "static { namespace q { export declare const b: number; import y = Math }; export enum q {A} }\n<div/>\n",
      "/f/t.mx",
    );
    // These exported ambient members and import aliases leave no binding, so the
    // strip erases the namespace and the enum is the only binding of `q`
    // (stock 6.4.4 compiles and loads the form, html and dom).
    expect(code).toContain("export enum q {A}");
  });

  it.each([
    "static { export enum q {A}; namespace q { export const b = 1 }; export enum q {B = 2} }",
    "static { export enum q {A}; export namespace q { export const b = 1 }; export enum q {B = 2} }",
  ])("compiles the legal enum–namespace–enum merge: %s", (source) => {
    expect(() => compile(`${source}\n<div/>\n`, "/f/t.mx")).not.toThrow();
  });

  it("positions a strip collision from a non-exported ambient member", () => {
    const error = failure(
      "static { namespace q { declare const b: number }; export enum q {A} }\n<div/>\n",
    );
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 1,
      column: 62,
      end: { line: 1, column: 63 },
    });
    expect(error.message).toBe(STRIP_DUPLICATE_MESSAGE);
  });

  it("refuses an enum after a namespace holding only a const enum", () => {
    const error = failure(
      "static { namespace q { export const enum E {X} }; export enum q {A} }\n<div/>\n",
    );
    // A `const enum` inside the namespace leaves the strip a binding for it
    // (stock 6.4.4 refuses the pair at the same position), so the namespace
    // holds a value and the enum collides.
    expect(error).toMatchObject({ line: 1, column: 62 });
    expect(error.message).toBe(STRIP_DUPLICATE_MESSAGE);
  });
});
