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

// A dynamic `class=` in a `.ng.mx` file. A `.ng.mx` owns its component class,
// so `__mxClass` is injected and any value Marko accepts renders: a number
// (which Angular's `[class]` throws on), a runtime array, an object, `null`,
// `0`, `true`. The expected class sets come from stock Marko 6.4.4
// (`renderStockMarko`) on the same template and values. Plain `.mx` pages are
// unchanged and are not covered here.

const dir = mkdtempSync(join(import.meta.dirname, "..", ".class-ngmx-"));
const NESTED = ["p", ["q", ["r"]], false, null, 0, "s", { m: true, n: 0 }];

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
  const plain = join(dir, "tags", "plain.mx");
  writeFileSync(
    plain,
    "export interface Input { label?: string }\n<pre>x</pre>\n",
  );
  writeModule(
    join(dir, "tags", "plain.mjs"),
    compileTagModule(readFileSync(plain, "utf8"), plain, {
      customTags: scan(plain),
    }).code,
  );
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let pageId = 0;

/** Renders a `.ng.mx` page around `template`; returns each `<div>`'s class before and after `update`. */
async function render(
  template: string,
  props: Record<string, unknown>,
  update: Record<string, unknown> = props,
): Promise<{ first: (string | null)[]; second: (string | null)[] }> {
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
  const classes = () =>
    [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll(
        "div, mx-plain",
      ),
    ].map((el) => el.getAttribute("class"));
  const first = classes();
  Object.assign(fixture.componentInstance as object, update);
  // The page is OnPush too: dirty it as an event handler or signal would.
  fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
  fixture.detectChanges();
  return { first, second: classes() };
}

const set = (value: string | null | undefined) =>
  (value ?? "").split(" ").filter(Boolean).sort().join(" ") || null;

// [name, y, the class set stock renders for `class=y`, and for `.a class=y`].
const VALUES: [string, unknown, string | null, string | null][] = [
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

describe("a dynamic class= in a .ng.mx", () => {
  it.each(VALUES)("class=y with %s", async (_n, y, plain, shorthand) => {
    const view = await render("<><div class=y/><div.a class=y/></>", { y });
    expect(view.first.map(set)).toEqual([plain, shorthand].map(set));
  });

  it.each(VALUES)("class=y updated to %s", async (_n, y, plain, shorthand) => {
    const view = await render(
      "<><div class=y/><div.a class=y/></>",
      { y: "start" },
      { y },
    );
    expect(view.first.map(set)).toEqual(["start", "a start"]);
    expect(view.second.map(set)).toEqual([plain, shorthand].map(set));
  });

  it("joins a runtime array in a single root", async () => {
    const view = await render("<><div class=y/></>", { y: NESTED });
    expect(view.first.map(set)).toEqual(["m p q r s"]);
  });

  // A callee without a `class` input takes the class on its host element, where
  // Angular's `[class]` throws on a number.
  it.each(VALUES)(
    "class=y on a tag call without a class input, with %s",
    async (_n, y, plain) => {
      const view = await render("<><plain class=y/></>", { y });
      expect(view.first.map(set)).toEqual([plain].map(set));
    },
  );
});
