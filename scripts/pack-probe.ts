#!/usr/bin/env bun
//
// Decision 59: verify a published artifact from a consumer's side. The unit
// tests in `pack-hygiene.test.ts` read the tarball's file list and its `.d.ts`
// import specifiers; this probe proves the consequence. For every packaged
// library it packs the real tarball, installs it (plus its declared deps) into
// a scratch project OUTSIDE the repo, and typechecks a file that imports every
// `exports` subpath with `skipLibCheck: false` — which typechecks the
// package's own `.d.ts` (and every declaration it drags in), the way a strict
// consumer does. A `.d.ts` that imports an undeclared module (G8, PR #174)
// fails here, not in the workspace, where hoisting hides it.
//
// It must be able to fail (decision 61):
//   - NEGATIVE case: `@mxlang/html` WITHOUT its optional peer `@types/bun`
//     must fail on `dist/bun.d.ts` with TS2307. If that ever passes, the probe
//     has stopped seeing what it exists to see, and the script fails.
//   - `mx-tsc` smoke: the packed `@mxlang/tsc` must expose a bin that starts.
//
// One extra REPORT-ONLY case: a `moduleResolution: node16` consumer of the
// `.ts`-extension specifiers in the emitted declarations. It prints, it does
// not fail the run.
//
// Heavy (installs several dependency trees): run under
// `flock /tmp/mac-heavy.lock`. Needs a prior `bun run build`.
//   bun run scripts/pack-probe.ts [--keep] [--only <name>]
//
// `npm pack`, not `bun pm pack`, for the same reason as
// `packages/hosts/html/scripts/consumer-check.ts` (bun 1.3.14 hangs on macOS).
// npm does NOT rewrite `workspace:*` in the packed manifest, so private
// workspace deps are pinned to tarballs/stubs with `overrides`, as consumer-check does.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportSpecifiers,
  PACKED_PACKAGES,
  type PackageJson,
  pkgDirOf,
  readPackageJson,
  repoRoot,
} from "./pack-hygiene.ts";

const keep = process.argv.includes("--keep");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

const STEP_TIMEOUT_MS = 240_000;
const tsc = join(repoRoot, "node_modules/.bin/tsc");

/**
 * D5 (publish-plan-private-deps, TODO.md): these workspace packages are
 * `private` and runtime deps of publishable ones, so a real install would
 * 404. The probe packs the ones that ship a `dist` and stubs the rest (their
 * `main` is `src/*.ts`, which no consumer could load). Named, not silent.
 */
const PACK_PRIVATE = ["@mxlang/core", "@mxlang/parser"];
const STUB_PRIVATE = [
  "@mxlang/hono",
  "@mxlang/preact",
  "@mxlang/react",
  "@mxlang/solid",
  "@mxlang/target-registry",
];

function fail(message: string): never {
  console.error(`[pack-probe] FAIL: ${message}`);
  process.exit(1);
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): { status: number; out: string; stdout: string } {
  console.log(`[pack-probe] $ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error)
    fail(`\`${cmd} ${args.join(" ")}\` did not finish: ${r.error.message}`);
  return {
    status: r.status ?? 1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    stdout: r.stdout ?? "",
  };
}

const work = mkdtempSync(join(tmpdir(), "pack-probe-"));
console.log(`[pack-probe] scratch: ${work}`);

/** `npm pack` a workspace dir into `work/tarballs`; returns the tarball path. */
const tarballs = new Map<string, string>();
function tarballOf(name: string, dir: string): string {
  const cached = tarballs.get(name);
  if (cached) return cached;
  if (!existsSync(join(dir, "dist"))) {
    fail(`${dir}/dist is missing: run \`bun run build\` first`);
  }
  const dest = join(work, "tarballs");
  mkdirSync(dest, { recursive: true });
  const { status, out, stdout } = run(
    "npm",
    ["pack", "--pack-destination", dest],
    dir,
  );
  if (status !== 0) fail(`npm pack failed in ${dir}:\n${out}`);
  const file = stdout.trim().split("\n").pop()?.trim() ?? "";
  const path = join(dest, file);
  if (!file.endsWith(".tgz") || !existsSync(path)) {
    fail(`could not find the tarball in npm pack output:\n${out}`);
  }
  tarballs.set(name, path);
  return path;
}

