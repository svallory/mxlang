import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");

describe("published package shape", () => {
  it("does not declare sideEffects: false", () => {
    // With `"sideEffects": false`, bun tree-shakes the whole module graph away
    // and emits a `dist/index.js` that re-exports names it never defines. The
    // build still reports success, so the failure only surfaces when something
    // imports the built artifact. Measured: 56 bytes with the field, 4.42 KB
    // without. See this package's README, "A build trap".
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
    );
    expect(manifest.sideEffects).toBeUndefined();
  });

  it("builds a dist entry that actually defines its exports", () => {
    // Reads the built dist, so it needs a build first: `bun run verify`, CI
    // and `moon run angular-checker:test` all build before they test. A bare
    // `vitest run` without a dist fails here rather than passing with no
    // assertions.
    const entry = path.join(PACKAGE_DIR, "dist", "index.js");
    expect(
      existsSync(entry),
      "packages/tooling/angular-checker/dist/index.js is missing: run `bun run build` first (moon run angular-checker:test builds it)",
    ).toBe(true);

    const code = readFileSync(entry, "utf8");
    // A tree-shaken shell is just an `export { ... };` statement and nothing
    // else. A real build carries the function bodies.
    expect(code).toContain("createAngularChecker");
    expect(code.length).toBeGreaterThan(500);
  });
});
