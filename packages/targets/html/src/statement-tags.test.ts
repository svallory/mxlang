// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
// Decision 168: `class { … }` is one positioned "not supported" error on every
// target, html included (it replaces "Unable to find entry point").
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

it("refuses `class` with the not-supported message at its line", () => {
  try {
    compile("<div/>\nclass { x = 1 }\n", "/f/t.mx");
  } catch (error) {
    const e = error as { message: string; line: number };
    expect(e.message).toContain("`class { … }` is not supported in MX");
    expect(e.line).toBe(2);
    return;
  }
  throw new Error("expected a compile error");
});

it("still runs a `server` statement and drops a `client` one", () => {
  expect(compile("server console.log(1)\n<div/>", "/f/t.mx").code).toContain(
    "console.log(1)",
  );
  expect(
    compile("client console.log(1)\n<div/>", "/f/t.mx").code,
  ).not.toContain("console.log(1)");
});

// #395 r3: a `server` statement html runs and a `client` statement html drops
// are checked like every statement first, at Marko 6.3.51's positions (its
// 1-based columns are one more): an invalid join is never a silent drop.
describe("server and client statement text is checked like Marko", () => {
  const errorOf = (source: string) => {
    try {
      compile(source, "/f/t.mx");
    } catch (error) {
      return error as { message: string; line: number; column: number };
    }
    throw new Error("expected a compile error");
  };

  it.each([
    [
      "server JSX",
      "server const el = <b>hi</b>\n<div/>",
      "Unterminated regular expression.",
      1,
      25,
    ],
    [
      "server swallowing join",
      "server const a = 2 >\n<div>${a}</div>",
      "Missing semicolon.",
      2,
      6,
    ],
    [
      "client invalid text",
      "client const = ;\n<div/>",
      "Unexpected token",
      1,
      13,
    ],
    [
      "client swallowing join",
      "client const a = 2 >\n<div>${a}</div>",
      "Missing semicolon.",
      2,
      6,
    ],
  ])("%s is a positioned error", (_label, source, message, line, column) => {
    const error = errorOf(source);
    expect([error.message, error.line, error.column]).toEqual([
      message,
      line,
      column,
    ]);
  });

  it("leaves a valid server statement and the template after it unchanged", () => {
    const { code } = compile("server console.log(1)\n<div/>", "/f/t.mx");
    expect(code).toContain("console.log(1)");
    expect(code).toContain("<div></div>");
  });
});
