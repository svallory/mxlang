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
    // Only meaningful once `bun run build` has run (it has, in `bun run
    // verify`, which builds before it tests). Skipped rather than failed in a
    // bare `vitest run` of this package alone.
    const entry = path.join(PACKAGE_DIR, "dist", "index.js");
    if (!existsSync(entry)) return;

    const code = readFileSync(entry, "utf8");
    // A tree-shaken shell is just an `export { ... };` statement and nothing
    // else. A real build carries the function bodies.
    expect(code).toContain("createAngularChecker");
    expect(code.length).toBeGreaterThan(500);
  });
});
