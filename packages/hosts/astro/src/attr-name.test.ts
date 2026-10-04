import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// Marko 6.3.51 rejects an attribute name outside `[a-z_$][a-z0-9._:-]*`
// ("Invalid attribute name."); Angular syntax is not Marko, so `.astro.mx` fails
// at the authored name too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;
const FENCE = "---\nconst x = 1;\n---\n"; // 3 fence lines: template starts on line 4

function failure(template: string) {
  try {
    lowerAstroMx(`${FENCE}${template}`, "Test.astro.mx");
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

describe("invalid attribute names (astro)", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', "write `prop=`"],
    ["[attr.x]", '<div [attr.x]="y"/>', "write `x=`"],
    ["#ref", "<div #ref/>", "reference"],
    ["*ngIf", '<div *ngIf="x"/>', "<if=cond>"],
    ["$foo", "<foo $foo=1/>", "attribute name"],
    ["@foo", '<div @foo="y"/>', "attribute name"],
  ])("rejects %s at the authored name", (name, source, hint) => {
    const error = failure(source);
    expect(error.message).toContain(`Invalid attribute name \`${name}\``);
    expect(error.message).toContain(hint);
    expect(error).toMatchObject({ line: 4, column: 5 });
  });

  it("accepts the names Marko accepts", () => {
    for (const ok of ['<div data-x="1"/>', '<div a.b="1"/>', '<div _x="1"/>']) {
      expect(() =>
        lowerAstroMx(`${FENCE}${ok}`, "Test.astro.mx"),
      ).not.toThrow();
    }
  });
});

/**
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its LAST `:` and fills an empty head with `value`, so
 * `<div :foo="y"/>` is not a modifier: it is the attribute literally named
 * `value:foo`, which Marko compiles and renders as `<div value:foo=y>`.
 * Only native `class:`, `style:` and `on:` prefixes are reserved; other colon
 * names are ordinary. An `.astro.mx` template body is HTML, so the shorthand
 * is written `value:foo={y}` there too.
 */
describe("`:modifier` is the attribute `value:modifier` (astro)", () => {
  const template = (source: string): string =>
    lowerAstroMx(`${FENCE}${source}`, "Test.astro.mx").code;

  it("emits Marko's attribute, for every value kind", () => {
    expect(template(`<div :foo=y/>`)).toContain("<div value:foo={y}>");
    expect(template(`<div :foo="lit"/>`)).toContain(`<div value:foo="lit">`);
    expect(template(`<div :foo/>`)).toContain(`<div value:foo="">`);
    // The `{…}` form, emitted exactly like any other dynamic attribute on
    // this host (`<div id={y}/>` emits `id={{y}}`: the outer braces are
    // Astro's interpolation, the inner ones the MX expression).
    expect(template(`<div :foo={y}/>`)).toContain("<div value:foo={{y}}>");
    // The same attribute under its long spelling: Marko compiles
    // `<div value:foo="y"/>` to the same output as `<div :foo="y"/>`.
    expect(template(`<div value:foo=y/>`)).toContain("<div value:foo={y}>");
  });

  it("still refuses a real modifier, in this host's words", () => {
    const error = failure(`<div class:active="x"/>`);
    expect(error.message).toContain(
      "attribute modifier `class:active` is not supported in an `.astro.mx` template",
    );
    expect(error).toMatchObject({ line: 4, column: 5 });
  });
});
