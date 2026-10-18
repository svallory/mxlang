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
import { setImmediate as realSetImmediateFromTimers } from "node:timers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  refsFixture,
  template,
  templateErrors,
} from "./build-uptodate-support.ts";
import { fixtures, here } from "./test-support.ts";
import { type MemoryWatch, watchInMemory } from "./watch-memory.ts";
import { MISSED_REBUILD } from "./watch-templates.ts";

/**
 * `mx-tsc -w` re-runs the Angular template pass for every rebuild (TODO
 * `mx-tsc-watch-templates`, `tsc-watch-ngmx-rebuild-test`).
 *
 * The pass used to run once after the initial build and never again, so a
 * `.ng.mx` broken while the watcher runs was never checked: the rebuild that
 * saw the change reported "Found 0 errors", and a template error only a later
 * rebuild introduced looked like a clean one. That is a silent pass, the one
 * failure mode an agent reading this output cannot recover from.
 *
 * The watchers run in this process, their rebuilds driven by virtual time
 * (`watch-memory.ts`): a cycle is over the moment its summary (English or
 * localized, whichever the case reads) is written, deterministically. The two
 * English `-w` cases share one watcher, in file order.
 */
/** The `.ng.mx` as the fixture ships it: a template that reads `user.nmae`. */
const BROKEN = "nmae";

const MESSAGE =
  "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.";

const englishSummary = (output: string) =>
  /Found \d+ errors?\. Watching for file changes\./.test(output);
const germanSummary = (output: string) => /Fehler gefunden/.test(output);

/**
 * The clock the watcher's polls, debounces and build turns run on. Each step
 * hands the event loop a real macrotask (`scripts/vitest-yield.ts`'s medicine,
 * here instead of a config the tests do not own): a synchronous advance would
 * block the worker for a whole test and, on a loaded machine, delay vitest's
 * own RPC past its fixed timeout.
 */
const realSetImmediate = realSetImmediateFromTimers;
const clock = {
  advance: (ms: number) => {
    vi.advanceTimersByTime(ms);
    return new Promise<void>((resolve) => realSetImmediate(resolve));
  },
  clear: () => vi.clearAllTimers(),
};

const FAKE_TIMERS: {
  toFake: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"];
} = {
  toFake: [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
  ],
};

/** A throwaway copy of a fixture, with the package's `node_modules` linked. */
function scratchFixture(name: string, fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  cpSync(fixture, dir, { recursive: true });
  symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
  return dir;
}

/**
 * Whether every rebuild so far got exactly one notice: as many notices as
 * localized summaries. Counted against the summaries, not a fixed number.
 */
function oneNoticePerRebuild(output: string): void {
  const rebuilds = output.split("Fehler gefunden").length - 1;
  expect(rebuilds).toBeGreaterThan(0);
  expect(output.split(MISSED_REBUILD).length - 1).toBe(rebuilds);
}

