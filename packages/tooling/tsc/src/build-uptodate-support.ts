import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `tsc -b` skips a project its build info calls up to date, and tsc's
 * incremental state knows nothing about Angular templates. These tests pin the
 * ruling that the template pass runs for every project of the build graph
 * regardless: the second, no-change run must fail exactly as the first did.
 *
 * Each case works on its own copy of a `fixtures/ng-build-*` project under the
 * OS temp dir (so `-b` leaves no `out/` or `.tsbuildinfo` in the repo, and a
 * case can edit a template between runs), with the package's own
 * `node_modules` linked in so `@angular/compiler-cli` and `@angular/core`
 * resolve.
 *
 * Runtime: most cases run `mx-tsc` in this process (`runMxTscArgs`, see
 * `mxTscIn`): no node start-up, no child processes competing with the other
 * tsc test worker (a worker blocked in a synchronous spawn is what made CI's
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` fire). They run one after
 * another: the entry is synchronous and touches process-global state. Two cases
 * spawn the real binary for the exit code and the bin path (the up-to-date
 * silent pass, and `-b --help` / `--version`), asynchronously and gated.
 * Each case spends its runs on one scenario (build, rebuild, edit, ...) instead
 * of rebuilding a fresh copy per assertion.
 */

export const CASE_TIMEOUT_MS = 300_000;
/** Live spawned `mx-tsc` processes at once (only the e2e cases spawn). */
const MAX_PROCESSES = 2;
export const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, "..");
export const mxTsc = join(packageDir, "dist", "bin.cjs");
export const fixtures = join(here, "fixtures");
export const refsFixture = join(fixtures, "ng-build-refs");
/** Angular CLI's default layout: a solution root, a non-composite app project. */
export const cliFixture = join(fixtures, "ng-build-cli");
export const solutionFixture = join(fixtures, "ng-build-solution");

// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
export const CLEAN = "<p>${user.name}</p>";
// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
export const BROKEN = "<p>${user.nmae}</p>";

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

let live = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (live < MAX_PROCESSES) {
    live++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else live--;
}

export async function mxTscSpawn(cwd: string, args: string[]): Promise<Run> {
  await acquire();
  try {
    return await new Promise<Run>((resolve) => {
      execFile(
        process.execPath,
        [mxTsc, ...args],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1" },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolve({
            status: error ? (typeof code === "number" ? code : 1) : 0,
            stdout,
            stderr,
            output: `${stdout}${stderr}`,
          });
        },
      );
    });
  } finally {
    release();
  }
}

/** Most cases run in-process (see `runInProcess`); `spawn` runs the real binary. */
export async function mxTscIn(
  cwd: string,
  args: string[],
  options: { spawn?: boolean } = {},
): Promise<Run> {
  if (options.spawn) return mxTscSpawn(cwd, args);
  const { status, stdout, stderr } = runInProcess(args, cwd);
  // Hand the event loop back (vitest's worker RPC) between runs.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { status, stdout, stderr, output: `${stdout}${stderr}` };
}

/** The `.ng.mx` diagnostics (`file(line,col): error TSnnnn`) in `output`, basename only. */
export function templateErrors(output: string): string[] {
  return [
    ...output.matchAll(/([\w.-]+\.ng\.mx)\((\d+),(\d+)\): error (TS\d+)/g),
  ].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}`);
}

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    if (dir.length > 1) rmSync(dir, { recursive: true, force: true });
  }
});

export function scratch(from: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-build-")));
  created.push(dir);
  cpSync(from, dir, { recursive: true });
  symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/**
 * `scratch` links the package's own `node_modules` as one symlink, so
 * installing into it would write into the repo. A private `node_modules` of
 * per-entry links keeps the install inside the scratch dir.
 */
export function privateNodeModules(dir: string) {
  const modules = join(dir, "node_modules");
  rmSync(modules);
  mkdirSync(modules);
  const source = join(packageDir, "node_modules");
  for (const entry of readdirSync(source)) {
    symlinkSync(join(source, entry), join(modules, entry));
  }
}

export type Project = "lib" | "app";
export const template = (dir: string, project: Project) =>
  join(dir, project, "src", `${project}.component.ng.mx`);

export function setBody(file: string, body: string) {
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      /template: .*,\n/,
      `template: ${body},\n`,
    ),
  );
}

export const setTemplate = (dir: string, project: Project, body: string) =>
  setBody(template(dir, project), body);

/** Break the template of every `.ng.mx` under `dir` (not node_modules, not outputs). */
export function breakAll(dir: string): string[] {
  const broken: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "out") visit(full);
      } else if (entry.name.endsWith(".ng.mx")) {
        setBody(full, BROKEN);
        broken.push(full);
      }
    }
  };
  visit(dir);
  return broken;
}

/** The two projects as independent roots: no `references` between them. */
export function unlinkProjects(dir: string) {
  const file = join(dir, "app", "tsconfig.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.references;
  writeFileSync(file, JSON.stringify(config));
}

export const importsOf = (dir: string, body: string) =>
  writeFileSync(join(dir, "src", "main.ts"), body);

/**
 * The oracle: the `.ng.mx` basenames `mx-tsc -p <config> --listFilesOnly` lists
 * for each of `configs` (what tsc compiles for those projects), versus the files
 * the `-b` run reported (every template in the fixture is broken).
 */
export async function expectCheckedSetIsListedSet(
  output: string,
  configs: { cwd: string; config: string }[],
) {
  const listed = new Set<string>();
  for (const { cwd, config } of configs) {
    const out = await mxTscIn(cwd, ["-p", config, "--listFilesOnly"]);
    for (const line of out.stdout.split("\n")) {
      if (line.endsWith(".ng.mx")) listed.add(basename(line));
    }
  }
  expect(listed.size).toBeGreaterThan(0);
  const checked = new Set(templateErrors(output).map((e) => e.split("(")[0]));
  expect(checked).toEqual(listed);
}

export const SPAWN = { spawn: true };
export const APP_ERROR = "app.component.ng.mx(5,18): TS2339";
export const LIB_ERROR = "lib.component.ng.mx(5,18): TS2339";
