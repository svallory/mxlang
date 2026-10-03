// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Type } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import cases from "../../../../fixtures/body-whitespace/cases.json";

const packageRoot = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(packageRoot, ".body-whitespace-"));

beforeAll(() => {
  // Compile the actual MX modules under Node conditions before rendering in jsdom.
  symlinkSync(
    join(packageRoot, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  execFileSync(
    "bun",
    [
      "run",
      "--tsconfig-override=tsconfig.build.json",
      join(import.meta.dirname, "body-whitespace-fixture.ts"),
      dir,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  );
  expect(existsSync(join(dir, "caller-true-15.mjs"))).toBe(true);
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.each([false, true])(
  "body whitespace, decision 141 (discovered=%s)",
  (discovered) => {
    it.each(cases.map((entry, index) => ({ ...entry, index })))(
      "$label",
      async ({ index, html }) => {
        const file = join(dir, `caller-${discovered}-${index}.mjs`);
        const component = (
          await import(/* @vite-ignore */ pathToFileURL(file).href)
        ).default as Type<unknown>;
        const fixture = TestBed.createComponent(component);
        fixture.detectChanges();
        const rendered = (
          fixture.nativeElement as HTMLElement
        ).innerHTML.replace(/<!--[^>]*-->/g, "");
        expect(rendered).toBe(`<mx-wrap><section>${html}</section></mx-wrap>`);
      },
    );
  },
);
