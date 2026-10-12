import { expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { compileTagModule } from "../src/tag-module.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: compiler code frames may be coloured
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

type Compile = (source: string) => unknown;

const page: Compile = (source) => compile(source, "/fixtures/Test.mx");
const tag: Compile = (source) =>
  compileTagModule(source, "/fixtures/tags/badge.mx");
const ngMx: Compile = (source) =>
  compileNgMx(
    `import { Component } from "@angular/core";\n\n@Component({\n  selector: "app-x",\n  template: <div>\n    ${source}\n  </div>,\n})\nexport class XComponent {}\n`,
    "/fixtures/x.component.ng.mx",
  );

function parseReason(run: Compile, source: string) {
  try {
    run(source);
  } catch (error) {
    const message = stripAnsi((error as Error).message);
    return message
      .split("\n")
      .find((line) => /\|\s+\^/.test(line))
      ?.replace(/^.*\^ /, "");
  }
  throw new Error("Expected a parse error");
}

/** The error a compile raised: its text, code and authored position. */
function failure(run: Compile, source: string) {
  try {
    run(source);
  } catch (error) {
    const e = error as Error & {
      code?: string;
      line?: number;
      column?: number;
    };
    return {
      message: stripAnsi(e.message),
      code: e.code,
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("Expected a compile error");
}

const RULE = "scriptlets (`$ statement`) are not supported in MX";
const HINT = "Unexpected token; scriptlets (`$ …`) are not supported";
const CLASS_FIX = "declare it in the component class";
const TAG_FIX =
  "a tag has no class of its own: write the component as `.ng.mx` and declare it in its class";

// A `let` or `var` is mutable, so the immutable `<const>` fix would change its
// meaning. On a page template and in `.ng.mx` the author owns the component
// class, so the fix is a member there; a tag file has no class the author can
// write, so its fix is to write the component as `.ng.mx`.
it.each(["let", "var"])(
  "$ %s on a page template states the rule and the fix, at the statement",
  (keyword) => {
    expect(failure(page, `<p>1</p>\n$ ${keyword} x = 1;\n<p>1</p>`)).toEqual({
      message: `${RULE}; ${CLASS_FIX}`,
      code: "BABEL_TRANSFORM_ERROR",
      line: 2,
      column: 0,
    });
    expect(parseReason(page, `$ ${keyword} x = ;\n<p>1</p>`)).toBe(
      `${HINT}; ${CLASS_FIX}`,
    );
    expect(() => compile("<let/x=1/>", "/fixtures/Test.mx")).toThrow(
      "`<let>` is Marko reactive state",
    );
  },
);

it.each(["let", "var"])(
  "$ %s in a tag file names the `.ng.mx` component, not a class it cannot write",
  (keyword) => {
    expect(failure(tag, `<p>1</p>\n$ ${keyword} x = 1;\n<p>1</p>`)).toEqual({
      message: `${RULE}; ${TAG_FIX}`,
      code: "BABEL_TRANSFORM_ERROR",
      line: 2,
      column: 0,
    });
    expect(parseReason(tag, `$ ${keyword} x = ;\n<p>1</p>`)).toBe(
      `${HINT}; ${TAG_FIX}`,
    );
  },
);

it("$ const in a tag file still offers the <const> tag", () => {
  expect(failure(tag, "<p>1</p>\n$ const x = 1;\n<p>1</p>").message).toBe(
    `${RULE}; declare a value with \`<const/x=…/>\``,
  );
});

it("$ let in a .ng.mx template names the component class", () => {
  expect(failure(ngMx, "$ let x = 1;")).toEqual({
    message: `${RULE}; ${CLASS_FIX}`,
    code: "BABEL_PARSER_SYNTAX_ERROR",
    line: 6,
    column: 4,
  });
});
