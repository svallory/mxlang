#!/usr/bin/env bun
//
// Decision 143: prove the alpha tarball of `@mxlang/core` works for a consumer
// who installs only it. Core bundles `@mxlang/web-elements` (a devDependency
// of the workspace), so it is the only `@mxlang` package published for Mesh.
// Decision 204 deleted `@mxlang/data`: a consumer that reads the tree calls
// core's `lowerSource`. The probe
//   1. packs core with `bun pm pack` (the command `bun publish` runs), and
//      checks that its tarball lists no `@mxlang/*` in `dependencies` (a
//      `workspace:*` there would ship unrewritten by npm, or point at an
//      unpublished version);
//   2. installs the core tarball into a fresh `mktemp -d` project outside the
//      repo, once with npm and run by Node, once with Bun;
//   3. runs a `lowerSource` probe (`customTags`, `structural: "reject"`,
//      `unknownTags: "reject"`) that must return an IR for a valid file and
//      the unknown-tag diagnostic, with no IR, for a typo;
//   4. decision 159: proves the install parses with MX's own template parser:
//      `<input type="email" :email/>` and `x=a.b .c` split after the value,
//      and no npm `htmljs-parser` or `@marko/compiler` is installed or loaded.
//      Since decision 197 slice S3a a parse no longer builds Marko's taglib
//      lookup, so core's bundled `marko-frontend.cjs` must not load either.
//
// It must be able to fail: any step that exits non-zero, an unrewritten
// `workspace:*`, a missing IR, or a missing diagnostic fails the run.
//
// `bun pm pack`, not `npm pack`, because npm does not rewrite `workspace:*` and
// the point is to prove what `bun publish` ships. The root CLAUDE.md records a
// `bun pm pack` hang on macOS with bun 1.3.14; it did not hang here, and the
// per-step timeout kills it if it does.
//
// It builds core itself first. It installs into a scratch dir, so it needs the
// network only for core's registry dependencies (not for core itself: the
// consumer's dependency is the tarball).
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
const MIN_NODE_MAJOR = 26;
const tsc = join(repoRoot, "node_modules/.bin/tsc");

const CORE_DIR = join(repoRoot, "packages/core");

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

/** Build core, so the probe never packs a stale `dist`. */
{
  const built = run("bun", ["run", "build"], CORE_DIR);
  if (built.status !== 0)
    fail(`bun run build failed in ${CORE_DIR}:\n${built.out}`);
}

