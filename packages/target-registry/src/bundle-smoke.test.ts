/**
 * Bundler smoke pins for the host packages' entry graphs (review BUG 1,
 * rev-245 §1).
 *
 * A host whose `src/index.ts` imports its own `./descriptor.ts` while the
 * descriptor reaches the compile entry back through the index creates an
 * entry-point cycle. Bun 1.3.14's multi-entry `bun build` then *silently
 * omitted a required JS artifact with exit 0*: html intermittently lost
 * `dist/index.js`, react and solid lost it on every build. That drop no
 * longer reproduces on Bun 1.4.4 (cycle probe: react's descriptor requiring
 * `./index.ts`, 3/3 builds kept every entry). A package whose `main`/`exports`
 * point at a file the bundler dropped installs fine and fails on first import.
 *
 * These pins build each host's real entry set, with the real externals, into
 * a temp dir and assert every entry artifact exists. The graph stays acyclic
 * because the descriptor is a bundled leaf: descriptors lazily require
 * descriptor-free compiler leaves instead of the public index.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

interface HostBuild {
  /** Workspace-relative package directory. */
  dir: string;
  /** The package's real build entries. */
  entries: string[];
  /** Every entry artifact the build must emit (`dist`-relative). */
  artifacts: string[];
}

const HOST_BUILDS: HostBuild[] = [
  {
    dir: "packages/targets/html",
    entries: ["src/index.ts", "src/bun.ts", "src/descriptor.ts"],
    artifacts: ["index.js", "bun.js", "descriptor.js"],
  },
  {
    dir: "packages/hosts/hono",
    entries: ["src/index.ts", "src/descriptor.ts", "src/bun.ts"],
    artifacts: ["index.js", "descriptor.js", "bun.js"],
  },
  {
    dir: "packages/hosts/react",
    entries: ["src/index.ts", "src/descriptor.ts"],
    artifacts: ["index.js", "descriptor.js"],
  },
  {
    dir: "packages/hosts/preact",
    entries: ["src/index.ts", "src/descriptor.ts"],
    artifacts: ["index.js", "descriptor.js"],
  },
  {
    dir: "packages/hosts/solid",
    entries: ["src/index.ts", "src/descriptor.ts"],
    artifacts: ["index.js", "descriptor.js"],
  },
];

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe.each(HOST_BUILDS)("$dir entry graph builds completely", (host) => {
  it("emits every entry artifact", () => {
    const outDir = mkdtempSync(join(tmpdir(), "mx-bundle-smoke-"));
    tempDirs.push(outDir);
    // The same shape as the packed hosts' real build scripts
    // (`packages/targets/html/package.json`): node-targeted ESM, the compiler
    // and core external. Exit 0 is NOT the pin — the silent-omission bug
    // exits 0 — the artifacts are.
    execFileSync(
      "bun",
      [
        "build",
        ...host.entries,
        "--outdir",
        outDir,
        "--target",
        "node",
        "--format",
        "esm",
        "--external",
        "@marko/compiler",
        "--external",
        "@mxlang/core",
      ],
      { cwd: join(repoRoot, host.dir), stdio: "pipe" },
    );
    for (const artifact of host.artifacts) {
      expect(
        existsSync(join(outDir, artifact)),
        `${host.dir}: bun build exited 0 but did not emit ${artifact} ` +
          "(the entry-point cycle bug: the bundler silently drops an entry)",
      ).toBe(true);
    }
  }, 60_000);
});
