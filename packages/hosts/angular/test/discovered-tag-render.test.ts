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

/**
 * A custom tag found by the normal `tags/` scan (not path-registered), called
 * with an attribute and a body from a `.ng.mx` component and rendered through
 * Angular's real renderer (JIT compiler, TestBed, jsdom). Asserting the
 * rendered DOM, not the emitted template, is what catches a discovered tag
 * that ships as an unknown element or throws at render time (the `.astro.mx`
 * bug of PR #375).
 *
 * The emitted modules are TypeScript with decorators, so each is transpiled
 * with `experimentalDecorators` (the test transform does not lower TC39
 * decorators) and written under this package so `@angular/*` resolves.
 */
const dir = mkdtempSync(
  join(import.meta.dirname, "..", ".discovered-tag-render-"),
);

const BADGE = [
  "export interface Input { label: string }",
  "<b title=input.label>${input.label}:<${input.content}/></b>",
  "",
].join("\n");

/** Writes `code` as an ES module at `file`, transpiled from TypeScript. */
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
  writeFileSync(join(dir, "tags", "badge.mx"), BADGE);
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
  const file = join(dir, "tags", "badge.mx");
  writeModule(
    join(dir, "tags", "badge.mjs"),
    compileTagModule(readFileSync(file, "utf8"), file, {
      customTags: scan(file),
    }).code,
  );
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let pageId = 0;
/** Compiles a `.ng.mx` component around `template` and renders it. */
async function render(template: string): Promise<string> {
  const name = `page${++pageId}`;
  const file = join(dir, `${name}.component.ng.mx`);
  const source = [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: "app-${name}",`,
    `  template: ${template},`,
    "})",
    "export class Page {}",
  ].join("\n");
  writeFileSync(file, source);
  const { code } = compileNgMx(source, file, { customTags: scan(file) });
  writeModule(join(dir, `${name}.mjs`), code);
  const mod = (await import(/* @vite-ignore */ join(dir, `${name}.mjs`))) as {
    Page: new () => unknown;
  };
  const fixture = TestBed.createComponent(mod.Page as never);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).innerHTML.replaceAll(
    /<!--[\s\S]*?-->/g,
    "",
  );
}

describe("a discovered custom tag called from .ng.mx, rendered on Angular", () => {
  it("scans the tag rather than being handed it", () => {
    expect(Object.keys(scan(join(dir, "page.ng.mx")))).toEqual(["badge"]);
  });

  it("renders the tag's markup with its attribute and body", async () => {
    expect(await render('<div><badge label="a">hi</badge></div>')).toBe(
      '<div><mx-badge label="a"><b title="a">a:hi</b></mx-badge></div>',
    );
  });

  it("renders every call, nested markup in the body", async () => {
    expect(
      await render(
        '<section><badge label="a"><i>x</i></badge><p><badge label="b"/></p></section>',
      ),
    ).toBe(
      '<section><mx-badge label="a"><b title="a">a:<i>x</i></b></mx-badge><p><mx-badge label="b"><b title="b">b:</b></mx-badge></p></section>',
    );
  });
});
