// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import "@angular/compiler";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ChangeDetectorRef } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";
import { compileTagModule } from "../src/tag-module.ts";

// A `class` on an MX tag call. Marko 6.4.4 hands the value to the callee's
// `input.class` untouched: `class=y` is `y`, `.a class=y` is `["a", y]`,
// `.a.${x} class=y` is `["a", "x", y]`, `class=[y]` is `[y]` (probed with
// `renderStockMarko`, a callee that prints `JSON.stringify(input.class)`).
// A callee that declares a `class` input gets exactly that. A callee that does
// not has only its host element to take the class, where Angular needs a
// string: the value is joined by `__mxClass` and the class set matches what
// the callee would print for `input.class`.

const dir = mkdtempSync(join(import.meta.dirname, "..", ".class-tag-call-"));

const TAKES_CLASS = [
  "export interface Input { class?: unknown }",
  "<pre>{{ class }}</pre>",
  "",
].join("\n");
// A callee that prints the class it was handed on an element of its own.
const DIV_CLASS = [
  "export interface Input { class?: unknown }",
  "<div class=input.class/>",
  "",
].join("\n");
const NO_CLASS = [
  "export interface Input { label?: string }",
  "<pre>x</pre>",
  "",
].join("\n");

// A tag module in concise mode that calls `child` with static classes.
const CONCISE_CALLER = [
  "export interface Input {}",
  'child.a class="lit"',
  "child.b",
  'child class="p q"',
  "",
].join("\n");

function writeModule(file: string, code: string): void {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, outputText);
}

const scan = (file: string) =>
  getCustomTags(file, { host: "angular", targets: angularOwnTargets });

