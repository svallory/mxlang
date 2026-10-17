// @vitest-environment jsdom

// Loaded first: the JIT compiler must be present before `@angular/common`.
import "@angular/compiler";

import { NgClass } from "@angular/common";
import { ChangeDetectionStrategy, Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLASS_HELPER_MEMBERS } from "../src/emitter.ts";
import { MxHandlers, MxHandlersMixin } from "../src/runtime.ts";
import { compileMx } from "./helpers.ts";

// A shorthand class merges with an explicit `class=` of any value, shorthand
// first, one space apart, as stock Marko 6.4.4 does. These rows render the
// emitted template through TestBed in dev mode, where `NgClass` throws on any
// non-string entry, and compare the DOM `class` attribute with what stock
// renders. The expected strings come from `renderStockMarko` (the oracle's
// stock Marko 6.4.4 harness) on the same template with the same values.

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

let counter = 0;

/** Renders `markup` with `props` on the component, returning each `<div>`'s class (null when absent). */
function render(
  markup: string,
  props: Record<string, unknown>,
): { classes: (string | null)[]; update(next: Record<string, unknown>): void } {
  const template = compileMx(markup).code;
  class Probe extends MxHandlers {}
  Component({
    selector: `mx-class-probe-${counter++}`,
    template,
    imports: [NgClass],
    // Angular 22 defaults to OnPush, which ignores a plain field written after
    // the first pass; these rows write plain fields on purpose.
    changeDetection: ChangeDetectionStrategy.Eager,
  })(Probe);
  const fixture = TestBed.createComponent(Probe);
  Object.assign(fixture.componentInstance, props);
  fixture.detectChanges();
  const classes = () =>
    [...fixture.nativeElement.querySelectorAll("div")].map((div: HTMLElement) =>
      div.getAttribute("class"),
    );
  return {
    get classes() {
      return classes();
    },
    update(next) {
      Object.assign(fixture.componentInstance, next);
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    },
  };
}

const NESTED = ["p", ["q", ["r"]], false, null, 0, "s", { m: true, n: 0 }];

// [name, value, [".a", ".a.${x}", ".${x}"] as stock renders them].
const VALUES: [
  string,
  unknown,
  [string | null, string | null, string | null],
][] = [
  ["a string", "zz", ["a zz", "a xx zz", "xx zz"]],
  ["an object", { b: true, c: false, k: 1 }, ["a b k", "a xx b k", "xx b k"]],
  [
    "an array with nested arrays and falsy parts",
    NESTED,
    ["a p q r s m", "a xx p q r s m", "xx p q r s m"],
  ],
  ["null", null, ["a", "a xx", "xx"]],
  ["undefined", undefined, ["a", "a xx", "xx"]],
  ["false", false, ["a", "a xx", "xx"]],
  ["0", 0, ["a", "a xx", "xx"]],
  ["an empty string", "", ["a", "a xx", "xx"]],
  ["true", true, ["a true", "a xx true", "xx true"]],
  ["a number", 5, ["a 5", "a xx 5", "xx 5"]],
];

describe("Angular render: a shorthand class beside class=y", () => {
  it.each(VALUES)("%s", (_name, y, [a, ax, x]) => {
    const props = { x: "xx", y };
    const tag = render(
      "<div.a class=y/><div.a.${x} class=y/><div.${x} class=y/>",
      props,
    );
    expect(tag.classes).toEqual([a, ax, x]);
    const concise = render(
      "div.a class=y\ndiv.a.${x} class=y\ndiv.${x} class=y",
      props,
    );
    expect(concise.classes).toEqual([a, ax, x]);
  });

  it("renders a call, a ternary with a string and a ternary with an object", () => {
    const view = render(
      '<div.a class=y.toUpperCase()/><div.a class=on ? "p" : "q"/><div.a class=on ? {k: true} : null/>',
      { y: "zz", on: true },
    );
    expect(view.classes).toEqual(["a ZZ", "a p", "a k"]);
    view.update({ on: false });
    expect(view.classes).toEqual(["a ZZ", "a q", "a"]);
  });

  it("follows later changes, shorthand first, including in-place mutation", () => {
    const list: unknown[] = ["p"];
    const view = render("<div.a.${x} class=y/>", { x: "xx", y: list });
    expect(view.classes).toEqual(["a xx p"]);
    list.push(["q"], false);
    view.update({});
    expect(view.classes).toEqual(["a xx p q"]);
    view.update({ y: { k: true } });
    expect(view.classes).toEqual(["a xx k"]);
    view.update({ y: null, x: "yy" });
    expect(view.classes).toEqual(["a yy"]);
    view.update({ y: "zz" });
    expect(view.classes).toEqual(["a yy zz"]);
  });

  it("omits the attribute when nothing is left to print", () => {
    const view = render("<div.${x} class=y/>", { x: "", y: [null, false] });
    expect(view.classes).toEqual([null]);
  });
});

describe("Angular render: class= without a shorthand (control)", () => {
  it.each([
    ["a string", "zz", "zz"],
    ["an object", { b: true, c: false, k: 1 }, "b k"],
    ["null", null, null],
    ["true", true, "true"],
  ])("class=y with %s", (_name, y, expected) => {
    const view = render("<div class=y/>", { y });
    expect(view.classes).toEqual([expected]);
  });

  it("renders an authored array with nested arrays and falsy parts", () => {
    const view = render('<div class=["a", y, on && "b", [x]]/>', {
      x: "xx",
      y: NESTED,
      on: false,
    });
    expect(view.classes).toEqual(["a p q r s m xx"]);
  });

  it("keeps a plain object class on [ngClass]", () => {
    const view = render("<div class={a: on, b: !on}/>", { on: true });
    expect(view.classes).toEqual(["a"]);
    view.update({ on: false });
    expect(view.classes).toEqual(["b"]);
  });
});

describe("the __mxClass members agree", () => {
  // The text injected into a component, the `MxHandlers` base and the
  // `MxHandlersMixin` class must join a class value identically.
  const injected = (() => {
    const js = ts.transpileModule(
      `class Injected {\n${CLASS_HELPER_MEMBERS.join("\n")}\n}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    return new (new Function(`${js}; return Injected;`)())() as {
      __mxClass(value: unknown): string | null;
    };
  })();
  const base = new MxHandlers();
  const mixin = new (MxHandlersMixin(class {}))();
  const parts: unknown[] = [
    "a",
    "  ",
    "a b",
    0,
    5,
    NaN,
    true,
    false,
    null,
    undefined,
    {},
    { k: 1, m: 0 },
    [],
    ["p", ["q", [["r"]]], false, 0, null, { x: true }],
  ];

  it.each(parts.map((part) => [JSON.stringify(part) ?? String(part), part]))(
    "%s",
    (_name, part) => {
      const value = ["a", part];
      const expected = base.__mxClass(value);
      expect(injected.__mxClass(value)).toBe(expected);
      expect(mixin.__mxClass(value)).toBe(expected);
    },
  );

  it("is null when nothing is left, and joins in order otherwise", () => {
    expect(base.__mxClass([null, false, 0, "", [], {}])).toBeNull();
    expect(base.__mxClass(["a", [1, [true]], { k: 1 }, "b"])).toBe(
      "a 1 true k b",
    );
  });
});
