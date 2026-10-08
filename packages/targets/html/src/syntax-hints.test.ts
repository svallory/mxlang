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
      "EOF reached while parsing expression; scriptlets (`$ …`) are not supported; declare a value with `<let/count=…/>` (initial value only on this target)",
    );
  });

  it.each(["let", "var"])(
    "names the %s construct with its initial-value limit; strict mode omits advice",
    (keyword) => {
      const source = `$ ${keyword} x = 1;\n<p>\${x}</p>`;
      expect(failure(source).message).toBe(
        "scriptlets (`$ statement`) are not supported in MX (decision 54); declare a value with `<let/x=…/>` (initial value only on this target)",
      );
      expect(() =>
        compile(`<let/x=1/><p>\${x}</p>`, "/fixtures/test.mx"),
      ).not.toThrow();
      expect(() =>
        compile(source, "/fixtures/test.mx", { strict: true }),
      ).toThrow(
        /^scriptlets \(`\$ statement`\) are not supported in MX \(decision 54\)$/,
      );
      expect(() =>
        compile("<let/x=1/>", "/fixtures/test.mx", { strict: true }),
      ).toThrow("`<let>` is reactive state");
    },
  );

  it.each(["let", "var"])(
    "a malformed $ %s gets the same initial-value warning",
    (keyword) => {
      expect(reasonOf(failure(`$ ${keyword} x = ;\n<p>1</p>`).message)).toBe(
        "Unexpected token; scriptlets (`$ …`) are not supported; declare a value with `<let/x=…/>` (initial value only on this target)",
      );
    },
  );

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
      "Tag does not support arguments.",
    );
  });

  it("points at the argument, as Marko does", () => {
    // Marko: "Tag does not support arguments." at `args[0].loc.start`, so
    // `<button (click)=…` is reported under `click` (column 9), not under
    // `<button`. There is no `onClick=` hint here because this host has no
    // event-handler form to suggest — `eventHandlerHint` is gated on
    // `resolveAttributeMethod`, which `@mxlang/html` does not declare.
    expect(failure('<div (click)="f()"/>')).toMatchObject({
      line: 1,
      column: 6,
    });
    expect(failure('<button (click)="go()">x</button>')).toMatchObject({
      line: 1,
      column: 9,
    });
    expect(failure('<div\n  (click)="f()"/>')).toMatchObject({
      line: 2,
      column: 3,
    });
  });
});

describe("round 2 (html)", () => {
  const frames = (message: string) =>
    message
      .split("\n")
      .filter((line) => /\|\s+\^/.test(line))
      .map((line) => line.replace(/^.*\^ /, ""));
  const noValue = (name: string) =>
    `Unexpected token, expected "{"; \`${name}=\` has no value; write \`${name}="…"\` or \`${name}=expr\`, or drop the \`=\``;

  it("F1: each frame of a 2-error aggregate gets its own attribute's hint", () => {
    const { message } = failure(
      '<div id= class="a">a</div>\n<div title= class="b">b</div>',
    );
    expect(frames(message)).toEqual([noValue("id"), noValue("title")]);
  });

  it("F1: a 3-error aggregate keeps every frame on its own attribute", () => {
    const { message } = failure(
      '<div id= class="a">a</div>\n<div title= class="b">b</div>\n<div href= class="c">c</div>',
    );
    expect(frames(message)).toEqual([
      noValue("id"),
      noValue("title"),
      noValue("href"),
    ]);
  });

  it.each([
    ["serach", undefined],
    ["saerch", undefined],
    ["slto", undefined],
    ["solt", undefined],
    ["dvi", "div"],
    ["buton", "button"],
    ["sapn", "span"],
    ["tabl", "table"],
    ["labl", "label"],
    ["nava", "nav"],
    ["fromm", "form"],
    ["buttun", "button"],
    ["tabel", undefined], // tie: table / label
    ["headr", undefined], // tie: header / head
    ["sp", undefined],
    ["my-widget", undefined],
  ])("F3: <%s> suggests %s, and the suggestion compiles", (typo, expected) => {
    const { message } = failure(`<${typo}/>`);
    const suggested = /Did you mean `<([^>]+)>`\?/.exec(message)?.[1];
    expect(suggested).toBe(expected);
    if (suggested) {
      expect(() =>
        compile(`<${suggested}/>`, "/fixtures/test.mx"),
      ).not.toThrow();
    }
  });

  it.each([
    ["a call", "$ doThing(;"],
    ["an assignment", "$ x = ;"],
    ["a destructuring", "$ const { a, b } = ;"],
    ["a multi-declarator", "$ const x = 1, y = ;"],
    ["a class", "$ class Foo {;"],
    ["an import", "$ import Foo from ;"],
  ])("F4: %s does not claim to declare a value", (_label, line) => {
    const { message } = failure(`${line}\n<p>1</p>`);
    const reason = reasonOf(message) ?? "";
    expect(reason).toContain("scriptlets (`$ …`) are not supported");
    expect(reason).not.toContain("declare");
  });

  it("F4: a valid non-declaring scriptlet gets the bare sentence", () => {
    expect(failure("$ doThing();\n<p>1</p>").message).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54)",
    );
    expect(failure("$ const { a } = x;\n<p>1</p>").message).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54)",
    );
  });

  it("F5: `$ …` text inside a multi-line attribute expression is not a scriptlet", () => {
    const { message } = failure("<div class={\n  $ const x = ;\n}>x</div>");
    expect(reasonOf(message)).not.toContain("scriptlet");
  });

  it.each([
    ["a quoted `{` before the line", '<div title="{">\n$ const x = ;\n</div>'],
    ["a single-quoted `{`", "<div title='{'>\n$ const x = ;\n</div>"],
    ["a backtick `{`", "<div title=`{`>\n$ const x = ;\n</div>"],
  ])("R2-2: %s does not suppress the scriptlet hint", (_label, source) => {
    expect(reasonOf(failure(source).message)).toContain(
      "scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>`",
    );
  });

  it("R2-2: a real open brace still suppresses it, quotes inside or not", () => {
    for (const source of [
      "<div class={\n  $ const x = ;\n}>x</div>",
      '<div class={\n  "}" +\n  $ const x = ;\n}>x</div>',
    ]) {
      expect(reasonOf(failure(source).message)).not.toContain("scriptlet");
    }
  });
});
