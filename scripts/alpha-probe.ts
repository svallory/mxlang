#!/usr/bin/env bun
//
// Decision 143: prove the two alpha tarballs (`@mxlang/core`, `@mxlang/data`)
// work for a consumer who installs only them. The probe
//   1. packs both with `bun pm pack` (the command `bun publish` runs), and
//      checks that the data tarball's `@mxlang/core` is core's exact version
//      and not `workspace:*` (npm does not rewrite it, bun does);
//   2. installs the two tarballs into a fresh `mktemp -d` project outside the
//      repo, once with npm and run by Node, once with Bun;
//   3. runs a `parseData` probe (`customTags`, `structural: "reject"`,
//      `unknownTags: "reject"`) that must return a tree for a valid file and
//      the unknown-tag diagnostic, with no tree, for a typo.
//
// It must be able to fail: any step that exits non-zero, an unrewritten
// `workspace:*`, a missing tree, or a missing diagnostic fails the run.
//
// `bun pm pack`, not `npm pack`, because npm does not rewrite `workspace:*` and
// the point is to prove what `bun publish` ships. The root CLAUDE.md records a
// `bun pm pack` hang on macOS with bun 1.3.14; it did not hang here, and the
// per-step timeout kills it if it does.
//
// Needs a prior `bun run build`. It installs into a scratch dir, so it needs
// the network only for core's and data's registry dependencies (not for the
// two `@mxlang` packages: `overrides` pin both to the tarballs).
//   bun run scripts/alpha-probe.ts [--keep]
//
// Not part of `verify` or CI yet (the first manual alpha comes first).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./pack-hygiene.ts";

const keep = process.argv.includes("--keep");
const STEP_TIMEOUT_MS = 240_000;

const CORE_DIR = join(repoRoot, "packages/core");
const DATA_DIR = join(repoRoot, "packages/targets/data");

function fail(message: string): never {
  console.error(`[alpha-probe] FAIL: ${message}`);
  process.exit(1);
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): { status: number; out: string } {
  console.log(`[alpha-probe] $ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error)
    fail(`\`${cmd} ${args.join(" ")}\` did not finish: ${r.error.message}`);
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const work = mkdtempSync(join(tmpdir(), "alpha-probe-"));
console.log(`[alpha-probe] scratch: ${work}`);

/** `bun pm pack` a package into `work/tarballs`; returns the tarball path. */
function pack(dir: string): string {
  if (!existsSync(join(dir, "dist"))) {
    fail(`${dir}/dist is missing: run \`bun run build\` first`);
  }
  const dest = join(work, "tarballs");
  mkdirSync(dest, { recursive: true });
  const { status, out } = run(
    "bun",
    ["pm", "pack", "--destination", dest],
    dir,
  );
  if (status !== 0) fail(`bun pm pack failed in ${dir}:\n${out}`);
  const file = out.match(/^(\S+\.tgz)$/m)?.[1];
  if (!file || !existsSync(file)) {
    fail(`could not find the tarball in bun pm pack output:\n${out}`);
  }
  return file;
}

/** One file of a tarball, via the system `tar`. */
function tarFile(tarball: string, path: string): string {
  const r = spawnSync("tar", ["-xzOf", tarball, path], { encoding: "utf8" });
  if (r.status !== 0) fail(`tar could not read ${path} from ${tarball}`);
  return r.stdout;
}

const coreTarball = pack(CORE_DIR);
const dataTarball = pack(DATA_DIR);

const corePkg = JSON.parse(tarFile(coreTarball, "package/package.json")) as {
  version: string;
};
const dataPkg = JSON.parse(tarFile(dataTarball, "package/package.json")) as {
  version: string;
  dependencies: Record<string, string>;
};
console.log(
  `[alpha-probe] data tarball dependencies: ${JSON.stringify(dataPkg.dependencies)}`,
);
if (dataPkg.dependencies["@mxlang/core"] !== corePkg.version) {
  fail(
    `the data tarball depends on @mxlang/core@${dataPkg.dependencies["@mxlang/core"]}, expected the exact version ${corePkg.version} (workspace:* not rewritten?)`,
  );
}

const PROBE = `
import { parseData } from "@mxlang/data";

const customTags = {
  resource: { parents: ["#root"], children: { attributes: {} } },
  attributes: { parents: ["resource"], attributes: { title: { type: "string" } } },
};
const options = { customTags, structural: "reject", unknownTags: "reject" };

const ok = parseData('<resource>\\n  <attributes title="Post"/>\\n</resource>\\n', "/probe/ok.mx", options);
const bad = parseData("<resorce/>\\n", "/probe/bad.mx", options);

const summary = {
  runtime: typeof Bun === "undefined" ? "node " + process.version : "bun " + Bun.version,
  ok: {
    tree: ok.tree ? { children: ok.tree.children.map((c) => c.kind + ":" + c.name), tagChildren: ok.tree.children[0].children.map((c) => c.name) } : null,
    diagnostics: ok.diagnostics,
  },
  unknownTag: { tree: bad.tree ?? null, diagnostics: bad.diagnostics },
};
console.log(JSON.stringify(summary, null, 2));

if (!ok.tree) throw new Error("the valid file returned no tree");
if (bad.tree) throw new Error("the unknown-tag file returned a tree");
if (!bad.diagnostics[0]?.message.includes("is not a known tag")) {
  throw new Error("no unknown-tag diagnostic: " + JSON.stringify(bad.diagnostics));
}
console.log("probe passed");
`;

function consumer(label: string): string {
  const dir = join(work, label);
  mkdirSync(dir, { recursive: true });
  // `@mxlang/data` depends on `@mxlang/core@<alpha>`, which is not on the
  // registry before the first publish: pin it to the tarball.
  const overrides = { "@mxlang/core": `file:${coreTarball}` };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `alpha-probe-${label}`,
        private: true,
        type: "module",
        dependencies: {
          "@mxlang/core": `file:${coreTarball}`,
          "@mxlang/data": `file:${dataTarball}`,
        },
        overrides,
        resolutions: overrides,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "probe.mjs"), PROBE);
  return dir;
}

function check(label: string, probe: { status: number; out: string }): void {
  console.log(`[alpha-probe] ${label} output:\n${probe.out.trim()}`);
  if (probe.status !== 0 || !probe.out.includes("probe passed")) {
    fail(`the ${label} probe did not pass (exit ${probe.status})`);
  }
}

// Node + npm.
const nodeDir = consumer("node-npm");
const npm = run(
  "npm",
  ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
  nodeDir,
);
if (npm.status !== 0) fail(`npm install failed:\n${npm.out}`);
console.log(
  `[alpha-probe] node ${run("node", ["--version"], nodeDir).out.trim()}, npm ${run("npm", ["--version"], nodeDir).out.trim()}`,
);
check("node+npm", run("node", ["probe.mjs"], nodeDir));

// Bun.
const bunDir = consumer("bun");
const bun = run("bun", ["install"], bunDir);
if (bun.status !== 0) fail(`bun install failed:\n${bun.out}`);
check("bun", run("bun", ["probe.mjs"], bunDir));

console.log("[alpha-probe] PASS");
if (keep) console.log(`[alpha-probe] kept ${work}`);
else rmSync(work, { recursive: true, force: true });
