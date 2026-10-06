import { spawn } from "node:child_process";
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
import { expect, it } from "vitest";
import { fixtures, mxTsc, plainTsc, repoRoot } from "./test-support.ts";

const WAIT_MS = 30_000;
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
                "@mxlang/html": [
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
      const child = spawn(
        process.execPath,
        [
          entry,
          "-w",
          "-p",
          "tsconfig.json",
          "--pretty",
          "false",
          "--preserveWatchOutput",
        ],
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
      const lifetime = setTimeout(() => child.kill("SIGKILL"), 90_000);
      stop = async () => {
        clearTimeout(lifetime);
        child.kill("SIGKILL");
        await closed;
      };
      let output = "";
      let failure: Error | undefined;
      child.on("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const untilSummary = async (since: number, edited?: string) => {
        const deadline = Date.now() + WAIT_MS;
        let nextTouch = Date.now() + 2_500;
        while (
          !/Found \d+ errors?\. Watching for file changes\./.test(
            output.slice(since),
          )
        ) {
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
            !output.slice(since).includes("File change detected")
          ) {
            appendFileSync(edited, "\n");
            nextTouch = Date.now() + 2_500;
          }
          await delay(100);
        }
        return output.slice(since);
      };
      const exact = `src/${position}: ${MESSAGE}`;
      const expectBroken = (cycle: string) => {
        expect(
          cycle.split("\n").filter((line) => line.includes("error TS")),
        ).toEqual([exact]);
        expect(cycle).toContain("Found 1 error.");
      };
      expectBroken(await untilSummary(0));
      // A different file first exercises reuse of the original diagnostics;
      // changing the erroring file then exercises recompilation/remapping.
      for (const edited of [other, file, other, file]) {
        const since = output.length;
        appendFileSync(edited, "\n");
        expectBroken(await untilSummary(since, edited));
      }
      const broken = readFileSync(file, "utf8");
      let since = output.length;
      writeFileSync(file, broken.replace('"not a number"', "2"));
      const clean = await untilSummary(since, file);
      expect(clean).toContain("Found 0 errors.");
      expect(clean).not.toContain("error TS");
      since = output.length;
      writeFileSync(file, broken);
      expectBroken(await untilSummary(since, file));
    } finally {
      await stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  90_000,
);
