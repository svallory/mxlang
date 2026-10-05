import { parseTemplate } from "@angular/compiler";
import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

// Angular template syntax is the host's own vocabulary: the name check the
// other hosts apply (Marko's "Invalid attribute name.") must not reach it.
describe("Angular attribute-name passthrough", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', '[prop]="x"'],
    ["[attr.x]", '<div [attr.x]="y"/>', '[attr.x]="y"'],
    ["#ref", "<div #ref>hi</div>", "#ref"],
    ["*ngIf", '<div *ngIf="x">hi</div>', '*ngIf="x"'],
  ])("passes %s through to the template", (_name, source, expected) => {
    expect(emit(source, "x.ng.mx")).toContain(expected);
  });
});

/**
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its LAST `:` and fills an empty head with `value`, so
 * `<div :foo="y"/>` is not a modifier: it is the attribute literally named
 * `value:foo`, which Marko compiles and renders as `<div value:foo=y>`.
 * Only native `class:`, `style:` and `on:` prefixes are reserved; every other
 * colon name (including `attr:`) is an ordinary attribute in Marko.
 *
 * A static one is carried verbatim (Angular passes an unknown static attribute
 * through to the DOM); a dynamic one cannot be a property binding — `[value:foo]`
 * is a property no element has, NG8002 — so it takes the same `[attr.name]`
 * route as `data-*`/`aria-*`.
 */
describe("`:modifier` is the attribute `value:modifier` (angular)", () => {
  it("emits Marko's attribute, statically and dynamically", () => {
    expect(emit(`<div value:foo="lit"/>`, "x.ng.mx")).toContain(
      `<div value:foo="lit">`,
    );
    expect(emit(`<div value:foo/>`, "x.ng.mx")).toContain(`<div value:foo="">`);
    expect(emit(`<div value:foo=y/>`, "x.ng.mx")).toContain(
      `<div [attr.value:foo]="y">`,
    );
  });

  // Decision 146, addendum 3: Angular gets the sugar. The one host-owned
  // exception is attribute-position `#x`, Angular's template reference.
  it("applies the name sugar in every position but attribute-position `#x`", () => {
    expect(emit(`<div :foo/>`, "x.ng.mx")).toContain(`<div name="foo">`);
    expect(emit(`<input:email type="email"/>`, "x.ng.mx")).toContain(
      `<input name="email" type="email">`,
    );
    expect(emit(`<div .b/>`, "x.ng.mx")).toContain(`<div class="b">`);
    expect(emit(`<div#x:y/>`, "x.ng.mx")).toContain(`<div name="y" id="x">`);
    expect(emit(`<div #ref>hi</div>`, "x.ng.mx")).toContain(`#ref`);
    expect(emit(`<div #ref>hi</div>`, "x.ng.mx")).not.toContain(`id="ref"`);
  });

  it("`<svg:rect>` is the tag `svg` plus a name (no `svg:` element form)", () => {
    expect(emit(`<svg:rect/>`, "x.ng.mx")).toContain(`<svg name="rect">`);
  });

  it.each([
    ["<div :/>", "value:", 1, 5],
    ["<div\n  :/>", "value:", 2, 2],
    ["<div x:/>", "x:", 1, 5],
    ['<div x: = "s"/>', "x:", 1, 5],
    ["<div x: = input.x/>", "x:", 1, 5],
    ["<div\n  x:/>", "x:", 2, 2],
  ])(
    "rejects an empty namespace suffix at the authored name: %s",
    (source, name, line, column) => {
      expect(() => emit(source, "x.ng.mx")).toThrow(
        expect.objectContaining({
          message: `attribute \`${name}\` has an empty namespace suffix that Angular templates cannot express`,
          line,
          column,
        }),
      );
    },
  );

  it.each(['<div value:foo:bar="y"/>', "<div value:foo:bar=y/>"])(
    "emits a multi-colon name that Angular's own parser accepts: %s",
    (source) => {
      const template = emit(source, "x.ng.mx");
      expect(template).toContain("value:foo:bar");
      expect(parseTemplate(template, "x.html").errors).toBeNull();
    },
  );

  it.each(["class", "style"])("refuses an empty %s modifier", (name) => {
    expect(() => emit(`<div ${name}:/>`, "x.ng.mx")).toThrow(
      `attribute modifier \`${name}:\``,
    );
  });

  it("rejects reserved on: with Marko's error", () => {
    expect(() => emit("<div on:/>", "x.ng.mx")).toThrow(
      expect.objectContaining({
        message: "`on:` is not a valid attribute, did you mean `on`?",
        line: 1,
        column: 5,
      }),
    );
  });

  it("still refuses a real modifier, in this host's words", () => {
    expect(() => emit(`<div class:active="x"/>`, "x.ng.mx")).toThrow(
      /attribute modifier `class:active` is not Marko syntax/,
    );
  });
});
