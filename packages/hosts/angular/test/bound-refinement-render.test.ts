// @vitest-environment jsdom
import "@angular/compiler";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REFINE_HELPER_MEMBERS } from "../src/emitter.ts";

/**
 * Marko's `v:fn:=q` runs `q = fn(next)` whenever `v` changes. Rendered through
 * Angular's real renderer (JIT compiler, TestBed, jsdom): a directive with an
 * input `v` and an output `vChange` emits a new value, and the component's
 * `q` must end up as `fn(next)`. The unrefined `v:=q` writes `next` itself.
 */
const dir = mkdtempSync(
  join(import.meta.dirname, "..", ".bound-refinement-render-"),
);

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

beforeAll(() => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});
afterEach(() => TestBed.resetTestingModule());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MX = [
  "<div appPick v:fn:=q/>",
  "<div appPick v:=q/>",
  "<div appPick v:fn:=sig/>",
  "<div appPick v:fn:=box.v/>",
  "<div appPick v:fn:=box.sig/>",
] as const;
// The MX compiler needs Node's module resolution, which jsdom's environment
// replaces, so the templates are emitted in a plain Node process.
let templates: string[] = [];
beforeAll(() => {
  templates = JSON.parse(
    execFileSync(
      "bun",
      [
        "run",
        "--tsconfig-override=tsconfig.build.json",
        join(import.meta.dirname, "bound-refinement-fixture.ts"),
        JSON.stringify(MX),
      ],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
    ),
  );
}, 30_000);

let pageId = 0;
interface Page {
  q: string;
  sig: () => string;
  box: { v: string; sig: () => string };
}

interface Rendered {
  page: Page;
  emit(value: string): void;
}

/** Compiles the MX `template` to an Angular template, puts it in a component and renders it. */
async function render(mx: (typeof MX)[number]): Promise<Rendered> {
  const template = templates[MX.indexOf(mx)];
  const name = `page${++pageId}`;
  const source = [
    'import { Component, Directive, EventEmitter, Input, Output, signal } from "@angular/core";',
    "",
    '@Directive({ selector: "[appPick]", standalone: true })',
    "export class Pick {",
    "  @Input() v = '';",
    "  @Output() vChange = new EventEmitter<string>();",
    "}",
    "",
    "@Component({",
    `  selector: "app-${name}",`,
    "  standalone: true,",
    "  imports: [Pick],",
    `  template: ${JSON.stringify(template)},`,
    "})",
    "export class Page {",
    ...REFINE_HELPER_MEMBERS,
    "  q = 'start';",
    "  sig = signal('start');",
    "  box = { v: 'start', sig: signal('start') };",
    "  fn(next: string): string { return next.toUpperCase() + '!'; }",
    "}",
  ].join("\n");
  writeModule(join(dir, `${name}.mjs`), source);
  const mod = (await import(/* @vite-ignore */ join(dir, `${name}.mjs`))) as {
    Page: new () => Page;
    Pick: new () => { vChange: { emit(value: string): void } };
  };
  const fixture = TestBed.createComponent(mod.Page as never);
  fixture.detectChanges();
  const pick = fixture.debugElement.children[0]?.injector.get(
    mod.Pick as never,
  );
  return {
    page: fixture.componentInstance as Page,
    emit: (value) => {
      (pick as { vChange: { emit(value: string): void } }).vChange.emit(value);
      fixture.detectChanges();
    },
  };
}

describe("a bound attribute's refinement runs on change (Angular's renderer)", () => {
  it("applies fn to the new value on a plain property: q === fn(next)", async () => {
    const r = await render("<div appPick v:fn:=q/>");
    r.emit("abc");
    expect(r.page.q).toBe("ABC!");
  });

  it("applies it on every change", async () => {
    const r = await render("<div appPick v:fn:=q/>");
    r.emit("a");
    r.emit("b");
    expect(r.page.q).toBe("B!");
  });

  it("sets a WritableSignal target, as [(v)] does: sig() === fn(next)", async () => {
    const r = await render("<div appPick v:fn:=sig/>");
    const before = r.page.sig;
    r.emit("abc");
    expect(r.page.sig).toBe(before);
    expect(r.page.sig()).toBe("ABC!");
  });

  it("writes a member of an object, plain or signal", async () => {
    const plain = await render("<div appPick v:fn:=box.v/>");
    plain.emit("abc");
    expect(plain.page.box.v).toBe("ABC!");
    const signal = await render("<div appPick v:fn:=box.sig/>");
    signal.emit("abc");
    expect(signal.page.box.sig()).toBe("ABC!");
  });

  it("writes the new value itself when there is no refinement", async () => {
    const r = await render("<div appPick v:=q/>");
    r.emit("abc");
    expect(r.page.q).toBe("abc");
  });
});
