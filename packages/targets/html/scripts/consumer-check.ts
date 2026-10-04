#!/usr/bin/env bun
//
// Decision 59: when the artifact is consumed from a clone/tarball, verify
// from a clone/tarball. `bun run typecheck`/`test` exercise this package's
// *source*, against its own tsconfig; neither proves that a real npm
// installer, resolving only `package.json` `exports`/`types`, can actually
// reach a working `dist/`. This script does: it packs the real tarball,
// installs it into a scratch project *outside* the repo (so bun's workspace
// resolution cannot silently paper over a broken `exports` map), compiles a
// template through the public API and through the Bun loader, typechecks
// the consumer's own `.ts` against the published `.d.ts`, and deletes the
// scratch project. It must be able to fail: run it with `dist/` missing (or
// pass `--simulate-missing-dist`) and it fails loud, not silent.
//
// Run from anywhere: `bun run packages/hosts/html/scripts/consumer-check.ts`.
// Wired into `bun run verify` at the root.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pkgDir, "dist");

const simulateMissingDist = process.argv.includes("--simulate-missing-dist");

/**
 * Every external step runs under a hard wall-clock timeout (decision 61: a
 * script must be able to fail, and a hang is a silent, unbounded pass).
 * `bun pm pack` hangs: first observed inside `packages/parser` (before
 * `core-extract` removed the translator's dependency on it), then again
 * on `packages/hosts/html` and `packages/core` with bun 1.3.14 on macOS,
 * spinning at 100% CPU (`kevent64`/`unlinkat` in `sample`), both when
 * spawned from a bun parent and from a plain shell. Root cause not
 * determined; this script packs with `npm pack` instead (PR #51), which
 * produces the same tarball for these packages. The timeout stays
 * as a standing guard against the same class of hang recurring on any
 * future dependency. Wrapped in the POSIX `timeout` command rather than
 * `AbortSignal.timeout` so a killed child's descendants are actually reaped
 * (`execFileSync` has no portable way to kill a process *tree*, and a
 * package-manager subcommand may spawn its own children).
 */
const STEP_TIMEOUT_SECONDS = 120;

function run(cmd: string[], cwd: string): string {
  console.log(`[consumer-check] $ ${cmd.join(" ")}  (cwd: ${cwd})`);
  try {
    return execFileSync("timeout", [`${STEP_TIMEOUT_SECONDS}s`, ...cmd], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 124) {
      fail(
        `\`${cmd.join(" ")}\` (cwd: ${cwd}) did not finish within ${STEP_TIMEOUT_SECONDS}s and was killed — a hang, not a pass.`,
      );
    }
    throw err;
  }
}

function fail(message: string): never {
  console.error(`[consumer-check] FAIL: ${message}`);
  process.exit(1);
}

if (simulateMissingDist) {
  if (!existsSync(distDir)) {
    console.log(
      "[consumer-check] dist/ already absent; this is the failure this flag exists to demonstrate.",
    );
  } else {
    fail(
      "dist/ exists, so --simulate-missing-dist cannot demonstrate the failure mode. Run `rm -rf dist` first, or omit the flag to run the real check.",
    );
  }
} else if (!existsSync(distDir)) {
  fail(
    `dist/ is missing at ${distDir} — run \`bun run build\` in packages/hosts/html first. (This is exactly the failure --simulate-missing-dist demonstrates.)`,
  );
}

function packTarball(dir: string): string {
  const output = run(["npm", "pack", "--pack-destination", "/tmp"], dir);
  const match = output.match(/([\w.@-]+\.tgz)/);
  if (!match) fail(`could not find tarball name in pack output: ${output}`);
  const tarballPath = join("/tmp", match[1] as string);
  if (!existsSync(tarballPath))
    fail(`packed tarball not found at ${tarballPath}`);
  return tarballPath;
}

console.log("[consumer-check] packing tarball...");
const tarballPath = packTarball(pkgDir);
console.log(`[consumer-check] packed: ${tarballPath}`);

