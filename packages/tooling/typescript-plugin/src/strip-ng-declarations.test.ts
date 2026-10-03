import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../build/strip-ng-declarations.ts", import.meta.url),
);

const scratch = mkdtempSync(join2(tmpdir(), "strip-ng-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `node:path` join, spelled out so the fixture paths stay readable. */
function join2(...parts: string[]): string {
  return path.join(...parts);
}

/** Runs the strip script; returns the exit code (stdout/stderr on throw). */
function strip(dir: string): number {
  try {
    execFileSync("bun", [SCRIPT, dir], { stdio: "pipe" });
    return 0;
  } catch (error) {
    const { status, stderr } = error as {
      status: number | null;
      stderr: Buffer;
    };
    expect(stderr.toString()).toContain(
      "reference a stripped Angular worker module",
    );
    return status ?? 1;
  }
}

function writeDist(name: string, files: Record<string, string>): string {
  const dir = path.join(scratch, name);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/**
 * Emits real declarations for a fixture through the same compiler options as
 * `tsconfig.build.json`, so specifier retention matches the package's emit
 * (with `allowImportingTsExtensions`, d.ts keep `.ts` specifiers).
 */
function emitDeclarations(
  name: string,
  sources: Record<string, string>,
): string {
  const srcDir = path.join(scratch, `${name}-src`);
  const outDir = path.join(scratch, name);
  mkdirSync(srcDir, { recursive: true });
  const rootNames = Object.entries(sources).map(([file, text]) => {
    const full = path.join(srcDir, file);
    writeFileSync(full, text);
    return full;
  });
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir,
      strict: true,
      skipLibCheck: true,
    },
  });
  const emit = program.emit();
  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(
    errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  ).toEqual([]);
  expect(emit.emitSkipped).toBe(false);
  return outDir;
}

describe("strip-ng-declarations guard", () => {
  it("fails on a real emitted `.ts` re-export and deletes nothing", () => {
    const dist = emitDeclarations("real-ts", {
      "index.ts":
        'export type { NgDiagnosticsService } from "./ng-diagnostics.ts";\n',
      "ng-diagnostics.ts":
        "export interface NgDiagnosticsService { dispose(): void }\n",
    });
    // The premise: this package's emit retains the `.ts` specifier.
    expect(readFileSync(path.join(dist, "index.d.ts"), "utf8")).toContain(
      'from "./ng-diagnostics.ts"',
    );
    expect(strip(dist)).toBe(1);
    expect(existsSync(path.join(dist, "ng-diagnostics.d.ts"))).toBe(true);
    expect(existsSync(path.join(dist, "index.d.ts"))).toBe(true);
  });

  it("strips a real emitted ng-diagnostics.d.ts when nothing references it", () => {
    const dist = emitDeclarations("real-clean", {
      "index.ts": 'export type { Plain } from "./plain.ts";\n',
      "plain.ts": "export interface Plain { x: string }\n",
      "ng-diagnostics.ts":
        "export interface NgDiagnosticsService { dispose(): void }\n",
    });
    expect(strip(dist)).toBe(0);
    expect(existsSync(path.join(dist, "ng-diagnostics.d.ts"))).toBe(false);
    expect(existsSync(path.join(dist, "plain.d.ts"))).toBe(true);
  });

  it("fails on every relative reference form (.js, extensionless, nested, import(), reference path)", () => {
    const service =
      "export interface NgDiagnosticsService { dispose(): void }\n";
    const cases: Record<string, Record<string, string>> = {
      "form-js": {
        "index.d.ts":
          'export type { NgDiagnosticsService } from "./ng-diagnostics.js";\n',
        "ng-diagnostics.d.ts": service,
      },
      "form-extensionless": {
        "index.d.ts":
          'import type { NgDiagnosticsService } from "./ng-diagnostics";\n' +
          "export declare const service: NgDiagnosticsService;\n",
        "ng-diagnostics.d.ts": service,
      },
      "form-nested": {
        "sub/index.d.ts":
          'export type { NgDiagnosticsService } from "../ng-diagnostics.ts";\n',
        "ng-diagnostics.d.ts": service,
      },
      "form-import-call": {
        "index.d.ts":
          "export declare function load(): Promise<import('./ng-worker.ts').Worker>;\n",
        "ng-worker.d.ts": "export interface Worker { run(): void }\n",
      },
      "form-reference-path": {
        "index.d.ts":
          '/// <reference path="./ng-diagnostics.ts" />\nexport declare const x: number;\n',
        "ng-diagnostics.d.ts": service,
      },
    };
    for (const [name, files] of Object.entries(cases)) {
      const dist = writeDist(name, files);
      expect(strip(dist), name).toBe(1);
      for (const rel of Object.keys(files)) {
        expect(existsSync(path.join(dist, rel)), `${name}: ${rel}`).toBe(true);
      }
    }
  });

  it("ignores bare specifiers and unrelated relative imports", () => {
    const dist = writeDist("form-bare", {
      "index.d.ts":
        'import type { LanguageServicePlugin } from "@volar/typescript";\n' +
        'export type { Plain } from "./plain.js";\n' +
        'export declare const worker: import("typescript").Program;\n',
      "plain.d.ts": "export interface Plain { x: string }\n",
    });
    expect(strip(dist)).toBe(0);
    expect(existsSync(path.join(dist, "plain.d.ts"))).toBe(true);
  });

  it("the built dist passes the guard (references nothing stripped)", () => {
    const dist = path.resolve(import.meta.dirname, "../dist");
    if (!existsSync(path.join(dist, "index.cjs"))) return; // build not run
    const copy = path.join(scratch, "built-dist");
    execFileSync("cp", ["-R", dist, copy]);
    expect(strip(copy)).toBe(0);
  });
});
