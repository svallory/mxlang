import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  CASE_TIMEOUT_MS,
  refsFixture,
  template,
  templateErrors,
} from "./build-uptodate-support.ts";
import { fixtures, here, mxTsc } from "./test-support.ts";
import { MISSED_REBUILD } from "./watch-templates.ts";

/**
 * `mx-tsc -w` re-runs the Angular template pass for every rebuild (TODO
 * `mx-tsc-watch-templates`, `tsc-watch-ngmx-rebuild-test`).
 *
 * The pass used to run once after the initial build and never again, so a
 * `.ng.mx` broken while the watcher runs was never checked: the rebuild that
 * saw the change reported "Found 0 errors", and a template error only a later
 * rebuild introduced looked like a clean one. That is a silent pass, the one
 * failure mode an agent cannot recover from by reading the output.
 *
 * Mirrors `watch-rebuild-diagnostics.test.ts` (the same bounded real-watcher
 * pattern, for the TypeScript pass): a real watcher, polled, with a hard
 * lifetime limit and a kill in `finally`, so a slow machine fails with "watch
 * did not finish a rebuild" rather than hanging the suite. The cases below run
 * one after another — each watcher is killed and reaped before the next starts,
 * and only one runs at a time.
 */
/** How long a rebuild gets. Generous: a slow machine is not a regression. */
const WAIT_MS = 60_000;
/**
 * The hard lifetime of a watcher, below the case budget by more than the 30 s
 * headroom a worst-case run needs, so a stuck watcher is killed and reaped
 * before vitest times the case out.
 */
const LIFETIME_MS = 240_000;
const MESSAGE =
  "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.";
/** The `.ng.mx` as the fixture ships it: a template that reads `user.nmae`. */
const BROKEN = "nmae";

/** A running watcher, its output so far, and how to wait for its next cycle. */
interface Watcher {
  output: () => string;
  /** The output of the next rebuild cycle, or throws when none finishes. */
  untilSummary: (edited?: string) => Promise<string>;
  stop: () => Promise<void>;
}

/**
 * Starts `mx-tsc` watching in `dir` and returns a handle over it. `wait` is
 * what decides that a rebuild finished: the English summary for the pass's own
 * cases, a localized one for the `--locale` case (whose point is that the pass
 * does *not* recognize it).
 */
function watchIn(
  dir: string,
  args: string[],
  wait: (output: string) => boolean,
): Watcher {
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
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  return {
    output: () => output,
    untilSummary: async (edited) => {
      const since = output.length;
      const deadline = Date.now() + WAIT_MS;
      let nextTouch = Date.now() + 2_500;
      while (!wait(output.slice(since))) {
        if (failure) throw failure;
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          Date.now() > deadline
        ) {
          throw new Error(`watch did not finish a rebuild:\n${output}`);
        }
        // The initial summary can precede watcher arming. Retry a newline
        // only until a rebuild starts; never debounce an ongoing compile.
        if (
          edited &&
          Date.now() >= nextTouch &&
          !/File change detected|File_?änderung/i.test(output.slice(since))
        ) {
          appendFileSync(edited, "\n");
          nextTouch = Date.now() + 2_500;
        }
        await delay(100);
      }
      return output.slice(since);
    },
    stop: async () => {
      clearTimeout(lifetime);
      child.kill("SIGKILL");
      await closed;
    },
  };
}

const englishSummary = (output: string) =>
  /Found \d+ errors?\. Watching for file changes\./.test(output);

