// Decision 168: the statement tags are declared to the parser on every
// target, so a statement whose text the attribute grammar cannot read (a typed
// return, `<T,>`) compiles as the statement it is.
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

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
  [
    "multi-line import",
    'import {\n  a,\n  b,\n} from "./x"',
    'import {\n  a,\n  b,\n} from "./x"',
  ],
];

const out = (s: string): string => compileReactMx(s, "/f/t.mx").code;
function fail(source: string): { message: string; line: number } {
  try {
    out(source);
  } catch (error) {
    return error as { message: string; line: number };
  }
  throw new Error("expected a compile error");
}

const ANGULAR = false;

describe("statement tags (react)", () => {
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

// Marko parses a statement's text and reports its syntax errors at the
// offending character; MX matches it on every target (#395 r2), so a statement
// that swallows the next template line, or holds JSX or an atom, is a positioned
// error and never a silent drop. Valid joins compile, as in Marko.
describe("statement text is checked like Marko checks it", () => {
  const REFUSED: Array<[string, string, string, number, number]> = [
    [
      "JSX",
      "static const el = <b>hi</b>\n<div/>",
      "Unterminated regular expression.",
      1,
      25,
    ],
    [
      "export JSX",
      "export const el = <b>hi</b>\n<div/>",
      "Unterminated regular expression.",
      1,
      25,
    ],
    [
      "a line ending in `>` joins the template line",
      "static const ok = 2 >\n<div>${ok}</div>",
      "Missing semicolon.",
      2,
      6,
    ],
    [
      "atom text",
      "static const a = { k: :name }\n<div/>",
      "Unexpected token",
      1,
      22,
    ],
  ];
  for (const [name, source, message, line, column] of REFUSED) {
    it(`refuses ${name}, positioned`, () => {
      const error = fail(source);
      expect(error.message).toBe(message);
      expect(error.line).toBe(line);
      expect((error as { column?: number }).column).toBe(column);
    });
  }
  if (!ANGULAR) {
    it("joins a line ending in an operator when the result is valid", () => {
      expect(out("static const t = 1 +\n2\n<div>${t}</div>")).toContain(
        "1 +\n2",
      );
    });
  }
});