const workspaceDirs: Record<string, string> = {
  "@mxlang/core": join(repoRoot, "packages/core"),
  "@mxlang/parser": join(repoRoot, "packages/parser"),
};
for (const p of PACKED_PACKAGES) workspaceDirs[p.name] = pkgDirOf(p);
workspaceDirs["@mxlang/typescript-plugin"] = join(
  repoRoot,
  "packages/tooling/typescript-plugin",
);

/**
 * Type surface a stub must carry because a probed package's `.d.ts` imports it
 * (`skipLibCheck: false` needs the module to have declarations). D5 stubs have
 * no real types; each entry names the one type the importing `.d.ts` uses.
 */
const STUB_TYPES: Record<string, string> = {
  // `typescript-plugin/dist/amx-language.d.ts` imports it from `@mxlang/astro/template`.
  "@mxlang/astro": "export type AstroTemplateMapping = unknown;\n",
};

function stubDir(name: string): string {
  const dir = join(work, "stubs", name.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  // Every subpath (`@mxlang/astro/template`, …) resolves to the same empty module.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.0",
      main: "index.js",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./*": { types: "./index.d.ts", default: "./index.js" },
      },
    }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "index.d.ts"), STUB_TYPES[name] ?? "export {};\n");
  return dir;
}

interface ConsumerOptions {
  /** Packages installed as their tarballs' own top-level dependencies. */
  root: string;
  /** Install the root's optional peers too (a consumer of the optional feature). */
  withOptionalPeers: boolean;
  /** Extra top-level dependencies the consumer is documented to need. */
  extraDeps?: Record<string, string>;
  /** More workspace packages pinned to their tarballs (transitive private deps). */
  packExtra?: string[];
  /** More private workspace packages pinned to empty stubs. */
  stubExtra?: string[];
  /** Consumer tsconfig overrides. */
  compilerOptions?: Record<string, unknown>;
  label: string;
}

function optionalPeers(pkg: PackageJson): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional) out[name] = range;
  }
  return out;
}

/** Builds and installs a consumer project; returns its directory. */
function makeConsumer(opts: ConsumerOptions): string {
  const dir = join(work, `consumer-${opts.label}`);
  mkdirSync(dir, { recursive: true });
  const rootPkg = readPackageJson(workspaceDirs[opts.root] as string);
  const overrides: Record<string, string> = {};
  for (const name of PACK_PRIVATE) {
    overrides[name] = `file:${tarballOf(name, workspaceDirs[name] as string)}`;
  }
  // `@mxlang/html` is a dep of the language server: a real tarball.
  const packExtra = new Set(opts.packExtra ?? []);
  // Every workspace dep of the root that has a dist is packed, not resolved.
  for (const [dep, range] of Object.entries(rootPkg.dependencies ?? {})) {
    if (range.startsWith("workspace:") && workspaceDirs[dep])
      packExtra.add(dep);
  }
  for (const name of packExtra) {
    overrides[name] = `file:${tarballOf(name, workspaceDirs[name] as string)}`;
  }
  for (const name of [...STUB_PRIVATE, ...(opts.stubExtra ?? [])]) {
    overrides[name] = `file:${stubDir(name)}`;
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `probe-${opts.label}`,
        private: true,
        type: "module",
        dependencies: {
          [opts.root]: `file:${tarballOf(opts.root, workspaceDirs[opts.root] as string)}`,
          ...(opts.withOptionalPeers ? optionalPeers(rootPkg) : {}),
          ...opts.extraDeps,
        },
        overrides,
        resolutions: overrides,
      },
      null,
      2,
    ),
  );
  const install = run("bun", ["install"], dir);
  if (install.status !== 0)
    fail(`bun install failed for ${opts.label}:\n${install.out}`);

  const specs = exportSpecifiers(rootPkg);
  // An ambient-declaration file (`types/marko.d.ts`, `declare module "*.mx"`)
  // is not a module: it can only be side-effect imported.
  const ambient = specs.filter((s) => s.includes("/types/"));
  const modules = specs.filter((s) => !ambient.includes(s));
  writeFileSync(
    join(dir, "probe.ts"),
    [
      ...modules.map((s, i) => `import type * as m${i} from "${s}";`),
      ...ambient.map((s) => `import "${s}";`),
      // The ambient `*.mx` declaration must actually type an import.
      ...(ambient.length > 0
        ? [
            'import page from "./page.mx";',
            "export const rendered: string = page({});",
          ]
        : []),
      // The plugin's CJS entry is a factory function (tsserver needs that), so
      // prove the packed declarations still present a default export and named
      // exports to an ESM consumer.
      ...(opts.root === "@mxlang/typescript-plugin"
        ? [
            'import plugin, { createMxLanguagePlugin } from "@mxlang/typescript-plugin";',
            "export const factory: typeof plugin = plugin;",
            "export const named: typeof createMxLanguagePlugin = createMxLanguagePlugin;",
          ]
        : []),
      `export type { ${modules.map((_, i) => `m${i}`).join(", ")} };`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          noUncheckedSideEffectImports: true,
          types: [],
          ...opts.compilerOptions,
        },
        include: ["probe.ts"],
      },
      null,
      2,
    ),
  );
  return dir;
}

