import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `typescript` is a *peer* of the two tooling packages that load it, not a
 * dependency: `mx-tsc` hands `require('typescript')` to Volar's `runTsc`, and
 * the TS plugin types against the `typescript` tsserver loads. Both only work
 * if the copy each resolves is the consumer's single installation. A nested
 * copy — which is what a plain `dependencies` entry buys once a consumer pins
 * a different 5.x/6.x — means two `ts` module instances: `instanceof` checks
 * across them fail and Volar's language plugin silently mistypes every file.
 *
 * So this asserts the property that actually matters, not the manifest text:
 * every package that declares the peer resolves the *same* file on disk.
 * Resolution is done from each package directory the way a consumer's
 * installer would, rather than by importing `typescript` here (which would
 * only ever prove this test file's own resolution).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

/**
 * The packages whose `package.json` declares `peerDependencies.typescript` —
 * the two that actually consume the `typescript` module.
 *
 * `@mxlang/language-server` is deliberately **not** here. It has no reference
 * to `typescript` in its source at all: TypeScript is only its build tool (it
 * emits `.d.ts` with `tsc --emitDeclarationOnly`), so it keeps an exact
 * `devDependencies.typescript` and declares no peer. A peer there would force
 * a resolution on consumers for a module the package never loads.
 */
const PEER_PACKAGES = [
  "packages/tooling/tsc",
  "packages/tooling/typescript-plugin",
] as const;

/** Declares an exact dev `typescript` but no peer — see `PEER_PACKAGES`. */
const BUILD_TOOL_ONLY_PACKAGE = "packages/tooling/language-server";

function resolveTypescriptFrom(pkgPath: string): string {
  const pkgDir = join(repoRoot, pkgPath);
  // `createRequire` needs a file, not a directory, to anchor resolution.
  return createRequire(join(pkgDir, "package.json")).resolve("typescript");
}

function manifestOf(pkgPath: string): {
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return createRequire(import.meta.url)(
    join(repoRoot, pkgPath, "package.json"),
  );
}

function peerRangeOf(pkgPath: string): string | undefined {
  return manifestOf(pkgPath).peerDependencies?.typescript;
}

describe("typescript peer dependency", () => {
  it.each(PEER_PACKAGES)("%s declares typescript as a peer", (pkgPath) => {
    expect(peerRangeOf(pkgPath)).toBeDefined();
  });

  it("declares one range across every package that has the peer", () => {
    const ranges = new Set(PEER_PACKAGES.map(peerRangeOf));

    expect([...ranges]).toHaveLength(1);
  });

  it("declares a range wide enough for a consumer on 5.9 or 6.x", () => {
    // An exact pin (the old `5.9.3`) makes the package uninstallable for a
    // consumer on any other patch; these are the versions a consumer may
    // reasonably be on while this package is current.
    const range = peerRangeOf("packages/tooling/tsc");

    expect(range).toBe(">=5.9.0 <7");
  });

  it("resolves the same typescript from every package", () => {
    const resolved = PEER_PACKAGES.map(resolveTypescriptFrom);

    expect(new Set(resolved).size).toBe(1);
  });

  it("resolves the workspace's own typescript, not a nested copy", () => {
    const fromWorkspaceRoot = resolveTypescriptFrom(".");

    for (const pkgPath of PEER_PACKAGES) {
      expect(resolveTypescriptFrom(pkgPath)).toBe(fromWorkspaceRoot);
    }
  });

  it("keeps typescript a build tool, not a peer, for the language server", () => {
    // The language server never loads `typescript`; it only runs `tsc` to emit
    // its own `.d.ts`. Declaring a peer would make consumers resolve a module
    // the package does not use.
    const manifest = manifestOf(BUILD_TOOL_ONLY_PACKAGE);

    expect(manifest.peerDependencies?.typescript).toBeUndefined();
    expect(manifest.devDependencies?.typescript).toBeDefined();
  });
});
