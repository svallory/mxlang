import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSpawnSyncLoaderForTesting } from "./resolve-after-miss.ts";
import {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
} from "./target-loader.ts";

// A resolution miss must not stick: the runtime's resolver keeps a miss once
// the project has a node_modules, so after a miss the loader asks the same
// runtime again in a child process. Each case runs in a fresh Bun and a fresh Node process, because the
// miss is process state: miss, install, load.

const here = import.meta.dirname;
const loader = join(here, "target-loader.ts");
const fixtures = join(
  here,
  "..",
  "..",
  "..",
  "test-fixtures",
  "third-party-targets",
);

const script = `
import { cpSync } from "node:fs";
import { join } from "node:path";
const [loaderPath, root, fixtures, caseName, spec] = process.argv.slice(2);
const { loadTargetDescriptor } = await import(loaderPath);
const nm = join(root, "node_modules");
const install = (name) =>
  cpSync(join(fixtures, name), join(nm, "@fake", "mx-" + name), { recursive: true });
const attempt = () => {
  try {
    return { ok: loadTargetDescriptor(spec, root).name };
  } catch (e) {
    return { err: e.code };
  }
};
if (caseName === "D2") loadTargetDescriptor("@fake/mx-ok-ssr", root);
const first = attempt();
install("ok");
const second = attempt();
const third = attempt();
console.log(JSON.stringify({ first, second, third }));
`;

const roots: string[] = [];
afterEach(() => {
  clearTargetDescriptorCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function run(runtime: "bun" | "node", caseName: string, spec = "@fake/mx-ok") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  // The state at miss time is laid down before the process starts.
  const nm = join(root, "node_modules");
  if (caseName === "D2") {
    cpSync(join(fixtures, "ok-ssr"), join(nm, "@fake", "mx-ok-ssr"), {
      recursive: true,
    });
  }
  if (caseName === "D3") mkdirSync(join(nm, ".bin"), { recursive: true });
  const file = join(root, "probe.mjs");
  writeFileSync(file, script);
  const out = spawnSync(
    runtime,
    [file, loader, root, fixtures, caseName, spec],
    {
      encoding: "utf8",
    },
  );
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout.trim().split("\n").pop() as string) as {
    first: { ok?: string; err?: string };
    second: { ok?: string; err?: string };
    third: { ok?: string; err?: string };
  };
}

describe.each(["bun", "node"] as const)(
  "a target installed after a miss loads (%s)",
  (runtime) => {
    it.each([
      ["D1: no node_modules at miss time", "D1"],
      ["D2: node_modules/@scope present, a sibling already loaded", "D2"],
      ["D3: node_modules present, scope absent", "D3"],
    ])("%s", (_label, caseName) => {
      const r = run(runtime, caseName);
      expect(r.first).toEqual({ err: "not-found" });
      expect(r.second.err).toBeUndefined();
      expect(r.second.ok).toBeTypeOf("string");
      expect(r.third).toEqual(r.second);
    });

    it("still reports not-found when nothing is installed", () => {
      const r = run(runtime, "D3", "@fake/mx-never-installed");
      expect(r.first).toEqual({ err: "not-found" });
      expect(r.second).toEqual({ err: "not-found" });
    });
  },
);

const named = (name: string) =>
  `module.exports = { descriptorVersion: 0, name: ${JSON.stringify(name)}, packageName: "p", defaultTag: "node" };`;