function typecheck(dir: string): { ok: boolean; out: string } {
  const { status, out } = run(tsc, ["-p", "tsconfig.json"], dir);
  return { ok: status === 0, out };
}

/**
 * `@mxlang/tsc` ships a CLI bundle only. Install its tarball and declared
 * deps, then run the bin: the file must exist in the tarball, be linked by the
 * installer, and its runtime `require`s must resolve. Private workspace deps
 * are packed (typescript-plugin, angular, html, core, parser) or stubbed (D5).
 */
function smokeMxTsc(): string | undefined {
  const dir = makeConsumer({
    root: "@mxlang/tsc",
    label: "tsc-smoke",
    withOptionalPeers: true,
    // `typescript` is a peer of `@mxlang/tsc` (">=5.9.0 <7"); a consumer supplies it.
    extraDeps: { typescript: "6.0.3" },
    packExtra: ["@mxlang/typescript-plugin", "@mxlang/angular", "@mxlang/html"],
    stubExtra: ["@mxlang/astro"],
  });
  const bin = join(dir, "node_modules/.bin/mx-tsc");
  if (!existsSync(bin)) return `mx-tsc bin was not linked at ${bin}`;
  const r = run(bin, ["--version"], dir);
  console.log(
    `[pack-probe] mx-tsc --version: exit ${r.status}\n${r.out.trim().split("\n").slice(0, 12).join("\n")}`,
  );
  if (r.status !== 0 || !/Version \d+\.\d+/.test(r.out)) {
    return `mx-tsc --version did not print a TypeScript version (exit ${r.status})\n${r.out}`;
  }

  // One real typecheck, which loads the plugin and the compiler through the
  // packed bundle's own `createRequire`s: the `.mx` import resolves and types,
  // so the deliberate misuse is the only error (an unresolved plugin would
  // report TS2307 for `./comp.mx` instead).
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as object;
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, mx: { host: "html" } }, null, 2),
  );
  writeFileSync(join(dir, "comp.mx"), "<div>hi</div>\n");
  writeFileSync(
    join(dir, "index.ts"),
    'import Comp from "./comp.mx";\nconst misuse: number = Comp;\n',
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        noEmit: true,
        skipLibCheck: true,
      },
      files: ["index.ts"],
    }),
  );
  const check = run(bin, ["-p", "tsconfig.json"], dir);
  console.log(
    `[pack-probe] mx-tsc typecheck: exit ${check.status}\n${check.out.trim().split("\n").slice(0, 6).join("\n")}`,
  );
  if (!/TS2322/.test(check.out) || /TS2307/.test(check.out)) {
    return `mx-tsc did not type the .mx import (expected exactly the planted TS2322):\n${check.out}`;
  }
  return undefined;
}

/**
 * D4: the language server's d.ts re-exposes `vscode-languageserver/node`, whose
 * own declarations need `@types/node` (installed AND loaded: `types: []` would
 * hide its globals). Documented in the package README; every other package's
 * declarations are self-contained.
 */
