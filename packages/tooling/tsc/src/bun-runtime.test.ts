import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtures, mxTsc, repoRoot, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/** Drops ANSI colour codes: the assertions read stripped text. */
function strip(text: string): string {
  // biome-ignore lint: control character matched by its escape sequence
  return text.replace(/[\u001b]\[[0-9;]*m/g, "");
}

/**
 * `bun` as an executable path, or `undefined` when it is not on PATH (the
 * tests that need it then skip, saying so).
 */
const bun = (() => {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "bun" : undefined;
})();

/**
 * `mx-tsc` must run under Bun as well as Node: the runtime the Mesh
 * integration calls it from is Bun, and Volar's `runTsc` installs its patches
 * by monkey-patching `fs.readFileSync` around a `require` of `tsc.js` — a
 * loader route Bun's CommonJS loader does not take (it reads module sources
 * natively), so the unpatched `tsc.js` ran: a `.mx`-only project failed with
 * `TS18003: No inputs were found in config file` and a `.mx` beside a `.ts`
 * was silently never loaded. `src/index.ts` therefore evaluates the
 * transformed `tsc.js` itself; these tests spawn the built bin under `bun`
 * to prove the patches are in (the in-process tests of the other suites run
 * under whatever runtime vitest uses, so they cannot see the difference).
 */
describe.runIf(bun !== undefined)("mx-tsc under bun", () => {
  it(
    "type-checks a .mx project with no TS18003 and the .mx files loaded",
    () => {
      const project = copyDiscoveredTagFixture();
      try {
        const result = spawnSync(
          bun ?? "bun",
          [mxTsc, "--noEmit", "-p", join(project, "tsconfig.json")],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const output = strip(`${result.stdout ?? ""}${result.stderr ?? ""}`);
        expect(output).not.toContain("TS18003");
        // The .mx file was compiled by the MX language plugin, not ignored:
        // its discovered tags type-check and the run is clean.
        expect(output).not.toContain("page.mx");
        expect(result.status).toBe(0);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a .mx-only project's template error instead of TS18003",
    () => {
      const project = mkdtempSync(join(tmpdir(), "mx-tsc-bun-"));
      try {
        mkdirSync(join(project, "src"));
        writeFileSync(
          join(project, "src", "page.mx"),
          "export const count = 1;\n<h1>$" + "{count}</h1>\n",
        );
        writeFileSync(
          join(project, "tsconfig.json"),
          JSON.stringify(
            {
              compilerOptions: {
                noEmit: true,
                strict: true,
                module: "esnext",
                moduleResolution: "bundler",
                target: "esnext",
                jsx: "preserve",
                types: [],
              },
              include: ["src"],
            },
            null,
            2,
          ),
        );
        const result = spawnSync(
          bun ?? "bun",
          [mxTsc, "--noEmit", "-p", join(project, "tsconfig.json")],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const output = strip(`${result.stdout ?? ""}${result.stderr ?? ""}`);
        expect(output).not.toContain("TS18003");
        // The plugin ran: the file's own line numbers are reported.
        expect(output).toContain("page.mx");
        expect(result.status).not.toBe(0);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe.skipIf(bun !== undefined)("mx-tsc under bun", () => {
  it.skip("bun is not on PATH; cannot prove mx-tsc runs under bun", () => {});
});

/**
 * The `discovered-tag` fixture copied into a temp directory, with its
 * `paths` entry for `@mxlang/target-html` rewritten to the absolute path of
 * this checkout (the fixture's is relative to its own place in the repo).
 */
function copyDiscoveredTagFixture(): string {
  const project = mkdtempSync(join(tmpdir(), "mx-tsc-bun-"));
  cpSync(join(fixtures, "discovered-tag"), project, { recursive: true });
  const tsconfigPath = join(project, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  tsconfig.compilerOptions.paths["@mxlang/target-html"] = [
    join(repoRoot, "packages", "targets", "html", "src", "index.ts"),
  ];
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  return project;
}
