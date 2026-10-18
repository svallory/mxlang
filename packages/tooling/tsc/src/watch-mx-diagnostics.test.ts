import {
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
import { chdir, cwd } from "node:process";
import { setImmediate as realSetImmediateFromTimers } from "node:timers";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./in-process.ts";
import { fixtures, here, repoRoot } from "./test-support.ts";
import { type MemoryWatch, watchInMemory } from "./watch-memory.ts";

/**
 * `mx-tsc -w` reports MX compile errors (a `.mx` file's parse and lowering
 * errors, which tsc's own diagnostics cannot carry) on every rebuild, counted in
 * tsc's own summary.
 *
 * They used to go out once, after the first build, so an MX error introduced
 * while the watcher ran produced "Found 0 errors" and no MX line at all: the
 * silent pass an agent reading this output takes for a clean project.
 *
 * The watchers run in this process, their rebuilds driven by virtual time
 * (`watch-memory.ts`): tsc's own polling watchers run inside
 * `vi.advanceTimersByTime`, so a cycle is over the moment its summary is
 * written. The tests that share a project share one watcher, in file order.
 */
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

const withNewline = (path: string) => `${readFileSync(path, "utf8")}\n`;

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

describe("mx-tsc -w MX compile diagnostics: one shared project", () => {
  let dir: string;
  let watcher: MemoryWatch;

  beforeAll(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    dir = htmlProject();
    writeFileSync(join(dir, "src", "page.mx"), CLEAN);
    writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], clock);
  });
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mx-tsc -w prints an MX error introduced by a rebuild, counts it, and clears it when fixed", async () => {
    const page = join(dir, "src", "page.mx");
    const other = join(dir, "src", "other.ts");

    const initial = watcher.start();
    expect(errorLines(initial)).toEqual([]);
    expect(initial).toContain("Found 0 errors. Watching for file changes.");

    // Introduced after the first build: the rebuild that sees it reports it.
    expectEffectOnly(
      await watcher.cycle(() => writeFileSync(page, EFFECT)),
      "src/page.mx",
    );

    // No-op rebuilds, of the erroring file and of another: still reported,
    // once per cycle, never twice and never dropped.
    for (const edited of [other, page, other]) {
      expectEffectOnly(
        await watcher.cycle(() => writeFileSync(edited, withNewline(edited))),
        "src/page.mx",
      );
    }

    // An error of tsc's own beside it: both printed, both in the count.
    const both = await watcher.cycle(() =>
      writeFileSync(other, 'export const n: number = "x";\n'),
    );
    expect(errorLines(both)).toEqual([
      "src/other.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      EFFECT_LINE("src/page.mx"),
    ]);
    expect(both).toContain("Found 2 errors. Watching for file changes.");
    expectEffectOnly(
      await watcher.cycle(() => writeFileSync(other, "export const n = 1;\n")),
      "src/page.mx",
    );

    // Fixed: no MX line, and the count says so.
    const fixed = await watcher.cycle(() => writeFileSync(page, CLEAN));
    expect(errorLines(fixed)).toEqual([]);
    expect(fixed).not.toContain("MX_");
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");

    // A parse error, a different code, at its own position.
    const unclosed = await watcher.cycle(() => writeFileSync(page, UNCLOSED));
    expect(errorLines(unclosed)).toEqual([UNCLOSED_LINE("src/page.mx")]);
    expect(unclosed).toContain("Found 1 error. Watching for file changes.");

    expect(await watcher.cycle(() => writeFileSync(page, CLEAN))).toContain(
      "Found 0 errors. Watching for file changes.",
    );
  }, 120_000);

  it("mx-tsc -w keeps an MX error of an unchanged file across a rebuild that adds a file, and does not keep it once fixed", async () => {
    const broken = join(dir, "src", "broken.mx");
    // A second file that holds the error while another is added.
    expectEffectOnly(
      await watcher.cycle(() => writeFileSync(broken, EFFECT)),
      "src/broken.mx",
    );

    // A new root file makes tsc create its program (and the MX language
    // plugins) again; the older file is not read again, and its error stays.
    expectEffectOnly(
      await watcher.cycle(() =>
        writeFileSync(join(dir, "src", "added.mx"), CLEAN),
      ),
      "src/broken.mx",
    );

    // Fixed after that: the error of the earlier plugins must not outlive it.
    const fixed = await watcher.cycle(() => writeFileSync(broken, CLEAN));
    expect(errorLines(fixed)).toEqual([]);
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");
  }, 120_000);

  it("mx-tsc -w still reports MX errors after a rebuild that only removed a root file", async () => {
    const page = join(dir, "src", "page.mx");
    const removed = join(dir, "src", "b.ts");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    expect(
      await watcher.cycle(() =>
        writeFileSync(removed, "export const b = 2;\n"),
      ),
    ).toContain("Found 0 errors.");

    // The rebuild compiles nothing: only the root set shrinks. tsc may write
    // a TS6053 summary first, then the settled one.
    rmSync(removed);
    let settled = await watcher.cycle();
    if (!settled.includes("Found 0 errors.")) {
      settled = await watcher.cycle();
    }
    expect(settled).toContain("Found 0 errors. Watching for file changes.");

    expectEffectOnly(
      await watcher.cycle(() => writeFileSync(page, EFFECT)),
      "src/page.mx",
    );

    const fixed = await watcher.cycle(() => writeFileSync(page, CLEAN));
    expect(errorLines(fixed)).toEqual([]);
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");
  }, 120_000);
});