it(
  "mx-tsc -w re-checks a .ng.mx template on every rebuild, at its exact position, in the summary count",
  async () => {
    // Per run: concurrent runs never share (or delete) each other's project.
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-ngmx-"));
    let watcher: Watcher | undefined;
    try {
      cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
      // `@angular/core` and `@angular/compiler-cli` resolve from the tsc
      // package's own `node_modules` (the checker's resolution rules).
      symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", "x.component.ng.mx");
      const other = join(dir, "src", "other.ts");
      const clean = readFileSync(file, "utf8").replace(
        `user.${BROKEN}`,
        "user.name",
      );
      writeFileSync(file, clean);
      writeFileSync(other, "export const n = 1;\n");

      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"], englishSummary);
      const exact = `src/x.component.ng.mx(5,18): ${MESSAGE}`;
      const expectBroken = (cycle: string) => {
        expect(
          cycle.split("\n").filter((line) => line.includes("error TS")),
        ).toEqual([exact]);
        // The summary counts the template error: a rebuild that finds one says
        // so, instead of reporting a clean one.
        expect(cycle).toContain("Found 1 error. Watching for file changes.");
      };

      // The initial build is clean, and its summary says so.
      expect(await watcher.untilSummary()).not.toContain("error TS");

      // Broken after the watcher started: the rebuild that notices must
      // report it, at its exact position, counted in its own summary.
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      expectBroken(await watcher.untilSummary(file));

      // No-op rebuilds of the erroring file and of another file keep it: the
      // pass re-runs, so a template error cannot go stale on a rebuild that
      // changed nothing about it.
      for (const edited of [file, other, file]) {
        appendFileSync(edited, "\n");
        expectBroken(await watcher.untilSummary(edited));
      }

      // Fixed: it clears, and the summary counts it as gone.
      writeFileSync(file, clean);
      const fixed = await watcher.untilSummary(file);
      expect(fixed).not.toContain("error TS");
      expect(fixed).toContain("Found 0 errors. Watching for file changes.");

      // Broken again: back, at the same position.
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      expectBroken(await watcher.untilSummary(file));
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS,
);

it(
  "mx-tsc -b -w checks every .ng.mx of a referenced project, once each, and re-checks it on every rebuild",
  async () => {
    let watcher: Watcher | undefined;
    const dir = (() => {
      // The two-project fixture (`app` references `lib`), copied where `-b`
      // may write its outputs and the case may edit templates between rebuilds.
      const scratch = mkdtempSync(join(tmpdir(), "mx-tsc-watch-ngmx-b-"));
      cpSync(refsFixture, scratch, { recursive: true });
      symlinkSync(
        join(here, "..", "node_modules"),
        join(scratch, "node_modules"),
      );
      return scratch;
    })();
    try {
      // Two more components in `lib`, broken from the start: a project with
      // more than one `.ng.mx` is where a per-project file list that keeps
      // only one of them shows.
      const extra = (name: string) =>
        `import { Component } from "@angular/core";\n@Component({\n  selector: "app-${name}",\n  template: <p>\${user.nmae}</p>,\n})\nexport class ${name} { user = { name: "a" }; }\n`;
      for (const [file, cls] of [
        ["a.component.ng.mx", "AComponent"],
        ["b.component.ng.mx", "BComponent"],
      ] as const) {
        writeFileSync(join(dir, "lib", "src", file), extra(cls));
      }
      const lib = template(dir, "lib");
      const broken = readFileSync(lib, "utf8").replace(
        "user.name",
        `user.${BROKEN}`,
      );
      writeFileSync(lib, broken);

      // Watch the *referencing* project: the one whose program does not hold
      // `lib`'s templates, so only a pass over the whole graph finds them.
      watcher = watchIn(dir, ["-b", "-w", "app"], englishSummary);
      const initial = await watcher.untilSummary();
      // Every template of the graph, each once, under its own project.
      expect(templateErrors(initial).sort()).toEqual([
        "a.component.ng.mx(4,18): TS2339",
        "b.component.ng.mx(4,18): TS2339",
        "lib.component.ng.mx(5,18): TS2339",
      ]);
      expect(initial).toContain("Found 3 errors. Watching for file changes.");
      // No file is left unowned: a pass that keeps one `.ng.mx` of a project
      // reports the rest as owned by nobody, on every single start.
      expect(initial).not.toContain("no project of the build graph owns it");

      // A rebuild of `lib` re-checks `lib`'s templates, exactly once each.
      const exact = [
        "a.component.ng.mx(4,18): TS2339",
        "b.component.ng.mx(4,18): TS2339",
        "lib.component.ng.mx(5,18): TS2339",
      ].sort();
      appendFileSync(lib, "\n");
      expect(templateErrors(await watcher.untilSummary(lib)).sort()).toEqual(
        exact,
      );
      const other = join(dir, "app", "src", "other.ts");
      writeFileSync(other, "export const n = 1;\n");
      expect(templateErrors(await watcher.untilSummary(other)).sort()).toEqual(
        exact,
      );

      // Fixed: `lib`'s error clears, leaving the two errors that were there
      // from the start, in one summary.
      const clean = broken.replace(`user.${BROKEN}`, "user.name");
      writeFileSync(lib, clean);
      const cleared = await watcher.untilSummary(lib);
      expect(templateErrors(cleared).sort()).toEqual([
        "a.component.ng.mx(4,18): TS2339",
        "b.component.ng.mx(4,18): TS2339",
      ]);
      expect(cleared).toContain("Found 2 errors. Watching for file changes.");

      // Broken again: back, all three.
      writeFileSync(lib, broken);
      expect(templateErrors(await watcher.untilSummary(lib)).sort()).toEqual(
        exact,
      );
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS,
);

it(
  "mx-tsc -w says nothing about missed rebuilds on an English run with ordinary TypeScript errors",
  async () => {
    // Per run: concurrent runs never share (or delete) each other's project.
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-ngmx-ts-error-"));
    let watcher: Watcher | undefined;
    try {
      cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
      symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", "x.component.ng.mx");
      const clean = readFileSync(file, "utf8").replace(
        `user.${BROKEN}`,
        "user.name",
      );
      writeFileSync(file, clean);
      // An ordinary TypeScript error, present from the start: tsc writes it as
      // its own write before the summary of every rebuild, which is what a
      // notice decided on the first non-summary write would mistake for a
      // rebuild whose templates went unchecked.
      const other = join(dir, "src", "other.ts");
      writeFileSync(other, "export const n: string = 1;\n");

      watcher = watchIn(dir, ["-w", "-p", "tsconfig.json"], englishSummary);
      const TS_ERROR = "src/other.ts(1,14): error TS2322";
      const cycles: string[] = [];
      // The initial build has the TypeScript error and a clean template.
      const initial = await watcher.untilSummary();
      expect(initial).toContain(TS_ERROR);
      expect(initial).toContain("Found 1 error. Watching for file changes.");
      cycles.push(initial);

      // Broken template as well: both are reported, and the count carries both.
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      const both = await watcher.untilSummary(file);
      expect(both).toContain(TS_ERROR);
      expect(
        both.split("\n").filter((line) => line.includes("error TS")),
      ).toHaveLength(2);
      expect(both).toContain("Found 2 errors. Watching for file changes.");
      cycles.push(both);

      // Template fixed again: back to the TypeScript error alone.
      writeFileSync(file, clean);
      const fixed = await watcher.untilSummary(file);
      expect(fixed).toContain(TS_ERROR);
      expect(fixed).toContain("Found 1 error. Watching for file changes.");
      cycles.push(fixed);

      // Every one of those rebuilds checked the templates; the notice would be
      // wrong, and worse than noise to an agent reading the output.
      for (const cycle of cycles) expect(cycle).not.toContain(MISSED_REBUILD);
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS,
);

it(
  "mx-tsc -w says so when a localized tsc's rebuild summary is not the one the pass reads",
  async () => {
    // Per run: concurrent runs never share (or delete) each other's project.
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-ngmx-locale-"));
    let watcher: Watcher | undefined;
    try {
      cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
      symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", "x.component.ng.mx");
      const clean = readFileSync(file, "utf8").replace(
        `user.${BROKEN}`,
        "user.name",
      );
      writeFileSync(file, clean);

      // `--locale de` writes "0 Fehler gefunden. Es wird auf Dateiänderungen
      // überwacht.", which the pass does not recognize. It must then say the
      // templates went unchecked: never a rebuild that looks clean.
      watcher = watchIn(
        dir,
        ["-w", "-p", "tsconfig.json", "--locale", "de"],
        (output) => /Fehler gefunden/.test(output),
      );
      // The notice is decided in the tick *after* the rebuild (see
      // `rebuildActivity`), so it is read from the whole output, once the
      // watcher has had that tick.
      const noticeShown = async () => {
        await watcher?.untilSummary();
        await delay(1_000);
        expect(watcher?.output()).toContain(MISSED_REBUILD);
      };
      await noticeShown();

      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`));
      await noticeShown();
    } finally {
      await watcher?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS,
);
