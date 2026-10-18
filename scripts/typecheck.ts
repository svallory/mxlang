#!/usr/bin/env bun
/**
 * Incremental typecheck: the same per-package loop as the root `typecheck`
 * script, but each `tsc --noEmit` pass keeps a `.tsbuildinfo` cache under
 * `node_modules/.cache/tsc-typecheck/`, so an unchanged package costs one
 * cache read instead of a full program check.
 *
 *   bun run typecheck:incr        # cached typecheck
 *
 * The default `bun run typecheck` (and therefore `verify`, the gate and CI)
 * stays non-incremental: a fresh run must never depend on a cache that a
 * stale `dist/` or a rebase could invalidate silently. The caches are safe to
 * delete at any time; the next run is then simply a cold one.
 *
 * A package whose own `typecheck` script is more than plain `tsc` (the mx-tsc
 * wrapper examples, `ng build` chains) is delegated to that script unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cacheDir = resolve(root, "node_modules/.cache/tsc-typecheck");

function listDirs(): string[] {
  const out = spawnSync(
    "bash",
    [
      "-c",
      'for d in packages/*/ packages/*/*/ examples/*/; do [ -f "$d/tsconfig.json" ] && echo "$d"; done',
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout.split("\n").filter(Boolean);
}

type Mode =
  | { kind: "tsc"; project?: string }
  | { kind: "delegate"; script: string };

function modeFor(dir: string): Mode {
  const pkgPath = resolve(root, dir, "package.json");
  if (!existsSync(pkgPath)) return { kind: "tsc" };
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { kind: "tsc" };
  }
  const script: string | undefined = pkg.scripts?.typecheck;
  if (!script) return { kind: "tsc" };
  if (script.trim() === "tsc --noEmit") return { kind: "tsc" };
  const m = /^tsc -p (tsconfig\.[\w.]+\.json)$/.exec(script.trim());
  if (m) return { kind: "tsc", project: m[1] };
  return { kind: "delegate", script };
}

function slug(dir: string): string {
  return dir.replace(/\/+$/, "").replace(/[/.]+/g, "__");
}

function main(): number {
  mkdirSync(cacheDir, { recursive: true });
  let failed = 0;
  for (const dir of listDirs()) {
    const mode = modeFor(dir);
    console.log(`[typecheck:incr] ${dir} (${mode.kind})`);
    const info = resolve(cacheDir, `${slug(dir)}.tsbuildinfo`);
    const args =
      mode.kind === "tsc"
        ? [
            "--noEmit",
            "--incremental",
            "--tsBuildInfoFile",
            info,
            ...(mode.project ? ["-p", mode.project] : []),
          ]
        : ["run", "typecheck"];
    const cmd =
      mode.kind === "tsc" ? resolve(root, "node_modules/.bin/tsc") : "bun";
    const r = spawnSync(cmd, args, {
      cwd: resolve(root, dir),
      stdio: "inherit",
    });
    if ((r.status ?? 1) !== 0) failed++;
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