beforeAll(() => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  mkdirSync(join(dir, "tags"));
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
  for (const [name, source] of [
    ["child", TAKES_CLASS],
    ["plain", NO_CLASS],
    ["divchild", DIV_CLASS],
    ["concise", CONCISE_CALLER],
  ] as const) {
    const file = join(dir, "tags", `${name}.mx`);
    writeFileSync(file, source.replace("{{ class }}", "${input.class}"));
  }
  for (const name of ["child", "plain", "divchild", "concise"]) {
    const file = join(dir, "tags", `${name}.mx`);
    writeModule(
      join(dir, "tags", `${name}.mjs`),
      compileTagModule(readFileSync(file, "utf8"), file, {
        customTags: scan(file),
      }).code,
    );
  }
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let pageId = 0;

/** Renders a `.ng.mx` page around `template` and returns each called tag's `class` input, host class and the page. */
async function render(
  template: string,
  props: Record<string, unknown>,
  update?: Record<string, unknown>,
  /** Adds a directive on `mx-child` whose `host: {class}` is "dir-class". */
  withHostDirective = false,
): Promise<{
  inputs: string[];
  hosts: (string | null)[];
  /** The callee's rendered text after `update` is applied and checked again. */
  updated: {
    inputs: string[];
    shown: (string | null)[];
    /** The class attribute of the callee's own `<div>`, if it has one. */
    divs: (string | null)[];
  };
}> {
  const name = `page${++pageId}`;
  const file = join(dir, `${name}.component.ng.mx`);
  const source = [
    withHostDirective
      ? 'import { Component, Directive } from "@angular/core";'
      : 'import { Component } from "@angular/core";',
    "",
    ...(withHostDirective
      ? [
          '@Directive({ selector: "mx-child", host: { class: "dir-class" } })',
          "class HostClass {}",
          "",
        ]
      : []),
    "@Component({",
    `  selector: "app-${name}",`,
    ...(withHostDirective ? ["  imports: [HostClass],"] : []),
    `  template: ${template},`,
    "})",
    "export class Page { x: unknown; y: unknown; }",
  ].join("\n");
  writeFileSync(file, source);
  const { code } = compileNgMx(source, file, { customTags: scan(file) });
  writeModule(join(dir, `${name}.mjs`), code);
  const mod = (await import(/* @vite-ignore */ join(dir, `${name}.mjs`))) as {
    Page: new () => unknown;
  };
  const fixture = TestBed.createComponent(mod.Page as never);
  Object.assign(fixture.componentInstance as object, props);
  fixture.detectChanges();
  const tags = () =>
    fixture.debugElement.queryAll(
      (d) =>
        d.name === "mx-child" ||
        d.name === "mx-plain" ||
        d.name === "mx-divchild",
    );
  const inputs = () =>
    tags().map((tag) =>
      JSON.stringify((tag.componentInstance as { class?: unknown }).class),
    );
  const first = {
    inputs: inputs(),
    hosts: tags().map((tag) =>
      (tag.nativeElement as HTMLElement).getAttribute("class"),
    ),
  };
  if (update) {
    Object.assign(fixture.componentInstance as object, update);
    // The page is OnPush too; dirty it as an event handler or signal would.
    fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
  }
  return {
    ...first,
    updated: {
      inputs: inputs(),
      divs: tags().map(
        (tag) =>
          (tag.nativeElement as HTMLElement)
            .querySelector("div")
            ?.getAttribute("class") ?? null,
      ),
      shown: tags().map(
        (tag) =>
          (tag.nativeElement as HTMLElement).querySelector("pre")
            ?.textContent ?? null,
      ),
    },
  };
}

const NESTED = ["p", ["q", ["r"]], false, null, 0, "s", { m: true, n: 0 }];

// [name, y, the host class set a callee without a `class` input ends up with
// for `class=y`, `.a class=y`].
const VALUES: [string, unknown, string | null, string][] = [
  ["a string", "zz", "zz", "a zz"],
  ["an object", { b: true, c: false, k: 1 }, "b k", "a b k"],
  ["nested arrays and falsy parts", NESTED, "m p q r s", "a m p q r s"],
  ["an empty array", [], null, "a"],
  ["null", null, null, "a"],
  ["undefined", undefined, null, "a"],
  ["false", false, null, "a"],
  ["0", 0, null, "a"],
  ["1", 1, "1", "1 a"],
  ["true", true, "true", "a true"],
  ["a number", 5, "5", "5 a"],
  ["an empty string", "", null, "a"],
];

const set = (value: string | null) =>
  value == null ? null : value.split(" ").filter(Boolean).sort().join(" ");

// The JSON text of what stock hands to `input.class` (`undefined` is `null` in
// an array and absent on its own).
const text = (value: unknown): string => JSON.stringify(value) as string;

describe("a class on an MX tag call whose callee declares a class input", () => {
  it.each(VALUES)("class=y with %s", async (_name, y) => {
    const tag = await render("<child class=y/>", { y });
    expect(tag.inputs).toEqual([y === undefined ? undefined : text(y)]);
    // The input takes the class, not the host element.
    expect(tag.hosts).toEqual([null]);
  });

  it.each(VALUES)(
    "a shorthand class beside class=y with %s",
    async (_name, y) => {
      const a = await render("<child.a class=y/>", { y });
      expect(a.inputs).toEqual([text(["a", y])]);
      const ax = await render("<child.a.${x} class=y/>", { y, x: "xx" });
      expect(ax.inputs).toEqual([text(["a", "xx", y])]);
    },
  );

  it("passes an array literal as written", async () => {
    const view = await render("<child class=[y]/>", { y: NESTED });
    expect(view.inputs).toEqual([text([NESTED])]);
  });

  it("passes a shorthand without class= as the merged array", async () => {
    const view = await render("<child.a.${x}/>", { x: "xx" });
    expect(view.inputs).toEqual([text(["a", "xx"])]);
  });

  it("passes a ternary and a call as their own value", async () => {
    const view = await render(
      '<><child class=y ? "p" : {k: true}/><child class=x.toUpperCase()/></>',
      { y: 0, x: "xx" },
    );
    expect(view.inputs).toEqual([text({ k: true }), text("XX")]);
  });
});

describe("a class input that changes after the first render", () => {
  it("re-renders the callee's class when the value changes", async () => {
    const view = await render(
      "<child class=y/>",
      { y: "one" },
      { y: ["two", "three"] },
    );
    expect(view.inputs).toEqual([text("one")]);
    expect(view.updated.inputs).toEqual([text(["two", "three"])]);
    // The callee prints `input.class`; an OnPush callee kept showing "one".
    expect(view.updated.shown).toEqual(["two,three"]);
  });

  it("re-renders a shorthand merged with a changing class", async () => {
    const view = await render("<child.a class=y/>", { y: 1 }, { y: 2 });
    expect(view.updated.inputs).toEqual([text(["a", 2])]);
    expect(view.updated.shown).toEqual(["a,2"]);
  });
});

// What Marko prints for `<div class=input.class/>` with each `input.class`:
// the class set, falsy parts skipped, nested arrays flattened, an object's
// truthy keys (Angular may reorder the words, so sets are compared).
const DIV_ROWS: [string, unknown, string | null, unknown, string | null][] = [
  ["a nested array", NESTED, "m p q r s", "later", "later"],
  ["an object", { k: 1, z: 0 }, "k", { n: true }, "n"],
  ["null", null, null, ["x"], "x"],
  ["0", 0, null, 3, "3"],
  ["5", 5, "5", 0, null],
];

describe("a callee that prints its class input on an element", () => {
  it.each(DIV_ROWS)(
    "%s, then an update",
    async (_name, first, firstSet, next, nextSet) => {
      const view = await render(
        "<divchild class=y/>",
        { y: first },
        { y: next },
      );
      // An emptied class leaves `class=""` after an update (Angular removes
      // the words, not the attribute); an empty set is the same as none.
      const divSet = (value: string | null | undefined) =>
        set(value ?? null) || null;
      // The first render, then the same callee after `y` changed.
      const initial = await render("<divchild class=y/>", { y: first });
      expect(divSet(initial.updated.divs[0])).toEqual(firstSet);
      expect(divSet(view.updated.divs[0])).toEqual(nextSet);
    },
  );

  it("joins a shorthand merged with class=y for the callee's element", async () => {
    const view = await render("<divchild.a class=y/>", { y: NESTED });
    expect(set(view.updated.divs[0] ?? null)).toEqual("a m p q r s");
  });
});

describe("a class on an MX tag call whose callee has no class input", () => {
  // A shorthand beside `class=y` is an array, joined by `__mxClass` onto the
  // callee's host element.
  it.each(VALUES)(
    "a shorthand class beside class=y with %s",
    async (_name, y, _plain, withShorthand) => {
      const shorthand = await render("<plain.a class=y/>", { y });
      expect(shorthand.hosts.map(set)).toEqual([set(withShorthand)]);
    },
  );

  it("joins an array literal and a shorthand with an interpolation", async () => {
    const view = await render("<plain.a.${x} class=[y, [x]]/>", {
      x: "xx",
      y: NESTED,
    });
    expect(view.hosts.map(set)).toEqual([set("a xx m p q r s")]);
  });
});

describe("a static class on a tag call whose callee declares a class input", () => {
  // Marko prints the class only where the callee prints `input.class`: there
  // is no host element to take it. The input gets the value and the callee's
  // host element does not also get the class.
  it.each([
    ['class="lit"', '<child class="lit"/>', "lit"],
    ["a shorthand only", "<child.a/>", "a"],
    ["two shorthands", "<child.a.b/>", "a b"],
    ["a shorthand beside a static class", '<child.a class="lit"/>', "a lit"],
    ["a static class of two words", '<child class="p q"/>', "p q"],
  ])("%s: the input takes it, not the host", async (_name, call, expected) => {
    const view = await render(call, {});
    expect(view.inputs).toEqual([text(expected)]);
    expect(view.hosts).toEqual([null]);
    expect(view.updated.shown).toEqual([expected]);
  });

  it("prints the class once on the callee's own element", async () => {
    const view = await render('<><divchild class="lit"/><divchild.a/></>', {});
    expect(view.updated.divs.map(set)).toEqual(["lit", "a"]);
    expect(view.hosts).toEqual([null, null]);
  });

  it("leaves an uppercase CLASS alone: it is not the class input", async () => {
    // Tag-call attribute names are case-sensitive: stock gives `input.CLASS`
    // and no `input.class`, so the input stays unset and the host keeps it.
    const view = await render('<child CLASS="lit"/>', {});
    expect(view.inputs).toEqual([undefined]);
    expect(view.hosts).toEqual(["lit"]);
  });

  it("keeps a static class off the host after an update elsewhere", async () => {
    const view = await render(
      '<><child class="lit"/><child class=y/></>',
      { y: "one" },
      { y: "two" },
    );
    expect(view.hosts).toEqual([null, null]);
    expect(view.updated.inputs).toEqual([text("lit"), text("two")]);
    expect(view.updated.shown).toEqual(["lit", "two"]);
  });

  it("takes a static class written in concise mode", async () => {
    const view = await render("<concise/>", {});
    expect(view.inputs).toEqual([text("a lit"), text("b"), text("p q")]);
    expect(view.hosts).toEqual([null, null, null]);
  });

  it("passes a static class with braces and quotes as written", async () => {
    const view = await render(
      `<><child class="{{ x }} it's"/><child class='a "b" c'/></>`,
      {},
    );
    expect(view.inputs).toEqual([text("{{ x }} it's"), text('a "b" c')]);
    expect(view.hosts).toEqual([null, null]);
  });

  it("leaves a directive's host class on the callee's host element", async () => {
    const view = await render('<child class="lit"/>', {}, undefined, true);
    expect(set(view.hosts[0] ?? null)).toEqual("dir-class");
    expect(view.inputs).toEqual([text("lit")]);
  });
});

describe("a static class on a tag call whose callee has no class input", () => {
  // Nothing to receive it: the host element takes it, as before.
  it.each([
    ['class="lit"', '<plain class="lit"/>', "lit"],
    ["a shorthand only", "<plain.a/>", "a"],
    ["a shorthand beside a static class", '<plain.a class="lit"/>', "a lit"],
  ])("%s: the host element takes it", async (_name, call, expected) => {
    const view = await render(call, {});
    expect(set(view.hosts[0] ?? null)).toEqual(set(expected));
  });
});
