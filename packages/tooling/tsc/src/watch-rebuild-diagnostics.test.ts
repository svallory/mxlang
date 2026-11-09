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
import { expect, it } from "vitest";
import {
  fixtures,
  mxTsc,
  plainTsc,
  repoRoot,
  spawnWatch,
  WATCH_ARM_MS,
  WATCH_FIRST_SUMMARY_MS,
} from "./test-support.ts";

const WAIT_MS = 30_000;
/** First build + arming (the helper's budgets) + five rebuilds + slack. */
const TIMEOUT_MS = WATCH_FIRST_SUMMARY_MS + WATCH_ARM_MS + 5 * WAIT_MS + 30_000;
const MESSAGE =
  "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
const TS_SOURCE =
  'export function label(count: number): string { return String(count); }\nexport const view = label("not a number");\n';

// These cases run serially: each watcher is killed and reaped before the next
// starts, and has a hard lifetime limit even if an assertion/wait fails.
it.each([
  ["plain tsc", plainTsc, "ts", "Widget.ts(2,27)"],
  ["mx-tsc .ts", mxTsc, "ts", "Widget.ts(2,27)"],
  ["mx-tsc .mx", mxTsc, "mx", "Widget.mx(2,27)"],
  ["mx-tsc .solid.mx", mxTsc, "solid.mx", "Widget.solid.mx(7,32)"],
])(
  "%s retains the exact TS2345 through no-op watch rebuilds",
  async (_name, entry, extension, position) => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-rebuild-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      if (extension === "solid.mx") {
        cpSync(join(fixtures, "failing"), dir, { recursive: true });
      } else {
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
                  join(
                    import.meta.dirname,
                    "..",
                    "..",
                    "..",
                    "targets",
                    "html",
                    "src",
                    "index.ts",
                  ),
                ],
              },
            },
            include: ["src"],
          }),
        );
        writeFileSync(
          join(dir, "src", `Widget.${extension}`),
          extension === "ts"
            ? TS_SOURCE
            : 'static function label(count: number): string { return String(count); }\nstatic const view = label("not a number");\n',
        );
        writeFileSync(join(dir, "src", "index.ts"), "export const text = 2;\n");
      }
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ private: true, mx: { host: "html" } }),
      );
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
      const file = join(dir, "src", `Widget.${extension}`);
      const other = join(dir, "src", "index.ts");
      const run = await spawnWatch({
        cwd: dir,
        entry,
        args: [
          "-w",
          "-p",
          "tsconfig.json",
          "--pretty",
          "false",
          "--preserveWatchOutput",
        ],
        armFile: other,
        lifetimeMs: TIMEOUT_MS - 10_000,
      });
      stop = () => run.stop();
      const untilSummary = async (since: number) => {
        await run.until(
          /Found \d+ errors?\. Watching for file changes\./,
          since,
          WAIT_MS,
        );
        return run.output().slice(since);
      };
      const exact = `src/${position}: ${MESSAGE}`;
      const expectBroken = (cycle: string) => {
        expect(
          cycle.split("\n").filter((line) => line.includes("error TS")),
        ).toEqual([exact]);
        expect(cycle).toContain("Found 1 error.");
      };
      // The first build: cut at its summary.
      const first = run.output();
      const firstEnd = first.indexOf("Watching for file changes.");
      expectBroken(first.slice(0, firstEnd));
      // Arming touched `other`, a different file: a rebuild it caused
      // exercises reuse of the original diagnostics.
      const armed = first
        .slice(firstEnd)
        .split("File change detected")
        .slice(1);
      expect(armed.length).toBeGreaterThan(0);
      // Only the last arming rebuild is asserted: stdout and stderr interleave
      // in arrival order, so an earlier one's split is not exact.
      expectBroken(armed[armed.length - 1] ?? "");
      // Changing the erroring file then exercises recompilation/remapping.
      for (const edited of [file, other, file]) {
        const since = run.output().length;
        appendFileSync(edited, "\n");
        expectBroken(await untilSummary(since));
      }
      const broken = readFileSync(file, "utf8");
      let since = run.output().length;
      writeFileSync(file, broken.replace('"not a number"', "2"));
      const clean = await untilSummary(since);
      expect(clean).toContain("Found 0 errors.");
      expect(clean).not.toContain("error TS");
      since = run.output().length;
      writeFileSync(file, broken);
      expectBroken(await untilSummary(since));
    } finally {
      await stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS,
);