function nodeTypes(
  name: string,
  compilerOptions: Record<string, unknown> = {},
): Pick<ConsumerOptions, "extraDeps" | "compilerOptions"> {
  return name === "@mxlang/language-server"
    ? {
        extraDeps: { "@types/node": "26.5.1" },
        compilerOptions: { ...compilerOptions, types: ["node"] },
      }
    : { compilerOptions };
}

/**
 * Private workspace deps of a probed package beyond `STUB_PRIVATE`: the plugin
 * bundles `@mxlang/astro` (a `bun build --external`), whose `main` is
 * `src/*.ts`, so a consumer install cannot load it (D5).
 */
/** The plugin's own exact `devDependencies.typescript`: the version CI builds with. */
function pluginTypescript(): string {
  const version = (
    readPackageJson(workspaceDirs["@mxlang/typescript-plugin"] as string) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies?.typescript;
  if (!version) fail("typescript-plugin has no devDependencies.typescript");
  return version;
}

function privateStubs(
  name: string,
): Pick<ConsumerOptions, "stubExtra" | "extraDeps"> {
  return name === "@mxlang/typescript-plugin"
    ? {
        stubExtra: ["@mxlang/astro"],
        // `typescript` is a required peer (">=5.9.0 <7"); a consumer supplies
        // it, and an unpinned install would resolve 7.x.
        extraDeps: { typescript: pluginTypescript() },
      }
    : {};
}

const only_ = (name: string) => !only || name === only;
const problems: string[] = [];

try {
  // 1. Positive probes: every packaged library, skipLibCheck: false.
  for (const p of PACKED_PACKAGES) {
    if (!p.declarations || !only_(p.name)) continue;
    const dir = makeConsumer({
      root: p.name,
      label: p.name.replace("@mxlang/", ""),
      withOptionalPeers: true,
      ...privateStubs(p.name),
      ...nodeTypes(p.name),
    });
    const r = typecheck(dir);
    if (r.ok) console.log(`[pack-probe] PASS ${p.name}`);
    else
      problems.push(`${p.name}: skipLibCheck:false typecheck failed\n${r.out}`);
  }

  // 2. Negative case: html without its optional `@types/bun` must fail on bun.d.ts.
  if (only_("@mxlang/html")) {
    const dir = makeConsumer({
      root: "@mxlang/html",
      label: "html-no-types-bun",
      withOptionalPeers: false,
    });
    const r = typecheck(dir);
    const onBunDts =
      /node_modules\/@mxlang\/html\/dist\/bun\.d\.ts\(\d+,\d+\): error TS2307: Cannot find module 'bun'/.test(
        r.out,
      );
    if (!r.ok && onBunDts) {
      console.log(
        "[pack-probe] PASS negative: html without @types/bun fails with TS2307 on dist/bun.d.ts",
      );
    } else {
      problems.push(
        `negative case did not fail as designed (ok=${r.ok}, TS2307 on dist/bun.d.ts=${onBunDts}) — the probe can no longer see the defect it exists for\n${r.out}`,
      );
    }
  }

  // 3. mx-tsc: the packed bin must exist and start.
  if (only_("@mxlang/tsc")) {
    const problem = smokeMxTsc();
    if (problem) problems.push(problem);
    else console.log("[pack-probe] PASS mx-tsc starts from the packed tarball");
  }

  // 4. Report only: node16 consumers of the `.ts`-extension specifiers.
  for (const p of PACKED_PACKAGES) {
    if (!p.declarations || !only_(p.name)) continue;
    const dir = makeConsumer({
      root: p.name,
      label: `${p.name.replace("@mxlang/", "")}-node16`,
      withOptionalPeers: true,
      ...privateStubs(p.name),
      ...nodeTypes(p.name),
      ...nodeTypes(p.name, { module: "node16", moduleResolution: "node16" }),
    });
    const r = typecheck(dir);
    console.log(
      `[pack-probe] REPORT node16 ${p.name}: ${r.ok ? "ok" : `FAIL\n${r.out.split("\n").slice(0, 8).join("\n")}`}`,
    );
  }
} finally {
  if (keep) console.log(`[pack-probe] kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  fail(`\n${problems.join("\n\n")}`);
}
console.log("[pack-probe] PASS");
