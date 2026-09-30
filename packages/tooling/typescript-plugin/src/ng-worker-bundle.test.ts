import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCheckerWorker } from "@mxlang/angular-checker";
import { describe, expect, it } from "vitest";

const DIST = path.resolve(import.meta.dirname, "../dist");
const PROJECT = path.resolve(import.meta.dirname, "../fixtures/ng-project");

// Only meaningful once `bun run build` has run (`bun run verify` builds before
// it tests); skipped rather than failed in a bare `vitest run` of this package.
const built = existsSync(path.join(DIST, "ng-worker.cjs"));

describe.skipIf(!built)("the built ng-worker bundle", () => {
  it("does not bundle @angular/compiler-cli", () => {
    const code = readFileSync(path.join(DIST, "ng-worker.cjs"), "utf8");
    // Resolved at run time from the user's project (createRequire), never inlined.
    expect(code).not.toMatch(/require\(["']@angular\/compiler-cli["']\)/);
    expect(code).not.toContain("class NgtscProgram");
    expect(code.length).toBeLessThan(200_000);
    // ...and it is the worker, not a tree-shaken shell.
    expect(code).toContain("runCheckerWorker");
  });

  it("never imports typescript from its own location", () => {
    // The forked worker gets no `ts` from tsserver and the VSIX ships none, so
    // a bare `require("typescript")` would crash it on start. TypeScript must
    // come from the project, via the checker's createRequire.
    const code = readFileSync(path.join(DIST, "ng-worker.cjs"), "utf8");
    expect(code).not.toMatch(/require\(["']typescript["']\)/);
    expect(code).not.toMatch(/from ["']typescript["']/);
  });

  it("the plugin bundle does not inline it either", () => {
    const code = readFileSync(path.join(DIST, "index.cjs"), "utf8");
    expect(code).not.toContain("class NgtscProgram");
  });

  it("runs as a forked worker and reports a template error", async () => {
    const worker = createCheckerWorker({
      projectDir: PROJECT,
      workerPath: path.join(DIST, "ng-worker.cjs"),
    });
    try {
      const out = await worker.check(
        path.join(PROJECT, "b.component.ts"),
        [
          'import { Component } from "@angular/core";',
          '@Component({ selector: "app-b", standalone: true, template: `<p>{{ user.nmae }}</p>` })',
          "export class B { user = { name: 'a' }; }",
        ].join("\n"),
      );
      expect(out.kind).toBe("ok");
      expect(
        out.kind === "ok" && out.diagnostics.some((d) => d.source === "ngtsc"),
      ).toBe(true);
    } finally {
      worker.dispose();
    }
  }, 60_000);
});