describe("mx-tsc -w MX compile diagnostics: a first build that already holds the error", () => {
  let dir: string;
  let watcher: MemoryWatch;

  beforeAll(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    dir = htmlProject();
    writeFileSync(join(dir, "src", "page.mx"), EFFECT);
    writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], clock);
  });
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mx-tsc -w prints an MX error present at the first build before the summary, counted in it", async () => {
    const page = join(dir, "src", "page.mx");
    // The summary is the end of the cycle: nothing follows it that
    // belongs to it, and the MX error is not printed a second time after.
    const initial = watcher.start();
    expectEffectOnly(initial, "src/page.mx");
    expect(initial.trimEnd().endsWith("Watching for file changes.")).toBe(true);

    expect(await watcher.cycle(() => writeFileSync(page, CLEAN))).toContain(
      "Found 0 errors. Watching for file changes.",
    );
  }, 120_000);
});

describe("mx-tsc -w MX compile diagnostics: a .ng.mx project", () => {
  let dir: string;
  let watcher: MemoryWatch;

  beforeAll(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-mx-ng-"));
    cpSync(join(fixtures, "ng-diag-failing"), dir, { recursive: true });
    symlinkSync(join(here, "..", "node_modules"), join(dir, "node_modules"));
    const file = join(dir, "src", "x.component.ng.mx");
    const clean = readFileSync(file, "utf8").replace("user.nmae", "user.name");
    writeFileSync(file, clean);
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], clock);
  });
  afterAll(() => {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mx-tsc -w reports an MX error introduced into a .ng.mx file by a rebuild", async () => {
    const file = join(dir, "src", "x.component.ng.mx");
    const clean = readFileSync(file, "utf8");
    expect(watcher.start()).toContain(
      "Found 0 errors. Watching for file changes.",
    );

    const broken = await watcher.cycle(() =>
      writeFileSync(file, clean.replace("<p>", "<p><effect>go()</effect>")),
    );
    expect(errorLines(broken).map((line) => line.split(":")[0])).toEqual([
      expect.stringContaining("src/x.component.ng.mx("),
    ]);
    expect(broken).toContain("error MX_UNSUPPORTED_CONSTRUCT");
    expect(broken).toContain("Found 1 error. Watching for file changes.");

    const fixed = await watcher.cycle(() => writeFileSync(file, clean));
    expect(fixed).not.toContain("MX_");
    expect(fixed).toContain("Found 0 errors. Watching for file changes.");
  }, 120_000);
});

describe("mx-tsc (one shot) puts an MX count beside tsc's own count line", () => {
  it("and fails", () => {
    const dir = htmlProject();
    try {
      const page = join(dir, "src", "page.mx");
      const other = join(dir, "src", "other.ts");
      const before = cwd();
      const run = (pretty: "true" | "false") => {
        const noColor = process.env.NO_COLOR;
        const forceColor = process.env.FORCE_COLOR;
        process.env.NO_COLOR = "1";
        process.env.FORCE_COLOR = "";
        // One-shot paths print relative to the process's working directory.
        chdir(dir);
        try {
          return runInProcess(["-p", "tsconfig.json", "--pretty", pretty], dir);
        } finally {
          chdir(before);
          if (noColor === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = noColor;
          if (forceColor === undefined) delete process.env.FORCE_COLOR;
          else process.env.FORCE_COLOR = forceColor;
        }
      };
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
  }, 120_000);
});
