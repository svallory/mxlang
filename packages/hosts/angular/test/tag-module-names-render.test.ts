// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import "@angular/compiler";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { angularOwnTargets } from "../src/own-targets.ts";
import { compileTagModule } from "../src/tag-module.ts";

/**
 * A tag whose template reads module-level names, rendered through Angular's
 * real renderer (JIT compiler, TestBed, jsdom). The emitted-code tests show
 * the class carries the names; this shows what the template renders, which is
 * what a missing member got wrong: blank output with no diagnostic.
 */
const dir = mkdtempSync(join(import.meta.dirname, "..", ".tag-names-render-"));

beforeAll(() => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  mkdirSync(join(dir, "tags"));
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

/** Compiles the tag `name` from `source`, and returns its component class. */
async function load(name: string, source: string): Promise<new () => unknown> {
  writeFileSync(join(dir, "util.mjs"), "export const fmt = (n) => `#${n}`;\n");
  const file = join(dir, "tags", `${name}.mx`);
  writeFileSync(file, source);
  const { code } = compileTagModule(source, file, {
    customTags: getCustomTags(file, {
      host: "angular",
      targets: angularOwnTargets,
    }) as never,
  });
  const out = join(dir, "tags", `${name}.mjs`);
  writeModule(out, code.replaceAll('"./util.ts"', '"../util.mjs"'));
  const mod = (await import(/* @vite-ignore */ out)) as {
    default: new () => unknown;
  };
  return mod.default;
}

const text = (fixture: { nativeElement: unknown }): string =>
  (fixture.nativeElement as HTMLElement).textContent ?? "";

describe("a tag template reading module-level names, rendered on Angular", () => {
  it("renders a `static let`, `static const`, `static function` and an import", async () => {
    const Tag = await load(
      "all",
      [
        'import { fmt } from "./util.ts";',
        "static let x = 1;",
        "static const y = 2;",
        "static function f() { return 3; }",
        "<p>${x}-${y}-${f()}-${fmt(4)}</p>",
        "",
      ].join("\n"),
    );
    const fixture = TestBed.createComponent(Tag as never);
    fixture.detectChanges();

    expect(text(fixture)).toBe("1-2-3-#4");
  });

  it("shows the current value of a `static let` that module code reassigns", async () => {
    const Tag = await load(
      "counter",
      [
        "static let n = 0;",
        "static function bump() { n++; }",
        "<button onClick=bump>${n}</button>",
        "",
      ].join("\n"),
    );
    const fixture = TestBed.createComponent(Tag as never);
    fixture.detectChanges();
    expect(text(fixture)).toBe("0");

    const button = (fixture.nativeElement as HTMLElement).querySelector(
      "button",
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(text(fixture)).toBe("1");
    button.click();
    fixture.detectChanges();
    expect(text(fixture)).toBe("2");
  });

  it("an assignment in the template reaches the module's variable", async () => {
    const Tag = await load(
      "setter",
      [
        "static let label = 'a';",
        "<button onClick=() => label = 'b'>${label}</button>",
        "",
      ].join("\n"),
    );
    const fixture = TestBed.createComponent(Tag as never);
    fixture.detectChanges();
    expect(text(fixture)).toBe("a");

    (
      (fixture.nativeElement as HTMLElement).querySelector(
        "button",
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(text(fixture)).toBe("b");
  });
});