describe("mx-tsc -w: the Angular template pass on every rebuild", () => {
  let dir: string;
  let watcher: MemoryWatch;

  beforeAll(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    dir = scratchFixture(
      "mx-tsc-watch-ngmx-",
      join(fixtures, "ng-diag-failing"),
    );
    const file = join(dir, "src", "x.component.ng.mx");
    const clean = readFileSync(file, "utf8").replace(
      `user.${BROKEN}`,
      "user.name",
    );
    writeFileSync(file, clean);
    writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
    watcher = watchInMemory(
      dir,
      ["-w", "-p", "tsconfig.json"],
      clock,
      englishSummary,
    );
  });
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mx-tsc -w re-checks a .ng.mx template on every rebuild, at its exact position, in the summary count", async () => {
    const file = join(dir, "src", "x.component.ng.mx");
    const other = join(dir, "src", "other.ts");
    const clean = readFileSync(file, "utf8");
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
    expect(watcher.start()).not.toContain("error TS");

    // Broken after the watcher started: the rebuild that notices must
    // report it, at its exact position, counted in its own summary.
    expectBroken(
      await watcher.cycle(() =>
        writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`)),
      ),
    );

    // No-op rebuilds of the erroring file and of another file keep it: the
    // pass re-runs, so a template error cannot go stale on a rebuild that
    // changed nothing about it.
    for (const edited of [file, other, file]) {
      expectBroken(await watcher.cycle(() => appendFileSync(edited, "\n")));
    }

    // Fixed: it clears, and the summary counts it as gone.
    const fixed = await watcher.cycle(() => writeFileSync(file, clean));
    expect(fixed).not.toContain("error TS");
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");

    // Broken again: back, at the same position.
    expectBroken(
      await watcher.cycle(() =>
        writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`)),
      ),
    );

    // Every rebuild above ran the pass, so none was missed.
    await clock.advance(1_000);
    expect(watcher.output()).not.toContain(MISSED_REBUILD);

    // Leave the template clean for the next case on this watcher.
    await watcher.cycle(() => writeFileSync(file, clean));
  }, 120_000);

  it("mx-tsc -w says nothing about missed rebuilds on an English run with ordinary TypeScript errors", async () => {
    const file = join(dir, "src", "x.component.ng.mx");
    const clean = readFileSync(file, "utf8");
    // An ordinary TypeScript error, present from the start: tsc writes it as
    // its own write before the summary of every rebuild, which is what a
    // notice decided on the first non-summary write would mistake for a
    // rebuild whose templates went unchecked.
    const other = join(dir, "src", "other.ts");
    const cycles: string[] = [];
    // The build with the TypeScript error and a clean template.
    const initial = await watcher.cycle(() =>
      writeFileSync(other, "export const n: string = 1;\n"),
    );
    const TS_ERROR = "src/other.ts(1,14): error TS2322";
    expect(initial).toContain(TS_ERROR);
    expect(initial).toContain("Found 1 error. Watching for file changes.");
    cycles.push(initial);

    // Broken template as well: both are reported, and the count carries both.
    const both = await watcher.cycle(() =>
      writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`)),
    );
    expect(both).toContain(TS_ERROR);
    expect(
      both.split("\n").filter((line) => line.includes("error TS")),
    ).toHaveLength(2);
    expect(both).toContain("Found 2 errors. Watching for file changes.");
    cycles.push(both);

    // Template fixed again: back to the TypeScript error alone.
    const fixed = await watcher.cycle(() => writeFileSync(file, clean));
    expect(fixed).toContain(TS_ERROR);
    expect(fixed).toContain("Found 1 error. Watching for file changes.");
    cycles.push(fixed);

    // Every one of those rebuilds checked the templates; the notice would be
    // wrong, and worse than noise to an agent reading the output.
    for (const cycle of cycles) expect(cycle).not.toContain(MISSED_REBUILD);
  }, 120_000);
});

describe("mx-tsc -b -w: the Angular template pass across projects", () => {
  it("mx-tsc -b -w checks every .ng.mx of a referenced project, once each, and re-checks it on every rebuild", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    // The two-project fixture (`app` references `lib`), copied where `-b`
    // may write its outputs and the case may edit templates between rebuilds.
    const dir = scratchFixture("mx-tsc-watch-ngmx-b-", refsFixture);
    let watcher: MemoryWatch | undefined;
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
      watcher = watchInMemory(dir, ["-b", "-w", "app"], clock, englishSummary);
      const initial = watcher.start();
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
      expect(
        templateErrors(
          await watcher.cycle(() => appendFileSync(lib, "\n")),
        ).sort(),
      ).toEqual(exact);
      const other = join(dir, "app", "src", "other.ts");
      expect(
        templateErrors(
          await watcher.cycle(() =>
            writeFileSync(other, "export const n = 1;\n"),
          ),
        ).sort(),
      ).toEqual(exact);

      // Fixed: `lib`'s error clears, leaving the two errors that were there
      // from the start, in one summary.
      const clean = broken.replace(`user.${BROKEN}`, "user.name");
      const cleared = await watcher.cycle(() => writeFileSync(lib, clean));
      expect(templateErrors(cleared).sort()).toEqual([
        "a.component.ng.mx(4,18): TS2339",
        "b.component.ng.mx(4,18): TS2339",
      ]);
      expect(cleared).toContain("Found 2 errors. Watching for file changes.");

      // Broken again: back, all three.
      expect(
        templateErrors(
          await watcher.cycle(() => writeFileSync(lib, broken)),
        ).sort(),
      ).toEqual(exact);
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("mx-tsc -b -w says so on every rebuild of one project when a localized tsc's summary is not the one the pass reads", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const dir = scratchFixture("mx-tsc-watch-ngmx-b-locale-", refsFixture);
    let watcher: MemoryWatch | undefined;
    try {
      const lib = template(dir, "lib");
      // The same project is rebuilt each time: tsc restores the compiler host
      // after a build, so a hook on the host sees only the first build.
      watcher = watchInMemory(
        dir,
        ["-b", "-w", "lib", "--locale", "de"],
        clock,
        germanSummary,
      );
      const noticeCount = async (act?: () => void) => {
        await watcher?.cycle(act);
        // The notice is decided when the last build turn returns; give it
        // its tick, deterministically.
        await clock.advance(1_000);
        oneNoticePerRebuild(watcher?.output() ?? "");
      };
      watcher.start();
      await clock.advance(1_000);
      oneNoticePerRebuild(watcher.output());
      for (let edit = 0; edit < 2; edit += 1) {
        await noticeCount(() => appendFileSync(lib, "\n"));
      }
      // Each edit started a rebuild of its own: initial build plus two.
      expect(
        watcher.output().split("Fehler gefunden").length - 1,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("mx-tsc -b -w does not report a missed rebuild when one change rebuilds two projects", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    // Two independent projects that both include `shared/`: one edit there
    // invalidates both, and tsc's solution builder builds them on separate
    // event-loop turns (the second on a 100 ms timer) before the one summary.
    const dir = scratchFixture("mx-tsc-watch-ngmx-b-shared-", refsFixture);
    let watcher: MemoryWatch | undefined;
    try {
      const component = readFileSync(template(dir, "lib"), "utf8");
      mkdirSync(join(dir, "shared"));
      writeFileSync(join(dir, "shared", "s.ts"), "export const s = 0;\n");
      writeFileSync(join(dir, "shared", "c.component.ng.mx"), component);
      const config = readFileSync(join(dir, "lib", "tsconfig.json"), "utf8")
        .replace('"composite": true,', '"composite": true, "rootDir": "..",')
        .replace('"include": ["src"]', '"include": ["src", "../shared"]');
      // The Angular host is chosen by a `package.json` above each file.
      const manifest = readFileSync(join(dir, "lib", "package.json"), "utf8");
      writeFileSync(join(dir, "shared", "package.json"), manifest);
      for (const project of ["p1", "p2"]) {
        mkdirSync(join(dir, project));
        writeFileSync(join(dir, project, "tsconfig.json"), config);
        writeFileSync(join(dir, project, "package.json"), manifest);
      }
      const shared = join(dir, "shared", "s.ts");
      const sharedTemplate = join(dir, "shared", "c.component.ng.mx");

      watcher = watchInMemory(
        dir,
        ["-b", "-w", "p1", "p2"],
        clock,
        englishSummary,
      );
      const cycles = [watcher.start()];
      for (const edited of [shared, sharedTemplate, shared]) {
        cycles.push(await watcher.cycle(() => appendFileSync(edited, "\n")));
      }
      // Give a late notice time to land: it is written on a timer.
      await clock.advance(1_000);
      // Every rebuild ended in a recognized summary, so the pass ran in each
      // of them: a notice that it missed one is false, and an agent reading
      // it would distrust a clean result.
      for (const cycle of cycles) {
        expect(cycle).toContain("Found 0 errors. Watching for file changes.");
      }
      expect(watcher.output()).not.toContain(MISSED_REBUILD);
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("mx-tsc -w: a localized tsc's summary is not recognized", () => {
  it("mx-tsc -w says so when a localized tsc's rebuild summary is not the one the pass reads", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const dir = scratchFixture(
      "mx-tsc-watch-ngmx-locale-",
      join(fixtures, "ng-diag-failing"),
    );
    let watcher: MemoryWatch | undefined;
    try {
      const file = join(dir, "src", "x.component.ng.mx");
      const clean = readFileSync(file, "utf8").replace(
        `user.${BROKEN}`,
        "user.name",
      );
      writeFileSync(file, clean);

      // `--locale de` writes "0 Fehler gefunden. Es wird auf Dateiänderungen
      // überwacht.", which the pass does not recognize. It must then say the
      // templates went unchecked: never a rebuild that looks clean.
      watcher = watchInMemory(
        dir,
        ["-w", "-p", "tsconfig.json", "--locale", "de"],
        clock,
        germanSummary,
      );
      // The notice is decided in the tick *after* the rebuild (see
      // `rebuildActivity`), so it is read from the whole output, once the
      // watcher has had that tick. One notice per rebuild: counted, so the
      // second rebuild cannot pass on the first one's.
      const noticeShown = async (act?: () => void) => {
        await watcher?.cycle(act);
        await clock.advance(1_000);
        oneNoticePerRebuild(watcher?.output() ?? "");
      };
      watcher.start();
      await clock.advance(1_000);
      oneNoticePerRebuild(watcher.output());

      await noticeShown(() =>
        writeFileSync(file, clean.replace("user.name", `user.${BROKEN}`)),
      );
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
