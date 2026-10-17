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
const NO_CLASS = [
  "export interface Input { label?: string }",
  "<pre>x</pre>",
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
  ] as const) {
    const file = join(dir, "tags", `${name}.mx`);
    writeFileSync(file, source.replace("{{ class }}", "${input.class}"));
  }
  for (const name of ["child", "plain"]) {
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
): Promise<{ inputs: string[]; hosts: (string | null)[] }> {
  const name = `page${++pageId}`;
  const file = join(dir, `${name}.component.ng.mx`);
  const source = [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: "app-${name}",`,
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
  const tags = fixture.debugElement.queryAll(
    (d) => d.name === "mx-child" || d.name === "mx-plain",
  );
  return {
    inputs: tags.map((tag) =>
      JSON.stringify((tag.componentInstance as { class?: unknown }).class),
    ),
    hosts: tags.map((tag) =>
      (tag.nativeElement as HTMLElement).getAttribute("class"),
    ),
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
