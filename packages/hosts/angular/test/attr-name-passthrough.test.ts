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
 * `class:`/`style:`/`attr:` are the modifiers Marko's taglib refuses, and this
 * host refuses them too (`rejectModifier`) — `:foo` is the one modifier form
 * Marko accepts, so it must reach the template as an attribute.
 *
 * A static one is carried verbatim (Angular passes an unknown static attribute
 * through to the DOM); a dynamic one cannot be a property binding — `[value:foo]`
 * is a property no element has, NG8002 — so it takes the same `[attr.name]`
 * route as `data-*`/`aria-*`.
 */
describe("`:modifier` is the attribute `value:modifier` (angular)", () => {
  it("emits Marko's attribute, statically and dynamically", () => {
    expect(emit(`<div :foo="lit"/>`, "x.ng.mx")).toContain(
      `<div value:foo="lit">`,
    );
    expect(emit(`<div :foo/>`, "x.ng.mx")).toContain(`<div value:foo="">`);
    expect(emit(`<div :foo=y/>`, "x.ng.mx")).toContain(
      `<div [attr.value:foo]="y">`,
    );
    // The same attribute under its long spelling: Marko compiles
    // `<div value:foo="y"/>` to the same output as `<div :foo="y"/>`.
    expect(emit(`<div value:foo="lit"/>`, "x.ng.mx")).toContain(
      `<div value:foo="lit">`,
    );
  });

  it.each([
    ["<div :/>", 1, 5],
    ["<div\n  :/>", 2, 2],
  ])(
    "rejects an empty namespace suffix at the authored name: %s",
    (source, line, column) => {
      expect(() => emit(source, "x.ng.mx")).toThrow(
        expect.objectContaining({
          message:
            "attribute `value:` has an empty namespace suffix that Angular templates cannot express",
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

  it("still refuses a real modifier, in this host's words", () => {
    expect(() => emit(`<div class:active="x"/>`, "x.ng.mx")).toThrow(
      /attribute modifier `class:active` is not Marko syntax/,
    );
  });
});
