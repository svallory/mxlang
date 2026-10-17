import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type ts from "typescript";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import {
  armDirectoryWatch,
  mxTsc,
  repoRoot,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";
import {
  packageJsonInputs,
  trackPackageJsonInputs,
} from "./watch-package-json.ts";

/**
 * The `package.json` that decides which host compiles the `.mx` files under it
 * is an input of those files in a watch run. When it changes, they compile
 * again: breaking it is reported on the rebuild that change causes, fixing it
 * clears the `TS80001`/`TS80003` lines on that rebuild, and a `TS80003` points
 * into the new text, not at the place the old text had it.
 *
 * Before, a change to a manifest that was valid started no rebuild at all (the
 * next unrelated rebuild said `Found 0 errors`), and one that started a rebuild
 * (a fix) printed the old host's lines at the new file's positions until the
 * `.mx` file itself was edited.
 *
 * Real watchers, each killed and reaped in `finally`, with a hard lifetime
 * limit. No test touches a `.mx` file to provoke a rebuild: the manifest alone
 * has to.
 */
const WAIT_MS = 45_000;
const LIFETIME_MS = 200_000;
const CASE_MS = 240_000;

const SUMMARY = /Found \d+ errors?\. Watching for file changes\./;

interface Watcher {
  /** What the next rebuild cycle prints, after `act` ran (if given). */
  cycle: (act?: () => void) => Promise<string>;
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
    cycle: async (act) => {
      const since = output.length;
      act?.();
      const deadline = Date.now() + WAIT_MS;
      let nextRetry = Date.now() + 2_500;
      while (!SUMMARY.test(output.slice(since))) {
        if (failure) throw failure;
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          Date.now() > deadline
        ) {
          throw new Error(
            `no rebuild finished within ${WAIT_MS} ms of the change:\n${output.slice(since) || "(nothing printed)"}`,
          );
        }
        // A watcher registered after the first summary records the file's time
        // then, so a change that landed before it is never seen: repeat the
        // change (every act here is a write or a delete of a file that is still
        // there while no rebuild has started) until a rebuild starts.
        if (
          act &&
          Date.now() >= nextRetry &&
          !output.slice(since).includes("File change detected")
        ) {
          try {
            act();
          } catch {
            // A delete that already took effect: nothing left to repeat.
          }
          nextRetry = Date.now() + 2_500;
        }
        await delay(100);
      }
      // The rebuild's whole text: a summary is its last line.
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

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const VALID = pretty({ private: true, mx: { host: "html" } });
const MISMATCH = pretty({
  private: true,
  mx: { host: "solid", target: "react-jsx" },
});
/** The same mismatch, three lines further down. */
const MISMATCH_MOVED = pretty({
  private: true,
  name: "x",
  version: "1.0.0",
  description: "d",
  mx: { host: "solid", target: "react-jsx" },
});
const BROKEN_JSON = '{ "private": true, ';

const MISMATCH_AT = (line: number) =>
  `package.json(${line},15): error TS80003: mx.target "react-jsx" belongs to host "react", but mx.host is "solid".`;
const POINTER = "src/page.mx(1,1): error TS80001: target not resolved: see ";

/**
 * A one-page project whose `package.json` is `packageJson`, in a `project`
 * directory of a temporary one (remove `dirname` of the result). TypeScript
 * watches a `package.json` that is an affecting location of a file only when
 * the path is deeper than the OS-root-like prefix it assumes: `/tmp/x/package.json`
 * is not watched, `/tmp/x/project/package.json` is.
 */
function project(packageJson: string): string {
  const dir = join(
    mkdtempSync(join(tmpdir(), "mx-tsc-watch-pkgjson-")),
    "project",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        jsx: "preserve",
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
  writeFileSync(join(dir, "package.json"), packageJson);
  writeFileSync(join(dir, "src", "page.mx"), "<p>ok</p>\n");
  writeFileSync(join(dir, "src", "other.ts"), "export const n = 1;\n");
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const policyLines = (cycle: string) =>
  cycle.split("\n").filter((line) => /TS80003/.test(line));
const count = (cycle: string) =>
  Number(/Found (\d+) errors?\./.exec(cycle)?.[1]);

const MODES: ReadonlyArray<readonly [string, string[]]> = [
  ["-w -p", ["-w", "-p", "tsconfig.json"]],
  ["-b -w", ["-b", "-w", "tsconfig.json"]],
];

describe.each(MODES)(
  "mx-tsc %s: the manifest that decides the host",
  (_mode, args) => {
    it(
      "reports a break on the rebuild it causes, points into the new text, and clears on the fix",
      async () => {
        const dir = project(VALID);
        let watcher: Watcher | undefined;
        try {
          const manifest = join(dir, "package.json");
          watcher = watchIn(dir, args);
          expect(await watcher.cycle()).toContain("Found 0 errors.");
          await watcher.armed(join(dir, "src"));

          // Broken: no `.mx` file is touched, the manifest alone rebuilds.
          const broken = await watcher.cycle(() =>
            writeFileSync(manifest, MISMATCH),
          );
          expect(broken).toContain(POINTER);
          expect(policyLines(broken)).toEqual([
            expect.stringContaining(MISMATCH_AT(5)),
          ]);
          expect(count(broken)).toBe(2);

          // Edited so the same error sits three lines lower: the line follows.
          const moved = await watcher.cycle(() =>
            writeFileSync(manifest, MISMATCH_MOVED),
          );
          expect(policyLines(moved)).toEqual([
            expect.stringContaining(MISMATCH_AT(8)),
          ]);
          expect(moved).not.toContain("package.json(5,");
          expect(count(moved)).toBe(2);

          // Fixed: both lines are gone on the rebuild the fix causes.
          const fixed = await watcher.cycle(() =>
            writeFileSync(manifest, VALID),
          );
          expect(policyLines(fixed)).toEqual([]);
          expect(fixed).not.toContain("TS80001");
          expect(fixed).toContain("Found 0 errors. Watching for file changes.");
        } finally {
          await watcher?.stop();
          rmSync(dirname(dir), { recursive: true, force: true });
        }
      },
      CASE_MS,
    );
  },
);

describe("mx-tsc -w: more manifest changes", () => {
  const args = ["-w", "-p", "tsconfig.json"];
  it(
    "reports a manifest that stops parsing, and stops once it parses again",
    async () => {
      const dir = project(VALID);
      let watcher: Watcher | undefined;
      try {
        const manifest = join(dir, "package.json");
        watcher = watchIn(dir, args);
        expect(await watcher.cycle()).toContain("Found 0 errors.");
        await watcher.armed(join(dir, "src"));

        const broken = await watcher.cycle(() =>
          writeFileSync(manifest, BROKEN_JSON),
        );
        expect(policyLines(broken)).toEqual([
          expect.stringContaining(
            "package.json(1,20): warning TS80003: could not be parsed as JSON",
          ),
        ]);

        const fixed = await watcher.cycle(() => writeFileSync(manifest, VALID));
        expect(policyLines(fixed)).toEqual([]);
        expect(fixed).toContain("Found 0 errors. Watching for file changes.");
      } finally {
        await watcher?.stop();
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
    CASE_MS,
  );

  it(
    "reports a manifest created nearer to a file than the one that decided it",
    async () => {
      const dir = project(VALID);
      let watcher: Watcher | undefined;
      try {
        const sub = join(dir, "src", "sub");
        mkdirSync(sub);
        writeFileSync(join(sub, "x.mx"), "<p>ok</p>\n");
        watcher = watchIn(dir, args);
        expect(await watcher.cycle()).toContain("Found 0 errors.");
        await watcher.armed(join(dir, "src"));

        const created = await watcher.cycle(() =>
          writeFileSync(join(sub, "package.json"), MISMATCH),
        );
        expect(policyLines(created)).toEqual([
          expect.stringContaining("src/sub/package.json(5,15): error TS80003"),
        ]);
        expect(count(created)).toBe(2);
      } finally {
        await watcher?.stop();
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
    CASE_MS,
  );

  it(
    "prints the same diagnostics after a rewrite that changes nothing, and none where there were none",
    async () => {
      for (const [packageJson, errors] of [
        [MISMATCH, 2],
        [VALID, 0],
      ] as const) {
        const dir = project(packageJson);
        let watcher: Watcher | undefined;
        try {
          const manifest = join(dir, "package.json");
          watcher = watchIn(dir, args);
          const first = await watcher.cycle();
          await watcher.armed(join(dir, "src"));
          expect(count(first)).toBe(errors);

          const again = await watcher.cycle(() => {
            // Same bytes, a newer modification time.
            writeFileSync(manifest, packageJson);
            const later = new Date(Date.now() + 5_000);
            utimesSync(manifest, later, later);
          });
          expect(count(again)).toBe(errors);
          expect(policyLines(again)).toEqual(policyLines(first));
          expect(again.match(/error TS\d+/g) ?? []).toEqual(
            first.match(/error TS\d+/g) ?? [],
          );
        } finally {
          await watcher?.stop();
          rmSync(dirname(dir), { recursive: true, force: true });
        }
      }
    },
    CASE_MS,
  );
});

// Each -b build cycle swaps the compiler host's getSourceFile; the watch has to survive that.
// (-w -p never swaps it, and these sequences take a minute each, so only -b -w runs them.)
describe("mx-tsc -b -w: the manifest watch across build cycles", () => {
  const args = ["-b", "-w", "tsconfig.json"];
  it(
    "keeps watching the manifest after source files were added",
    async () => {
      const dir = project(VALID);
      let watcher: Watcher | undefined;
      try {
        const manifest = join(dir, "package.json");
        watcher = watchIn(dir, args);
        expect(await watcher.cycle()).toContain("Found 0 errors.");
        await watcher.armed(join(dir, "src"));

        // Each new file changes the root names, and the program is made anew.
        for (const name of ["a.ts", "b.ts"]) {
          const added = await watcher.cycle(() =>
            writeFileSync(join(dir, "src", name), "export const x = 1;\n"),
          );
          expect(added).toContain("Found 0 errors.");
        }

        const broken = await watcher.cycle(() =>
          writeFileSync(manifest, MISMATCH),
        );
        expect(policyLines(broken)).toEqual([
          expect.stringContaining(MISMATCH_AT(5)),
        ]);
        expect(count(broken)).toBe(2);

        const fixed = await watcher.cycle(() => writeFileSync(manifest, VALID));
        expect(policyLines(fixed)).toEqual([]);
        expect(fixed).toContain("Found 0 errors. Watching for file changes.");
      } finally {
        await watcher?.stop();
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
    CASE_MS,
  );

  it(
    "keeps watching the manifest after a nearer one was created and deleted, and after the project's own was deleted",
    async () => {
      const dir = project(VALID);
      let watcher: Watcher | undefined;
      try {
        const manifest = join(dir, "package.json");
        const sub = join(dir, "src", "sub");
        mkdirSync(sub);
        writeFileSync(join(sub, "x.mx"), "<p>ok</p>\n");
        watcher = watchIn(dir, args);
        expect(await watcher.cycle()).toContain("Found 0 errors.");
        await watcher.armed(join(dir, "src"));

        const created = await watcher.cycle(() =>
          writeFileSync(join(sub, "package.json"), MISMATCH),
        );
        expect(policyLines(created)).toEqual([
          expect.stringContaining("src/sub/package.json(5,15): error TS80003"),
        ]);

        const deleted = await watcher.cycle(() =>
          rmSync(join(sub, "package.json")),
        );
        expect(policyLines(deleted)).toEqual([]);
        expect(deleted).toContain("Found 0 errors.");

        // The project's own manifest still decides `src/page.mx`.
        const broken = await watcher.cycle(() =>
          writeFileSync(manifest, MISMATCH),
        );
        expect(policyLines(broken)).toEqual([
          expect.stringContaining(MISMATCH_AT(5)),
        ]);

        const removed = await watcher.cycle(() => rmSync(manifest));
        expect(policyLines(removed)).toEqual([]);
        expect(removed).toContain("Found 0 errors.");

        const back = await watcher.cycle(() =>
          writeFileSync(manifest, MISMATCH),
        );
        expect(policyLines(back)).toEqual([
          expect.stringContaining(MISMATCH_AT(5)),
        ]);

        const fixed = await watcher.cycle(() => writeFileSync(manifest, VALID));
        expect(policyLines(fixed)).toEqual([]);
        expect(fixed).toContain("Found 0 errors. Watching for file changes.");
      } finally {
        await watcher?.stop();
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
    CASE_MS,
  );
});

describe("mx-tsc one-shot --pretty: the MX error count", () => {
  /** A tsc error in `other.ts` makes tsc print its own count line, so the MX one is printed beside it. */
  function run(packageJson: string): string {
    const dir = project(packageJson);
    try {
      writeFileSync(
        join(dir, "src", "other.ts"),
        'export const n: number = "x";\n',
      );
      const result = runInProcess(
        ["--noEmit", "--pretty", "-p", "tsconfig.json"],
        dir,
      );
      return stripVTControlCharacters(result.stdout + result.stderr);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  }

  it(
    "counts a host-policy error (TS80003) with the compile errors",
    () => {
      const text = run(MISMATCH);
      expect(text).toContain("error TS80003");
      // The pointer (TS80001) and the policy error.
      expect(text).toContain(
        "mx-tsc: Found 2 MX errors (tsc's own error count does not include MX errors).",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "counts a host-policy error that has no pointer",
    () => {
      const text = run(
        pretty({
          private: true,
          mx: { host: "html", html: { defaultTag: "input" } },
        }),
      );
      expect(text).toContain("error TS80003");
      expect(text).toContain(
        "mx-tsc: Found 1 MX error (tsc's own error count does not include MX errors).",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "does not count a host-policy warning",
    () => {
      const text = run(pretty({ private: true, mx: { host: "vue" } }));
      expect(text).toContain("warning TS80003");
      expect(text).not.toContain("mx-tsc: Found");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("packageJsonInputs", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("lists each directory's manifest up to the second one that exists", () => {
    expect(
      packageJsonInputs(
        "/w/app/src/sub/x.mx",
        present(
          "/w/app/src/package.json",
          "/w/app/package.json",
          "/w/package.json",
        ),
      ),
    ).toEqual([
      "/w/app/src/sub/package.json",
      "/w/app/src/package.json",
      "/w/app/package.json",
    ]);
  });

  it("lists the manifests that do not exist yet, so creating one is noticed", () => {
    expect(
      packageJsonInputs("/w/app/src/x.mx", present("/w/app/package.json")),
    ).toEqual([
      "/w/app/src/package.json",
      "/w/app/package.json",
      "/w/package.json",
      "/package.json",
    ]);
  });

  it("stops at the filesystem root when no manifest exists", () => {
    expect(packageJsonInputs("/a/x.mx", present())).toEqual([
      "/a/package.json",
      "/package.json",
    ]);
  });
});

describe("trackPackageJsonInputs", () => {
  /** A host whose source files are fresh objects of `text` per read, like TypeScript's cache would not be. */
  function fakeHost() {
    const sources = new Map<string, { text: string; version: string }>();
    const options: Array<{ packageJsonLocations?: string[] }> = [];
    const host = {
      getSourceFile: (
        fileName: string,
        languageVersionOrOptions: unknown,
      ): unknown => {
        if (typeof languageVersionOrOptions === "object") {
          options.push(languageVersionOrOptions as never);
        }
        return sources.get(fileName);
      },
    };
    return { host, sources, options };
  }

  const typescript = {
    createSourceFile: (fileName: string, text: string) => ({
      fileName,
      text,
      version: "new",
    }),
  } as unknown as typeof ts;

  it("adds the manifests to the file's affecting locations and re-hands a file only when one changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-pkgjson-unit-"));
    try {
      const manifest = join(dir, "package.json");
      writeFileSync(manifest, VALID);
      const page = join(dir, "page.mx");
      const { host, sources, options } = fakeHost();
      sources.set(page, { text: "<p>ok</p>\n", version: "v1" });
      sources.set(join(dir, "a.ts"), { text: "export {}", version: "v1" });
      trackPackageJsonInputs(typescript, host as never, [".mx"]);
      // Idempotent: a second call does not wrap the wrapper.
      const wrapped = host.getSourceFile;
      trackPackageJsonInputs(typescript, host as never, [".mx"]);
      expect(host.getSourceFile).toBe(wrapped);

      const get = (name: string, option = {}) =>
        host.getSourceFile(name, option);
      const first = get(page);
      expect(first).toBe(sources.get(page));
      expect(options.at(-1)?.packageJsonLocations).toContain(
        manifest.replaceAll("\\", "/"),
      );
      // Unchanged manifest: the very same object.
      expect(get(page)).toBe(first);
      // Not an MX file: untouched, no locations added.
      get(join(dir, "a.ts"));
      expect(options.at(-1)?.packageJsonLocations).toBeUndefined();

      // The manifest changes: same text, a new object and a new version.
      writeFileSync(manifest, MISMATCH);
      const later = new Date(Date.now() + 5_000);
      utimesSync(manifest, later, later);
      const second = get(page) as { text: string; version: string };
      expect(second).not.toBe(first);
      expect(second.text).toBe("<p>ok</p>\n");
      expect(second.version).toContain("package.json");
      // ...and stays that object until the manifest changes again.
      expect(get(page)).toBe(second);

      // The file's own edit (a new source object) is handed out as it is.
      const edited = { text: "<p>edited</p>\n", version: "v2" };
      sources.set(page, edited);
      expect(get(page)).toBe(edited);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps a getSourceFile assigned later, as each -b build cycle does, and never wraps its own twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-pkgjson-unit-"));
    try {
      const manifest = join(dir, "package.json");
      writeFileSync(manifest, VALID);
      const page = join(dir, "page.mx");
      const { host, sources, options } = fakeHost();
      sources.set(page, { text: "<p>ok</p>\n", version: "v1" });
      const original = host.getSourceFile;
      trackPackageJsonInputs(typescript, host as never, [".mx"]);
      const mine = host.getSourceFile;

      // The builder swaps in its caching function, then puts the original back.
      host.getSourceFile = (name, option) => original(name, option);
      options.length = 0;
      host.getSourceFile(page, {});
      expect(options.at(-1)?.packageJsonLocations).toContain(
        manifest.replaceAll("\\", "/"),
      );
      host.getSourceFile = original;
      options.length = 0;
      host.getSourceFile(page, {});
      expect(options.at(-1)?.packageJsonLocations).toContain(
        manifest.replaceAll("\\", "/"),
      );

      // Handing our own function back is not wrapped again.
      host.getSourceFile = mine;
      expect(host.getSourceFile).toBe(mine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does the manifest work once per call however many pass-through layers are assigned over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-pkgjson-unit-"));
    try {
      writeFileSync(join(dir, "package.json"), VALID);
      const page = join(dir, "page.mx");
      const { host, sources } = fakeHost();
      sources.set(page, { text: "<p>ok</p>\n", version: "v1" });
      trackPackageJsonInputs(typescript, host as never, [".mx"]);

      // Each root-file change under -w -p assigns a pass-through over the current function.
      for (let i = 0; i < 4; i++) {
        const previous = host.getSourceFile;
        host.getSourceFile = (name, option) => previous(name, option);
      }

      let writes = 0;
      let locations: string[] | undefined;
      const option = {};
      Object.defineProperty(option, "packageJsonLocations", {
        get: () => locations,
        set: (next: string[]) => {
          writes++;
          locations = next;
        },
      });
      host.getSourceFile(page, option);
      expect(writes).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