// Which file each package shape resolves to, on each runtime, is pinned
// against the runtime itself in target-loader-resolve.test.ts.
describe("the loader around a miss", () => {
  afterEach(() => setSpawnSyncLoaderForTesting(undefined));

  function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const pkg = join(root, "node_modules", "@fake", "late-target");
    return {
      root,
      pkg,
      install(main = named("late")) {
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, "package.json"), '{"main":"i.cjs"}');
        writeFileSync(join(pkg, "i.cjs"), main);
      },
    };
  }

  const attempt = (spec: string, from: string) => {
    try {
      return loadTargetDescriptor(spec, from).name;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  const messageOf = (spec: string, from: string) => {
    try {
      loadTargetDescriptor(spec, from);
    } catch (e) {
      return (e as Error).message;
    }
    return "loaded";
  };

  /** Counts child processes, which still run for real. */
  function countSpawns() {
    const counter = { spawns: 0 };
    setSpawnSyncLoaderForTesting(
      () =>
        ((...args: Parameters<typeof spawnSync>) => {
          counter.spawns++;
          return spawnSync(...args);
        }) as typeof spawnSync,
    );
    return counter;
  }

  it("spawns once per change: 100 misses spawn 1, then 0 until an install, then 1", () => {
    const p = project();
    const counter = countSpawns();
    for (let i = 0; i < 100; i++) {
      expect(attempt("@fake/late-target", p.root)).toBe("not-found");
    }
    expect(counter.spawns).toBe(1);
    p.install();
    for (let i = 0; i < 100; i++) {
      expect(attempt("@fake/late-target", p.root)).toBe("late");
    }
    expect(counter.spawns).toBe(2);
  });

  it("an upgrade after the miss is a change: one more spawn, the new file", () => {
    const p = project();
    const counter = countSpawns();
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
    p.install();
    expect(attempt("@fake/late-target", p.root)).toBe("late");
    writeFileSync(join(p.pkg, "package.json"), '{"main":"v2.cjs"}');
    writeFileSync(join(p.pkg, "v2.cjs"), named("v2"));
    expect(attempt("@fake/late-target", p.root)).toBe("v2");
    expect(attempt("@fake/late-target", p.root)).toBe("v2");
    expect(counter.spawns).toBe(3);
  });

  it("a specifier that never missed never spawns", () => {
    const p = project();
    p.install();
    const counter = countSpawns();
    for (let i = 0; i < 10; i++) {
      expect(attempt("@fake/late-target", p.root)).toBe("late");
    }
    expect(counter.spawns).toBe(0);
  });

  it.each([
    [
      "no node:child_process",
      () => {
        throw new Error("Cannot find module 'node:child_process'");
      },
      /node:child_process is unavailable \(Cannot find module 'node:child_process'\), so a target installed since the miss needs a restart/,
    ],
    [
      "a child that times out",
      () =>
        (() => ({
          error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
            code: "ETIMEDOUT",
          }),
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        })) as unknown as typeof spawnSync,
      /resolving it in a child process \(.+\) timed out after 15000 ms/,
    ],
    [
      "a child that fails to start",
      () =>
        (() => ({
          error: Object.assign(new Error("spawnSync x ENOENT"), {
            code: "ENOENT",
          }),
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
        })) as unknown as typeof spawnSync,
      /resolving it in a child process \(.+\) failed: spawnSync x ENOENT/,
    ],
    [
      "a child that exits non-zero",
      () =>
        (() => ({
          status: 3,
          signal: null,
          stdout: "",
          stderr: "boom\nmore",
        })) as unknown as typeof spawnSync,
      /resolving it in a child process \(.+\) exited with status 3: boom\)/,
    ],
    [
      "a child that prints garbage",
      () =>
        (() => ({
          status: 0,
          signal: null,
          stdout: "garbage",
          stderr: "",
        })) as unknown as typeof spawnSync,
      /resolving it in a child process \(.+\) printed no answer: garbage\)/,
    ],
  ])(
    "%s: not-found naming the cause, and no other resolver",
    (_label, loader, reason) => {
      const p = project();
      setSpawnSyncLoaderForTesting(loader);
      expect(attempt("@fake/late-target", p.root)).toBe("not-found");
      p.install();
      // Installed, and this process's resolver would now find it (Node): the
      // target still stays not-found, because only the child may answer.
      const message = messageOf("@fake/late-target", p.root);
      expect(message).toMatch(
        /^"@fake\/late-target" cannot be resolved from .+: Cannot find module '@fake\/late-target'/,
      );
      expect(message).toMatch(reason);
    },
  );

  it("does not load node:child_process when core loads", () => {
    const probe = (extra: string) =>
      spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(loader)}); ${extra}
