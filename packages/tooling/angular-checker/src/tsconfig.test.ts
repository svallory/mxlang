import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileNgMx } from "@mxlang/angular";
import { afterEach, describe, expect, it } from "vitest";
import { createAngularChecker, diagnoseNgMx } from "./index.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");
const FIXTURES = path.join(PROJECT_DIR, "fixtures");

// `name` is optional: an error under strictNullChecks, clean without.
const SOURCE = [
  'import { Component } from "@angular/core";',
  "@Component({ selector: 'app-x', template: <p>${user.name.length}</p> })",
  "export class X { user: { name?: string } = {}; }",
].join("\n");

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function check(tsconfigPath: string | undefined) {
  const compiled = compileNgMx(SOURCE, "/p/x.component.ng.mx");
  const checker = createAngularChecker({
    projectDir: PROJECT_DIR,
    ...(tsconfigPath ? { tsconfigPath } : {}),
  });
  try {
    return diagnoseNgMx(compiled, checker, VIRTUAL);
  } finally {
    checker.dispose();
  }
}

describe("tsconfigPath", () => {
  it("is the baseline: without a tsconfig the strict defaults flag the template", () => {
    expect(check(undefined).map((d) => d.code)).toEqual([2532]);
  });

  it("resolves a relative `extends` against the tsconfig's own directory", () => {
    // base.json (strict: false) sits beside cfg/tsconfig.app.json, NOT beside
    // the project dir: parsing against projectDir would drop the extends and
    // report a false TS2532.
    expect(check(path.join(FIXTURES, "cfg", "tsconfig.app.json"))).toEqual([]);
  });

  it("fails explicitly for a tsconfig that does not exist, never falling back to defaults", () => {
    const missing = path.join(FIXTURES, "cfg", "missing.json");
    expect(() => check(missing)).toThrow(missing);
  });

  it("fails explicitly for a malformed tsconfig, naming it and TypeScript's message", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mx-cfg-"));
    created.push(dir);
    const bad = path.join(dir, "tsconfig.json");
    writeFileSync(bad, '{ "compilerOptions": { ');
    expect(() => check(bad)).toThrow(bad);
  });

  it("fails explicitly when `extends` cannot be resolved", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mx-cfg-"));
    created.push(dir);
    const cfg = path.join(dir, "tsconfig.json");
    writeFileSync(cfg, '{ "extends": "./nope.json" }');
    expect(() => check(cfg)).toThrow(/nope\.json/);
  });

  it("does not treat an empty `include` match as an error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mx-cfg-"));
    created.push(dir);
    const cfg = path.join(dir, "tsconfig.json");
    writeFileSync(
      cfg,
      '{ "compilerOptions": { "strict": false }, "include": ["src"] }',
    );
    expect(check(cfg)).toEqual([]);
  });
});
