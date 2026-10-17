import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import {
  armDirectoryWatch,
  fixtures,
  here,
  mxTsc,
  repoRoot,
} from "./test-support.ts";

/**
 * `mx-tsc -w` reports MX compile errors (a `.mx` file's parse and lowering
 * errors, which tsc's own diagnostics cannot carry) on every rebuild, counted in
 * tsc's own summary.
 *
 * They used to go out once, after the first build, so an MX error introduced
 * while the watcher ran produced "Found 0 errors" and no MX line at all: the
 * silent pass an agent reading this output takes for a clean project.
 *
 * Real watchers, each polled, killed and reaped in `finally`, with a hard
 * lifetime limit; run one at a time.
 */
const WAIT_MS = 60_000;
const LIFETIME_MS = 240_000;
const CASE_MS = 300_000;

const CLEAN = "<div>\n  <p>ok</p>\n</div>\n";
const EFFECT = "<div>\n  <effect>go()</effect>\n</div>\n";
const UNCLOSED = "<div>\n  <span>\n</div>\n";

/** The first line of the `<effect>` error, as one-shot mode prints it. */
const EFFECT_LINE = (file: string) =>
  `${file}(2,4): error MX_RESERVED_EFFECT_TAG: \`<effect>\` is not an MX tag. Use \`<script>\`: its body runs after render and again when a value it reads changes.`;
const EFFECT_FIX =
  '  fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"';
const UNCLOSED_LINE = (file: string) =>
  `${file}(3,1): error MX_PARSE_MISMATCHED_CLOSING_TAG: `;

const SUMMARY = /Found \d+ errors?\. Watching for file changes\./;

interface Watcher {
  /** The output of the next rebuild cycle (after `edited` is written). */
  untilSummary: (edited?: string) => Promise<string>;
  /** Resolves once the watcher is watching `dir`; see armDirectoryWatch. */
  armed: (dir: string) => Promise<void>;
  stop: () => Promise<void>;
}

function watchIn(dir: string, args: string[]): Watcher {
  const child: ChildProcess = spawn(
    process.execPath,
    [mxTsc, ...args, "--pretty", "false", "--preserveWatchOutput"],
    {
      cwd: dir,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TSC_WATCHFILE: "DynamicPriorityPolling",
        TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const lifetime = setTimeout(() => child.kill("SIGKILL"), LIFETIME_MS);
  let output = "";
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output += chunk;
    });
  }
  return {
    untilSummary: async (edited) => {
      const since = output.length;
      const deadline = Date.now() + WAIT_MS;
      let nextTouch = Date.now() + 2_500;
      while (!SUMMARY.test(output.slice(since))) {
        if (failure) throw failure;
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          Date.now() > deadline
        ) {
          throw new Error(`watch did not finish a rebuild:\n${output}`);
        }
        // The watcher may not be armed yet: re-touch the edited file until a
        // rebuild starts, never during one.
        if (
          edited &&
          Date.now() >= nextTouch &&
          !output.slice(since).includes("File change detected")
        ) {
          appendFileSync(edited, "\n");
          nextTouch = Date.now() + 2_500;
        }
        await delay(100);
      }
      return output.slice(since);
    },
    armed: (dir) =>
      armDirectoryWatch(
        dir,
        () => output,
        () => {
          if (failure) throw failure;
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`watch exited before it was armed:\n${output}`);
          }
        },
      ),
    stop: async () => {
      clearTimeout(lifetime);
      child.kill("SIGKILL");
      await closed;
    },
  };
}

/** An html project: `src/` holds the files, `include` picks them up. */
function htmlProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-mx-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "esnext",
        types: [],
        allowImportingTsExtensions: true,
        paths: {
          "@mxlang/target-html": [
            join(repoRoot, "packages", "targets", "html", "src", "index.ts"),
          ],
        },
      },
      include: ["src"],
    }),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, mx: { host: "html" } }),
  );
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

/** Lines of `cycle` that are diagnostics (carry a position and `error`). */
const errorLines = (cycle: string) =>
  cycle.split("\n").filter((line) => /\): error /.test(line));

/**
 * One cycle that holds exactly the `<effect>` error: printed once, with its
 * fix, before the summary, and counted in it.
 */