/** `bun pm pack` a package into `work/tarballs`; returns the tarball path. */
function pack(dir: string): string {
  if (!existsSync(join(dir, "dist"))) {
    fail(`${dir}/dist is missing after the build`);
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

const corePkg = JSON.parse(tarFile(coreTarball, "package/package.json")) as {
  version: string;
  dependencies: Record<string, string>;
};
console.log(
  `[alpha-probe] core tarball dependencies: ${JSON.stringify(corePkg.dependencies)}`,
);
const mxlangDeps = Object.keys(corePkg.dependencies ?? {}).filter((n) =>
  n.startsWith("@mxlang/"),
);
if (mxlangDeps.length > 0) {
  fail(
    `the core tarball depends on ${mxlangDeps.join(", ")}: core ships self-contained, and a published @mxlang dependency has to be added to the release set (and the alpha version bumped) first`,
  );
}

const PROBE = `
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { lowerSource, parseFragment } from "@mxlang/core";

const customTags = {
  resource: { parents: ["#root"], children: { attributes: {} } },
  attributes: { parents: ["resource"], attributes: { title: { type: "string" } } },
};
const options = { customTags, structural: "reject", unknownTags: "reject" };

const ok = lowerSource('<resource>\\n  <attributes title="Post"/>\\n</resource>\\n', "/probe/ok.mx", options);
const unknown = lowerSource("<resorce/>\\n", "/probe/unknown.mx", options);
const structural = lowerSource("<if=true>\\n  <resource/>\\n</if>\\n", "/probe/structural.mx", options);
const parents = lowerSource("<attributes/>\\n", "/probe/parents.mx", options);

const summary = {
  runtime: typeof Bun === "undefined" ? "node " + process.version : "bun " + Bun.version,
  ok: {
    ir: ok.ir ? { body: ok.ir.body.map((n) => n.kind + ":" + n.tag?.name), tagChildren: ok.ir.body[0].tag.children.map((c) => c.tag?.name) } : null,
    diagnostics: ok.diagnostics,
  },
  unknownTag: { ir: unknown.ir ?? null, diagnostics: unknown.diagnostics },
  structuralReject: { ir: structural.ir ?? null, diagnostics: structural.diagnostics },
  parentsReject: { ir: parents.ir ?? null, diagnostics: parents.diagnostics },
};
console.log(JSON.stringify(summary, null, 2));

const fail = (message) => { throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!ok.ir) fail("the valid file returned no IR");
if (!same(summary.ok.ir.body, ["DelegatedTag:resource"])) fail("wrong body: " + JSON.stringify(summary.ok.ir.body));
if (!same(summary.ok.ir.tagChildren, ["attributes"])) fail("wrong resource children: " + JSON.stringify(summary.ok.ir.tagChildren));
if (ok.diagnostics.length !== 0) fail("the valid file has diagnostics: " + JSON.stringify(ok.diagnostics));
for (const [name, result, text] of [
  ["unknown tag", unknown, "is not a known tag"],
  ["structural", structural, "static"],
  ["parents", parents, "must be inside"],
]) {
  if (result.ir) fail("the " + name + " file returned an IR");
  if (result.diagnostics.length !== 1 || result.diagnostics[0].severity !== "error" || !result.diagnostics[0].message.includes(text)) {
    fail("the " + name + " file has the wrong diagnostic: " + JSON.stringify(result.diagnostics));
  }
}

// Decision 159: the after-value sugar parses in a registry install.
const sugar = lowerSource('<field type="email" :email/>\\n', "/probe/sugar.mx", {
  customTags: { field: { parents: ["#root"], attributes: { type: { type: "string" }, name: { type: "string" } } } },
  structural: "reject",
  unknownTags: "reject",
});
const field = sugar.ir?.body[0]?.tag;
const sugarAttrs = field ? field.attrs.map((a) => a.name) : null;
console.log("after-value sugar:", JSON.stringify({ attrs: sugarAttrs, diagnostics: sugar.diagnostics }));
if (sugar.diagnostics.length !== 0 || !same(sugarAttrs, ["type", "name"])) {
  fail("<field type=\\"email\\" :email/> did not parse as type + name: " + JSON.stringify({ attrs: sugarAttrs, diagnostics: sugar.diagnostics }));
}
// Since 0.1.0-alpha.13 \`FragmentResult.body\` is the MX AST: the split-off \`.c\` is an \`MxShorthand\` node, not a named attribute.
const member = parseFragment("<div x=a.b .c/>").body[0].attributes.map((a) => a.type === "MxShorthand" ? "MxShorthand" : a.name);
if (!same(member, ["x", "MxShorthand"])) fail("x=a.b .c did not split after the value: " + JSON.stringify(member));
const split = lowerSource("<div x=a.b .c/>\\n", "/t.mx").ir?.body[0]?.tag.attrs.map((a) => a.name + "=" + (a.value?.code ?? a.value));
if (!same(split, ["x=a.b", "class=c"])) fail("x=a.b .c did not reach the IR as x + class: " + JSON.stringify(split));
const require = createRequire(import.meta.url);
const loaded = Object.keys(require.cache);
console.log("loaded parse layer:", JSON.stringify(loaded.filter((k) => /marko|htmljs/.test(k))));
if (loaded.some((k) => k.endsWith("/@mxlang/core/dist/marko-frontend.cjs"))) fail("core's marko-frontend.cjs was loaded by a parse");
for (const name of ["htmljs-parser", "@marko/compiler"]) {
  if (loaded.some((k) => k.includes("/node_modules/" + name + "/"))) fail("an npm " + name + " was loaded");
  if (existsSync("node_modules/" + name)) fail("an npm " + name + " is installed at node_modules/" + name);
  let resolved = null;
  try { resolved = createRequire(require.resolve("@mxlang/core"))(name) && name; } catch {}
  if (resolved) fail(name + " resolves from the installed @mxlang/core");
}
console.log("probe passed");
`;

function consumer(label: string): string {
  const dir = join(work, label);
  mkdirSync(dir, { recursive: true });
  // Core is not on the registry before the first publish: pin it to its
  // tarball.
  const overrides = {
    "@mxlang/core": `file:${coreTarball}`,
  };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `alpha-probe-${label}`,
        private: true,
        type: "module",
        dependencies: {
          "@mxlang/core": `file:${coreTarball}`,
        },
        overrides,
        resolutions: overrides,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "probe.mjs"), PROBE);
  writeFileSync(join(dir, "use.ts"), USE);
  return dir;
}

