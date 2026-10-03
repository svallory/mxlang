import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Marko's own parse errors say what the parser could not read, not what to
 * write (audit item 14, cases h10/h12/p06). MX appends one fix hint to the
 * reason, in place; every suggested fix is compiled here.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line?: number;
  column?: number;
} {
  try {
    compile(source, "/fixtures/test.mx");
  } catch (error) {
    const e = error as { message: string; line?: number; column?: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

/** The reason line of Marko's code frame: `   |   ^ <reason>`. */
const reasonOf = (message: string) =>
  message
    .split("\n")
    .find((line) => /\|\s+\^/.test(line))
    ?.replace(/^.*\^ /, "");

describe("attribute with no value (html)", () => {
  it("h10: `id= class=…` says the attribute needs a value", () => {
    const { message } = failure('<div id= class="a">x</div>');
    expect(reasonOf(message)).toBe(
      'Unexpected token, expected "{"; `id=` has no value; write `id="…"` or `id=expr`, or drop the `=`',
    );
    // Same position as Marko's own error: the second `=`, 1:15.
    expect(message).toContain("1:15");
  });

  it("names the right attribute in the middle of a tag and on a later line", () => {
    const { message } = failure(
      '<p>\n  <a href="/x" title=\n     class="b">y</a>\n</p>',
    );
    expect(reasonOf(message)).toContain("`title=` has no value");
  });

  it("each form the hint suggests compiles", () => {
    for (const ok of [
      '<div id="a" class="a">x</div>',
      '<div id=input.id class="a">x</div>',
      '<div id class="a">x</div>',
    ]) {
      expect(() => compile(ok, "/fixtures/test.mx")).not.toThrow();
    }
  });

  it("leaves an unrelated `expected {` error alone", () => {
    const { message } = failure("<div class=>x</div>");
    expect(reasonOf(message)).not.toContain("has no value");
  });
});

describe("scriptlets (html)", () => {
  it("h12: a syntax error in a `$` line says scriptlets are unsupported", () => {
    const { message } = failure("$ const x = ;\n<p>1</p>");
    expect(reasonOf(message)).toBe(
      "Unexpected token; scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>`",
    );
    expect(message).toContain("1:13");
  });

  it("p09-shaped: an unterminated expression names the declared variable", () => {
    const { message } = failure("$ let count = {;\n<p>1</p>");
    expect(reasonOf(message)).toBe(
      "EOF reached while parsing expression; scriptlets (`$ …`) are not supported; declare a value with `<const/count=…/>`",
    );
  });

  it("a valid scriptlet carries the same fix", () => {
    expect(failure(`$ const x = 1;\n<p>\${x}</p>`).message).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54); declare a value with `<const/x=…/>`",
    );
  });

  it("the form it suggests compiles", () => {
    expect(() =>
      compile(`<const/x=1/>\n<p>\${x}</p>`, "/fixtures/test.mx"),
    ).not.toThrow();
  });

  it("does not touch an error on a line that merely contains `$`", () => {
    const { message } = failure('<p>$5</p>\n<div id= class="a">x</div>');
    expect(reasonOf(message)).not.toContain("scriptlet");
  });
});

describe("event binding syntax (html)", () => {
  it("stays as it was: this host renders once and has no event handlers", () => {
    expect(failure('<button (click)="go()">x</button>').message).toBe(
      "tag arguments `(...)` on `<button>` are not supported in a standalone template",
    );
  });
});
