const ATTR = "__mxAttrValue";

import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

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
    compileReactMx(source, "/fixtures/test.mx");
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

describe("invalid attribute names (react)", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', 5, "write `prop=`"],
    ["[attr.x]", '<div [attr.x]="y"/>', 5, "write `x=`"],
    ["[class.a]", '<div [class.a]="y"/>', 5, "class={ a: cond }"],
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
 * `<div value:foo="y"/>` is not a modifier: it is the attribute literally named
 * `value:foo`, which Marko compiles and renders as `<div value:foo=y>`.
 * Only native `class:`, `style:` and `on:` prefixes are reserved; every other
 * colon name is an ordinary attribute in Marko.
 *
 * JSX spells that attribute `value:foo={y}` — a JSXNamespacedName, which
 * every JSX frontend turns into the single string prop `"value:foo"` — so
 * this host emits Marko's attribute instead of dropping it. Rendered parity
 * with the real Marko toolchain is the `attr-value-modifier` oracle fixture
 * (`bun run oracle:react`).
 */
describe("`:modifier` is the attribute `value:modifier` (react)", () => {
  it("emits Marko's attribute, for every value kind", () => {
    expect(
      compileReactMx(`<div value:foo=y/>`, "/fixtures/test.mx").code,
    ).toContain(`<div value:foo={${ATTR}("value:foo", y, "div")} />`);
    expect(
      compileReactMx(`<div value:foo="lit"/>`, "/fixtures/test.mx").code,
    ).toContain(`<div value:foo="lit" />`);
    expect(
      compileReactMx(`<div value:foo/>`, "/fixtures/test.mx").code,
    ).toContain('<div value:foo="" />');
    // The same attribute under its long spelling: Marko compiles
    // `<div value:foo="y"/>` to the same output as `<div :foo="y"/>`.
    expect(
      compileReactMx(`<div value:foo=y/>`, "/fixtures/test.mx").code,
    ).toContain(`<div value:foo={${ATTR}("value:foo", y, "div")} />`);
  });

  // Decision 146: the bare spelling is `name`/`id`/`class` sugar, in every
  // position, compiled on this host as the attributes written out.
  it.each([
    ["<div :foo/>", '<div name="foo" />'],
    ['<input type="email" :email/>', '<input type="email" name="email" />'],
    ['<input:email type="email"/>', '<input name="email" type="email" />'],
    ["<div #main .big/>", '<div id="main" className="big" />'],
    ['<div x="1" .big/>', '<div x="1" className="big" />'],
  ])("compiles the sugar %s", (source, expected) => {
    expect(compileReactMx(source, "/fixtures/test.mx").code).toContain(
      expected,
    );
  });

  it("still refuses a real modifier, in this host's words", () => {
    expect(failure(`<div class:active=c/>`).message).toContain(
      "attribute modifier `class:active`",
    );
    expect(failure(`<div class:active=c/>`)).toMatchObject({
      line: 1,
      column: 5,
    });
  });
});