/** What a consumer writes: the IR entry point, with real types. */
const USE = `import {
  type CustomTag,
  type LowerSourceOptions,
  lowerSource,
  type SourceSpan,
  type SpannedIr,
} from "@mxlang/core";

const customTags: Record<string, CustomTag> = { resource: { parents: ["#root"] } };
const options: LowerSourceOptions = { customTags, structural: "reject", unknownTags: "reject" };
const ir: SpannedIr | undefined = lowerSource("<resource/>\\n", "/x.mx", options).ir;
const first = ir?.body[0];
export const name: string | undefined = first?.kind === "DelegatedTag" ? first.tag.name : undefined;
// The span guarantee is in the type: no \`?\` on a tag's span.
export const spans: SourceSpan[] = (ir?.body ?? []).flatMap((n) => (n.kind === "DelegatedTag" ? [n.tag.span] : []));
// @ts-expect-error unknownTags only takes "allow" | "reject"
export const bad: LowerSourceOptions = { unknownTags: "nope" };
`;

/** \`tsc --noEmit\` over \`use.ts\`, strict and with \`skipLibCheck: false\`, per resolution mode. */
function typecheck(dir: string): void {
  for (const mode of ["bundler", "node16"] as const) {
    writeFileSync(
      join(dir, `tsconfig.${mode}.json`),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: mode === "bundler" ? "esnext" : "node16",
          moduleResolution: mode,
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["use.ts"],
      }),
    );
    const r = run(tsc, ["-p", `tsconfig.${mode}.json`], dir);
    console.log(
      `[alpha-probe] tsc (${mode}) exit ${r.status}${r.out.trim() ? `\n${r.out.trim()}` : ""}`,
    );
    if (r.status !== 0)
      fail(`the consumer typecheck failed under moduleResolution ${mode}`);
  }
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
const nodeVersion = run("node", ["--version"], nodeDir).out.trim();
console.log(
  `[alpha-probe] node ${nodeVersion}, npm ${run("npm", ["--version"], nodeDir).out.trim()}`,
);
if (Number(nodeVersion.replace(/^v/, "").split(".")[0]) < MIN_NODE_MAJOR) {
  fail(
    `the npm leg needs Node ${MIN_NODE_MAJOR} or newer, found ${nodeVersion}`,
  );
}
check("node+npm", run("node", ["probe.mjs"], nodeDir));
typecheck(nodeDir);

// Bun.
const bunDir = consumer("bun");
const bun = run("bun", ["install"], bunDir);
if (bun.status !== 0) fail(`bun install failed:\n${bun.out}`);
check("bun", run("bun", ["probe.mjs"], bunDir));
typecheck(bunDir);

console.log("[alpha-probe] PASS");
if (keep) console.log(`[alpha-probe] kept ${work}`);
else rmSync(work, { recursive: true, force: true });
