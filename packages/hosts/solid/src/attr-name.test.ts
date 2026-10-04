import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * Marko 6.3.51 rejects an attribute name outside `[a-z_$][a-z0-9._:-]*`
 * ("Invalid attribute name.", `runtime-tags/.../pre-analyze.ts` `normalizeTag`).
 * Angular template syntax (`[prop]=`, `#ref`, `*ngIf`) is not Marko, so every
 * non-Angular host must fail at the authored name, not pass it through.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compileSolidMx(source, { filename: "fixture.solid.mx" });
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("invalid attribute names (solid)", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', 5, "write `prop=`"],
    ["[attr.x]", '<div [attr.x]="y"/>', 5, "write `x=`"],
    ["[class.a]", '<div [class.a]="y"/>', 5, "class={ a: cond }"],
    ["#ref", "<div #ref/>", 5, "reference"],
    ["*ngIf", '<div *ngIf="x"/>', 5, "<if=cond>"],
    ["$foo", "<foo $foo=1/>", 5, "attribute name"],
    ["@foo", '<div @foo="y"/>', 5, "attribute name"],
  ])("rejects %s at the authored name", (name, source, column, hint) => {
    const error = failure(source);
    expect(error.message).toContain(`Invalid attribute name \`${name}\``);
    expect(error.message).toContain(hint);
    expect(error).toMatchObject({ line: 1, column });
  });

  it("positions on the right line and column in a multi-line tag", () => {
    const error = failure(
      '<section>\n  <div class="a"\n       [prop]="x"/>\n</section>',
    );
    expect(error).toMatchObject({ line: 3, column: 7 });
  });

  it("accepts the names Marko accepts", () => {
    for (const ok of [
      '<div data-x="1"/>',
      '<div aria-label="l"/>',
      '<div a.b="1"/>',
      '<div _x="1"/>',
    ]) {
      expect(() => failure(ok)).toThrow("expected a compile error");
    }
  });
});

/**
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its LAST `:` and fills an empty head with `value`, so
 * `<div :foo="y"/>` is not a modifier: it is the attribute literally named
 * `value:foo`, which Marko compiles and renders as `<div value:foo=y>`.
 * `class:active` is the modifier Marko's *taglib* refuses; `:foo` is the one
 * modifier form Marko accepts.
 *
 * Solid's JSX takes the namespaced attribute (`value:foo={y}`); both Solid 2
 * backends turn it into `setAttribute(el, "value:foo", …)`, which is the one
 * place a colon-named attribute can land in a DOM.
 */
describe("`:modifier` is the attribute `value:modifier` (solid)", () => {
  it("emits Marko's attribute, for every value kind", () => {
    expect(
      compileSolidMx(`<div :foo=y/>`, { filename: "fixture.solid.mx" }).code,
    ).toContain("<div value:foo={y}>");
    expect(
      compileSolidMx(`<div :foo="lit"/>`, { filename: "fixture.solid.mx" })
        .code,
    ).toContain(`<div value:foo="lit">`);
    expect(
      compileSolidMx(`<div :foo/>`, { filename: "fixture.solid.mx" }).code,
    ).toContain('<div value:foo="">');
    // The same attribute under its long spelling: Marko compiles
    // `<div value:foo="y"/>` to the same output as `<div :foo="y"/>`.
    expect(
      compileSolidMx(`<div value:foo=y/>`, { filename: "fixture.solid.mx" })
        .code,
    ).toContain("<div value:foo={y}>");
  });

  it.each([
    ["<div :/>", "value:", '""'],
    ["<div x:/>", "x:", '""'],
    ['<div x: = "s"/>', "x:", '"s"'],
    ["<div x: = input.x/>", "x:", "input.x"],
    ['<div value:foo:bar="y"/>', "value:foo:bar", '"y"'],
    ["<div value:foo:bar=y/>", "value:foo:bar", "y"],
  ])(
    "uses a string-keyed spread for a name JSX cannot spell: %s",
    (source, name, value) => {
      expect(
        compileSolidMx(source, { filename: "fixture.solid.mx" }).code,
      ).toContain(` {...{${JSON.stringify(name)}: (${value})}}`);
    },
  );

  it("maps the string-keyed spread's name and value to their authored tokens", () => {
    const source = '<div id="a" value:foo:bar=x class="c"/>';
    const { code, mappings } = compileSolidMx(source, {
      filename: "fixture.solid.mx",
    });
    for (const [generated, authored] of [
      ['"value:foo:bar"', "value:foo:bar"],
      ["(x)", "x"],
    ] as const) {
      const generatedStart =
        code.indexOf(generated) + (generated === "(x)" ? 1 : 0);
      const sourceStart = source.indexOf(
        authored,
        source.indexOf("value:foo:bar"),
      );
      expect(mappings).toContainEqual({
        generatedStart,
        generatedEnd:
          generatedStart + (generated === "(x)" ? 1 : generated.length),
        sourceStart,
        sourceEnd: sourceStart + authored.length,
      });
    }
  });

  it.each(["class", "style"])(
    "refuses an empty %s modifier rather than dropping its colon",
    (name) => {
      expect(failure(`<div ${name}:/>`).message).toContain(
        `attribute modifier \`${name}:\``,
      );
    },
  );

  it("rejects reserved on: with Marko's error", () => {
    expect(failure("<div on:/>")).toEqual({
      message: "`on:` is not a valid attribute, did you mean `on`?",
      line: 1,
      column: 5,
    });
  });

  it("does not turn an empty-suffixed event into a string-keyed attribute spread", () => {
    expect(failure("<div onClick: = fn/>").message).toContain("click:");
  });

  it("still refuses a real modifier, in this host's words", () => {
    expect(failure(`<div class:active=c/>`).message).toContain(
      "attribute modifier `class:active` is not supported by Solid",
    );
    expect(failure(`<div class:active=c/>`)).toMatchObject({
      line: 1,
      column: 5,
    });
  });
});