console.log(process.moduleLoadList.some((m) => m.includes("child_process")));`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    expect(probe("")).toBe("false");
    // The probe can see it: requiring it shows up.
    expect(
      probe(
        '(await import("node:module")).createRequire(import.meta.url)("node:child_process");',
      ),
    ).toBe("true");
  });

  it("a package that throws reports load-failed, not not-found", () => {
    const p = project();
    p.install(`throw new Error("boom");`);
    expect(attempt("@fake/late-target", p.root)).toBe("load-failed");
  });

  it("an invalid exports target is load-failed with the runtime's reason", () => {
    const p = project();
    mkdirSync(p.pkg, { recursive: true });
    writeFileSync(join(p.pkg, "package.json"), '{"exports":"../x.cjs"}');
    expect(attempt("@fake/late-target", p.root)).toBe("load-failed");
  });
});

// Run in fresh Bun and Node processes, each under a timeout, so a regression
// that loops fails the test instead of hanging the suite.
const childCaseScript = `
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
const [loaderPath, missPath, root, caseName] = process.argv.slice(2);
const { loadTargetDescriptor } = await import(loaderPath);
const miss = await import(missPath);
let spawns = 0;
const fakeOut = (stdout) => () => () => { spawns++; return { status: 0, signal: null, stdout, stderr: "" }; };
if (caseName === "relpath") {
  miss.setSpawnSyncLoaderForTesting(fakeOut('\\n@@mx-resolve@@{"path":"x.js"}\\n'));
} else {
  miss.setSpawnSyncLoaderForTesting(() => (...a) => { spawns++; return spawnSync(...a); });
}
const write = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const D = (name) => "module.exports = { descriptorVersion: 0, name: " + JSON.stringify(name) + ", packageName: 'p', defaultTag: 'node' };";
const attempt = (spec) => {
  try {
    return { ok: loadTargetDescriptor(spec, root).name, spawns };
  } catch (e) {
    return { err: e.code, message: e.message, spawns };
  }
};
const pkg = "node_modules/@fake/late-target";
const out = [];
if (caseName === "dist-late" || caseName === "exports-late") {
  write("package.json", "{}");
  write(pkg + "/package.json", caseName === "dist-late" ? '{"main":"dist/index.js"}' : '{"exports":"./dist/index.js"}');
  write(pkg + "/dist/types.d.ts", "export {};");
  out.push(attempt("@fake/late-target"));
  write(pkg + "/dist/index.js", D("built"));
  out.push(attempt("@fake/late-target"), attempt("@fake/late-target"));
} else if (caseName === "builtin") {
  out.push(attempt("fs/promises"));
} else if (caseName === "relpath") {
  write("package.json", "{}");
  out.push(attempt("@fake/late-target"));
}
console.log(JSON.stringify(out));
`;

function runCase(runtime: "bun" | "node", caseName: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-case-")));
  roots.push(root);
  const script = join(root, "..", `${root.split("/").pop()}-probe.mjs`);
  writeFileSync(script, childCaseScript);
  roots.push(script);
  const out = spawnSync(
    runtime,
    [script, loader, join(here, "resolve-after-miss.ts"), root, caseName],
    // The project directory is the cwd, with no package.json above it: a
    // built-in's walk once looped forever from such a cwd.
    { encoding: "utf8", cwd: root, timeout: 30_000 },
  );
  expect(out.error, "the child timed out or failed to start").toBeUndefined();
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout.trim().split("\n").pop() as string) as {
    ok?: string;
    err?: string;
    message?: string;
    spawns: number;
  }[];
}

describe.each(["bun", "node"] as const)("after a miss (%s)", (runtime) => {
  it.each(["dist-late", "exports-late"])(
    "%s: an entry built into an existing dist/ loads, with one more spawn",
    (caseName) => {
      const [first, second, third] = runCase(runtime, caseName);
      expect(first).toMatchObject({ err: "not-found", spawns: 1 });
      expect(second).toEqual({ ok: "built", spawns: 2 });
      expect(third).toEqual({ ok: "built", spawns: 2 });
    },
  );

  it("a built-in with a slash, from a cwd with no package.json, does not hang", () => {
    const [result] = runCase(runtime, "builtin");
    expect(result?.err).toBe("invalid-descriptor");
  });

  it("a child answer that is not an absolute file is not-found, naming it", () => {
    const [result] = runCase(runtime, "relpath");
    expect(result?.err).toBe("not-found");
    expect(result?.message).toMatch(
      /printed a path that is not an existing absolute file: "x\.js"\)$/,
    );
  });
});

describe("the re-ask backoff for a kept non-found answer", () => {
  afterEach(() => {
    vi.useRealTimers();
    setSpawnSyncLoaderForTesting(undefined);
  });

  it("re-asks at 0, 5, 15, 35, 75 s, then every 60 s; a change resets it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-06T00:00:00Z").getTime();
    vi.setSystemTime(start);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const spawnedAt: number[] = [];
    setSpawnSyncLoaderForTesting(
      () =>
        (() => {
          spawnedAt.push((Date.now() - start) / 1000);
          return {
            status: 0,
            signal: null,
            stdout: `\n@@mx-resolve@@${JSON.stringify({ code: "MODULE_NOT_FOUND", message: "Cannot find module '@fake/never'" })}\n`,
            stderr: "",
          };
        }) as unknown as typeof spawnSync,
    );
    // Ten minutes of steady lookups, one a second.
    for (let second = 0; second < 600; second++) {
      vi.setSystemTime(start + second * 1000);
      expect(() => loadTargetDescriptor("@fake/never", root)).toThrow(
        "Cannot find module '@fake/never'",
      );
    }
    expect(spawnedAt).toEqual([
      0, 5, 15, 35, 75, 135, 195, 255, 315, 375, 435, 495, 555,
    ]);
    // A stamp change (the scope directory appears) re-asks at once and
    // restarts the backoff at 5 s.
    spawnedAt.length = 0;
    mkdirSync(join(root, "node_modules", "@fake"));
    for (let second = 600; second < 620; second++) {
      vi.setSystemTime(start + second * 1000);
      expect(() => loadTargetDescriptor("@fake/never", root)).toThrow();
    }
    expect(spawnedAt).toEqual([600, 605, 615]);
  });
});
