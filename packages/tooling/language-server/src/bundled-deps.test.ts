/**
 * The VSIX's dependency list must cover every bare module `@mxlang/core`
 * loads with a literal `require("…")`: the bundler cannot follow a
 * `createRequire(...)(...)` call, so those specifiers stay runtime requires
 * in the inlined core and must be shipped beside the bundle
 * (`build/bundled-config.ts`, `BUNDLED_INSTALLED`).
 *
 * The scan reads core's sources: the dist's requires are exactly the literal
 * ones there (`babel.ts`, `mx-config.ts`). Excluded by design:
 * `node:` builtins (always present, bare or prefixed), `marko-frontend.ts`'s three specifiers
 * (dead in the dist — the build folds their conditional to the bundled
 * `marko-frontend.cjs` — see that file), and `target-loader.ts`'s
 * user-project descriptors (resolved from the project, not shipped).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_INSTALLED } from "../build/bundled-config.ts";

const CORE_SRC = join(import.meta.dirname, "../../../core/src");

/** The only literal bare requires that are dead in the built dist. */
const SOURCE_ONLY = new Set([
  "@marko/compiler",
  "@marko/compiler/internal/babel",
  "@mxlang/parser",
]);

function coreBareRequires(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "fixtures") walk(path);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        const text = readFileSync(path, "utf8");
        const requires = [
          ...text.matchAll(/require\("([^"]+)"\)/g),
          // The `createRequire(...)("specifier")` form is just as invisible
          // to the bundler as a plain require.
          ...text.matchAll(/createRequire\([^)]*\)\("([^"]+)"\)/g),
        ];
        for (const match of requires) {
          const specifier = match[1] ?? "";
          // A module name starts with a letter, `@scope/` or `.`; prose in
          // comments (`require("…")`) does not.
          if (
            /^[A-Za-z@.]/.test(specifier) &&
            !specifier.startsWith("node:") &&
            specifier !== "module" &&
            !specifier.startsWith("./") &&
            !specifier.startsWith("../") &&
            !SOURCE_ONLY.has(specifier)
          ) {
            found.add(specifier);
          }
        }
      }
    }
  };
  walk(CORE_SRC);
  return [...found].sort();
}

describe("the bundled build ships every runtime require of core", () => {
  it("each bare specifier core requires is in BUNDLED_INSTALLED", () => {
    // A superset check: this package may ship more than core needs
    // (`@astrojs/compiler` for `@mxlang/host-astro`, here and in the LS).
    const shipped = new Set<string>(BUNDLED_INSTALLED);
    for (const specifier of coreBareRequires()) {
      expect(shipped.has(specifier), `${specifier} missing from the VSIX`).toBe(
        true,
      );
    }
  });
});
