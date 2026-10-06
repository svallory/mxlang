// Decision 168: the statement tags are declared to the parser on every
// target, so a statement whose text the attribute grammar cannot read (a typed
// return, `<T,>`, JSX, an atom) compiles as the statement it is.
import { describe, expect, it } from "vitest";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const KINDS: Array<[string, string, string]> = [
  [
    "typed function",
    "static function f(a: number): string { return String(a) }",
    "function f(a: number): string { return String(a) }",
  ],
  [
    "typed export function",
    "export function f(a: number): string { return '' }",
    "export function f(a: number): string { return '' }",
  ],
  [
    "<T,> generic",
    "static const f = <T,>(x: T): T => x",
    "const f = <T,>(x: T): T => x",
  ],
  ["JSX in a statement", "static const el = <b>hi</b>", "const el = <b>hi</b>"],
  [
    "atom text",
    "static const a = { k: :name, x: .y, z: #w }",
    "const a = { k: :name, x: .y, z: #w }",
  ],
  [
    "multi-line import",
    'import {\n  a,\n  b,\n} from "./x"',
    'import {\n  a,\n  b,\n} from "./x"',
  ],
];

const out = (s: string): string => compilePreactMx(s, "/f/t.mx").code;
function fail(source: string): { message: string; line: number } {
  try {
    out(source);
  } catch (error) {
    return error as { message: string; line: number };
  }
  throw new Error("expected a compile error");
}

describe("statement tags (preact)", () => {
  for (const [name, source, emitted] of KINDS) {
    it(`compiles a ${name} statement`, () => {
      expect(out(source)).toContain(emitted);
    });
  }

  for (const word of ["client", "server"]) {
    it(`refuses \`${word}\` with a positioned message`, () => {
      const error = fail(`${word} console.log(1)\n<div/>`);
      expect(error.message).toContain(`\`${word}\``);
      expect(error.line).toBe(1);
    });
  }

  it("refuses `class` with the one not-supported message", () => {
    const error = fail("class { x = 1 }\n<div/>");
    expect(error.message).toContain("`class { … }` is not supported in MX");
    expect(error.line).toBe(1);
  });
});

describe("statement tags in a `.preact.mx` region", () => {
  for (const [name, source] of KINDS) {
    it(`is refused as a module-level statement: ${name}`, () => {
      expect(() =>
        compilePreactRegion(source, { filename: "/f/t.preact.mx" }),
      ).toThrow(
        /module-level MX statements cannot appear inside a `.preact.mx`/,
      );
    });
  }
});