function expectEffectOnly(cycle: string, file: string) {
  expect(errorLines(cycle)).toEqual([EFFECT_LINE(file)]);
  expect(occurrences(cycle, EFFECT_LINE(file))).toBe(1);
  expect(cycle).toContain(`${EFFECT_LINE(file)}\n${EFFECT_FIX}\n`);
  expect(cycle.indexOf(EFFECT_LINE(file))).toBeLessThan(cycle.search(SUMMARY));
  expect(cycle).toContain("Found 1 error. Watching for file changes.");
}

it(
  "mx-tsc -w prints an MX error introduced by a rebuild, counts it, and clears it when fixed",
  async () => {
    const dir = htmlProject();
    let watcher: Watcher | undefined;
    try {
      const page = join(dir, "src", "page.mx");
      const other = join(dir, "src", "other.ts");
      writeFileSync(page, CLEAN);
      writeFileSync(other, "export const n = 1;\n");
      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);

      const initial = await watcher.untilSummary();
      expect(errorLines(initial)).toEqual([]);
      expect(initial).toContain("Found 0 errors. Watching for file changes.");

      // Introduced after the first build: the rebuild that sees it reports it.
      writeFileSync(page, EFFECT);
      expectEffectOnly(await watcher.untilSummary(page), "src/page.mx");

      // No-op rebuilds, of the erroring file and of another: still reported,
      // once per cycle, never twice and never dropped.
      for (const edited of [other, page, other]) {
        appendFileSync(edited, "\n");
        expectEffectOnly(await watcher.untilSummary(edited), "src/page.mx");
      }

      // An error of tsc's own beside it: both printed, both in the count.
      writeFileSync(other, 'export const n: number = "x";\n');
      const both = await watcher.untilSummary(other);
      expect(errorLines(both)).toEqual([
        "src/other.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        EFFECT_LINE("src/page.mx"),
      ]);
      expect(both).toContain("Found 2 errors. Watching for file changes.");
      writeFileSync(other, "export const n = 1;\n");
      expectEffectOnly(await watcher.untilSummary(other), "src/page.mx");

      // Fixed: no MX line, and the count says so.
      writeFileSync(page, CLEAN);
      const fixed = await watcher.untilSummary(page);
      expect(errorLines(fixed)).toEqual([]);
      expect(fixed).not.toContain("MX_");
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");

      // A parse error, a different code, at its own position.
      writeFileSync(page, UNCLOSED);
      const unclosed = await watcher.untilSummary(page);
      expect(errorLines(unclosed)).toEqual([UNCLOSED_LINE("src/page.mx")]);
      expect(unclosed).toContain("Found 1 error. Watching for file changes.");

      writeFileSync(page, CLEAN);
      expect(await watcher.untilSummary(page)).toContain(
        "Found 0 errors. Watching for file changes.",
      );
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);

it(
  "mx-tsc -w prints an MX error present at the first build before the summary, counted in it",
  async () => {
    const dir = htmlProject();
    let watcher: Watcher | undefined;
    try {
      const page = join(dir, "src", "page.mx");
      writeFileSync(page, EFFECT);
      writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);

      // The summary is the end of the cycle: nothing follows it that
      // belongs to it, and the MX error is not printed a second time after.
      const initial = await watcher.untilSummary();
      expectEffectOnly(initial, "src/page.mx");
      expect(initial.trimEnd().endsWith("Watching for file changes.")).toBe(
        true,
      );

      writeFileSync(page, CLEAN);
      expect(await watcher.untilSummary(page)).toContain(
        "Found 0 errors. Watching for file changes.",
      );
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);

it(
  "mx-tsc -w keeps an MX error of an unchanged file across a rebuild that adds a file, and does not keep it once fixed",
  async () => {
    const dir = htmlProject();
    let watcher: Watcher | undefined;
    try {
      const broken = join(dir, "src", "broken.mx");
      writeFileSync(broken, EFFECT);
      writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
      expectEffectOnly(await watcher.untilSummary(), "src/broken.mx");
      await watcher.armed(join(dir, "src"));

      // A new root file makes tsc create its program (and the MX language
      // plugins) again; the older file is not read again, and its error stays.
      writeFileSync(join(dir, "src", "added.mx"), CLEAN);
      expectEffectOnly(
        await watcher.untilSummary(join(dir, "src", "added.mx")),
        "src/broken.mx",
      );

      // Fixed after that: the error of the earlier plugins must not outlive it.
      writeFileSync(broken, CLEAN);
      const fixed = await watcher.untilSummary(broken);
      expect(errorLines(fixed)).toEqual([]);
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);

it(
  "mx-tsc -w still reports MX errors after a rebuild that only removed a root file",
  async () => {
    const dir = htmlProject();
    let watcher: Watcher | undefined;
    try {
      const page = join(dir, "src", "page.mx");
      const removed = join(dir, "src", "b.ts");
      writeFileSync(page, CLEAN);
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(removed, "export const b = 2;\n");
      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
      expect(await watcher.untilSummary()).toContain("Found 0 errors.");
      await watcher.armed(join(dir, "src"));

      // The rebuild compiles nothing: only the root set shrinks. tsc may write
      // a TS6053 summary first, then the settled one.
      rmSync(removed);
      let settled = await watcher.untilSummary();
      if (!settled.includes("Found 0 errors.")) {
        settled = await watcher.untilSummary();
      }
      expect(settled).toContain("Found 0 errors. Watching for file changes.");

      writeFileSync(page, EFFECT);
      expectEffectOnly(await watcher.untilSummary(page), "src/page.mx");

      writeFileSync(page, CLEAN);
      const fixed = await watcher.untilSummary(page);
      expect(errorLines(fixed)).toEqual([]);
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);

it(
  "mx-tsc -w reports an MX error introduced into a .ng.mx file by a rebuild",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-mx-ng-"));
    let watcher: Watcher | undefined;
    try {
      cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
      symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", "x.component.ng.mx");
      const clean = readFileSync(file, "utf8").replace(
        "user.nmae",
        "user.name",
      );
      writeFileSync(file, clean);
      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"]);
      expect(await watcher.untilSummary()).toContain(
        "Found 0 errors. Watching for file changes.",
      );

      writeFileSync(file, clean.replace("<p>", "<p><effect>go()</effect>"));
      const broken = await watcher.untilSummary(file);
      expect(errorLines(broken).map((line) => line.split(":")[0])).toEqual([
        expect.stringContaining("src/x.component.ng.mx("),
      ]);
      expect(broken).toContain("error MX_UNSUPPORTED_CONSTRUCT");
      expect(broken).toContain("Found 1 error. Watching for file changes.");

      writeFileSync(file, clean);
      const fixed = await watcher.untilSummary(file);
      expect(fixed).not.toContain("MX_");
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);

it(
  "mx-tsc (one shot) puts an MX count beside tsc's own count line, and fails",
  () => {
    const dir = htmlProject();
    try {
      const page = join(dir, "src", "page.mx");
      const other = join(dir, "src", "other.ts");
      const run = (pretty: "true" | "false") =>
        spawnSync(
          process.execPath,
          [mxTsc, "-p", "tsconfig.json", "--pretty", pretty],
          {
            cwd: dir,
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
          },
        );
      const count = (n: number) =>
        `mx-tsc: Found ${n} MX ${n === 1 ? "error" : "errors"} (tsc's own error count does not include MX errors).\n`;
      const effect = `${EFFECT_LINE("src/page.mx")}\n${EFFECT_FIX}\n`;

      // tsc counts only its own diagnostics and its --pretty count is a
      // per-file table mx-tsc does not rewrite: the MX count follows, and says so.
      writeFileSync(page, EFFECT);
      writeFileSync(other, "export const n: number = 'x';\n");
      const mixed = run("true");
      expect(mixed.status).toBe(1);
      expect(stripVTControlCharacters(mixed.stdout)).toContain(
        "Found 1 error in src/other.ts",
      );
      expect(mixed.stderr).toBe(effect + count(1));

      // Two MX errors: plural.
      writeFileSync(join(dir, "src", "two.mx"), EFFECT);
      const two = run("true");
      expect(two.status).toBe(1);
      expect(two.stderr).toContain(count(2));

      // Without `--pretty` tsc prints no count line, so there is nothing to
      // misread against and no MX count either; the run still fails.
      const plain = run("false");
      expect(plain.status).toBe(1);
      expect(plain.stderr).not.toContain("MX error");
      expect(plain.stderr).toContain(effect);

      // A clean run prints no MX line and exits 0.
      writeFileSync(page, CLEAN);
      writeFileSync(join(dir, "src", "two.mx"), CLEAN);
      rmSync(other);
      const clean = run("true");
      expect(clean.status).toBe(0);
      expect(clean.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_MS,
);