// `@mxlang/core` (the Marko-node consumer, `translate.ts`'s import source)
// is a real runtime dependency, not a devDependency, but it is `private:
// true` and not on the npm registry — a plain `bun add` of the translator
// tarball 404s resolving it. Packing and installing it too proves this
// package is *installable* today without requiring `@mxlang/core` to
// actually be published yet.
const coreDir = join(pkgDir, "..", "..", "core");
console.log(
  "[consumer-check] packing @mxlang/core (unpublished dependency)...",
);
const coreTarballPath = packTarball(coreDir);
console.log(`[consumer-check] packed: ${coreTarballPath}`);

const scratchDir = mkdtempSync(join(tmpdir(), "consumer-check-"));
console.log(`[consumer-check] scratch project: ${scratchDir}`);

try {
  // `@mxlang/core` is a transitive dependency (declared by the translator
  // tarball's own `package.json`, rewritten from `workspace:*` to its literal
  // version at pack time), so a plain `bun add <tarball>` still resolves it
  // against the registry, 404s, and fails — passing the core tarball as a
  // second top-level `add` argument does not change how the *transitive*
  // reference resolves. `overrides` pins it to the local tarball by file:
  // path instead, standing in for `@mxlang/core` actually being published.
  writeFileSync(
    join(scratchDir, "package.json"),
    JSON.stringify(
      {
        name: "consumer-check-scratch",
        private: true,
        type: "module",
        overrides: {
          "@mxlang/core": `file:${coreTarballPath}`,
        },
      },
      null,
      2,
    ),
  );

  console.log("[consumer-check] installing packed tarballs (no workspace)...");
  run(["bun", "add", tarballPath, "@marko/compiler@5.42.5"], scratchDir);

  writeFileSync(
    join(scratchDir, "hello.mx"),
    "export interface Input { name: string }\n<h1>Hello, ${input.name}!</h1>\n",
  );

  // 1. Public API: `compile()`.
  writeFileSync(
    join(scratchDir, "via-api.ts"),
    [
      'import { compile } from "@mxlang/html";',
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync("hello.mx", "utf8");',
      'const { code } = compile(source, "hello.mx");',
      'if (!code.includes("Hello, ")) throw new Error("compile() did not produce the expected template body");',
      'console.log("via-api: ok");',
    ].join("\n"),
  );
  const apiOutput = run(["bun", "run", "via-api.ts"], scratchDir);
  if (!apiOutput.includes("via-api: ok"))
    fail(`public API check produced: ${apiOutput}`);

  // 2. Bun loader. `.mx` only — MX only supports the MX 1.0 subset of Marko
  // syntax, so the loader does not claim a real `.marko` file.
  writeFileSync(
    join(scratchDir, "bunfig.toml"),
    'preload = ["@mxlang/html/bun"]\n',
  );
  writeFileSync(
    join(scratchDir, "via-loader.ts"),
    [
      'import render from "./hello.mx";',
      'const html = render({ name: "World" });',
      'if (html !== "<h1>Hello, World!</h1>") throw new Error(`unexpected render: ${html}`);',
      'console.log("via-loader: ok");',
    ].join("\n"),
  );
  const loaderOutput = run(["bun", "run", "via-loader.ts"], scratchDir);
  if (!loaderOutput.includes("via-loader: ok"))
    fail(`Bun loader check produced: ${loaderOutput}`);

  // 3. Typecheck the consumer's own `.ts` against the published `.d.ts`.
  writeFileSync(
    join(scratchDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ES2022",
          noEmit: true,
          // Checked against the published `@mxlang/html` `.d.ts`
          // only; a dependency's own `.d.ts`/`.ts` internals (e.g. a
          // `bun-types`/`typescript` version skew unrelated to either
          // package) are not what this step exists to catch.
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["via-api.ts"],
      },
      null,
      2,
    ),
  );
  run(["bun", "add", "-d", "typescript@5", "@types/node"], scratchDir);
  run(["bunx", "tsc", "-p", "tsconfig.json"], scratchDir);
  console.log("[consumer-check] typecheck: ok");

  console.log("[consumer-check] PASS");
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
  rmSync(coreTarballPath, { force: true });
  console.log(
    `[consumer-check] cleaned up ${scratchDir}, ${tarballPath}, ${coreTarballPath}`,
  );
}
