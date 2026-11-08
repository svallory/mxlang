import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createVitest } from "vitest/node";
import { cacheArgs } from "./test-affected.ts";
import {
  bypassReason,
  cacheMode,
  collectInputs,
  type Deps,
  entryKey,
  type Inputs,
  install,
  namespaceFor,
  type ProjectInput,
  projectKey,
  SCHEMA_VERSION,
  Store,
  SUPPORTED_VERSIONS,
} from "./test-affected-cache.ts";
import AffectedCacheReporter from "./test-affected-cache-reporter.ts";

let root: string;
let storeDir: string;
const project = (): ProjectInput => ({
  name: "p",
  root,
  plugins: ["vite:esbuild", "alias"],
  config: {
    resolve: {
      conditions: ["node"],
      alias: [{ find: /^x$/, replacement: "y" }],
    },
  },
});
const collect = (env: NodeJS.ProcessEnv = {}): Inputs =>
  collectInputs(root, [project()], env, root);
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mx-affected-cache-")));
  storeDir = join(root, ".store");
  write(".gitignore", "node_modules/\n.store/\ndist/\n");
  write("packages/x/package.json", '{"name":"x"}');
  write("package.json", '{"name":"fx"}');
  write("bun.lock", "lock-1");
  write("tsconfig.base.json", "{}");
  write("patches/a.patch", "patch-1");
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "export const b = 1;");
  write("node_modules/.bun/foo@1.0.0/x", "");
  for (const [n, v] of Object.entries(SUPPORTED_VERSIONS)) {
    write(`node_modules/${n}/package.json`, JSON.stringify({ version: v }));
  }
  write("globproj/package.json", '{"name":"glob-fx","type":"module"}');
  write("globproj/cases/a.ts", "export const value = 1;");
  write(
    "globproj/glob.test.ts",
    'it("g", () => {});\nexport const modules = import.meta.glob("./cases/*.ts");',
  );
  write(
    "globproj/plain.test.ts",
    'import { value } from "./cases/a.ts";\nit("p", () => { void value; });',
  );
  mkdirSync(join(root, "real-1"));
  mkdirSync(join(root, "real-2"));
  symlinkSync("../real-1", join(root, "node_modules", "link"));
  // Track every file: the delete/rename rows must exercise tracked files,
  // which `git ls-files -co` keeps listing after a plain `rm`.
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "fixture",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cache switch (AC-2)", () => {
  it("is on locally by default; off with CI, MX_AFFECTED_NATIVE=1 and MX_AFFECTED_CACHE=0/false/off/no; reads nothing then", () => {
    expect(cacheMode({}).on).toBe(true);
    expect(cacheMode({ MX_AFFECTED_CACHE: "1" }).on).toBe(true);
    expect(cacheMode({ CI: "true" }).on).toBe(false);
    expect(cacheMode({ MX_AFFECTED_CACHE: "1", CI: "true" }).on).toBe(false);
    expect(cacheMode({ MX_AFFECTED_NATIVE: "1" }).on).toBe(false);
    expect(
      cacheMode({ MX_AFFECTED_CACHE: "1", MX_AFFECTED_NATIVE: "1" }).on,
    ).toBe(false);
    for (const off of ["0", "false", "FALSE", "off", "No", " 0 "]) {
      expect(cacheMode({ MX_AFFECTED_CACHE: off }).on, off).toBe(false);
    }
    for (const on of ["", "1", "true", "yes"]) {
      expect(cacheMode({ MX_AFFECTED_CACHE: on }).on, on).toBe(true);
    }
    expect(cacheArgs({}).join(" ")).toContain(
      "test-affected-cache-reporter.ts",
    );
    expect(cacheArgs({ CI: "1" })).toEqual([]);
    expect(cacheArgs({ MX_AFFECTED_NATIVE: "1" })).toEqual([]);
    expect(cacheArgs({ MX_AFFECTED_CACHE: "0" })).toEqual([]);
    expect(cacheArgs({})[0]).toBe("--reporter=default");
    // A reporter the caller names replaces the injected default.
    expect(cacheArgs({}, ["--reporter=dot"])).toEqual([
      expect.stringContaining("test-affected-cache-reporter.ts"),
    ]);

    // The reporter, with CI set, leaves vite-node untouched
    // and writes no store.
    const transform = async () => null;
    const vitenode = { _transformRequest: transform };
    const dir = join(root, ".ci-store");
    vi.stubEnv("MX_AFFECTED_CACHE", "1");
    vi.stubEnv("CI", "true");
    try {
      new AffectedCacheReporter({ dir }).onInit({
        config: { root },
        projects: [
          { name: "p", config: { root }, vite: { config: {} }, vitenode },
        ],
      } as never);
      expect(vitenode._transformRequest).toBe(transform);
      expect(existsSync(dir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("guards fall back to native (AC-3)", () => {
  it("every guard makes the cached entry unreachable or unusable", () => {
    const base = collect();
    const ns = namespaceFor(base);
    if (!ns.ok) throw new Error(ns.reason);
    const req = (i: Inputs, ns2: string) => {
      const pk = projectKey(i.projects[0]);
      if (!pk.ok) throw new Error(pk.reason);
      return entryKey(
        ns2,
        {
          project: "p",
          projectKey: pk.value,
          id: "/src/a.ts",
          filepath: join(root, "src/a.ts"),
          mode: "ssr",
        },
        "h",
      );
    };
    const seed = new Store(storeDir, ns.value);
    const key = req(base, ns.value);
    const deps: Deps = { deps: ["/src/b.ts"], dynamicDeps: [] };
    expect(seed.put(key, deps)).toBe(true);
    expect(seed.get(key)).toEqual(deps);

    // Reachable under `i`? (A different namespace or entry key is a native miss.)
    const served = (i: Inputs): boolean => {
      const n = namespaceFor(i);
      if (!n.ok) return false;
      const pk = projectKey(i.projects[0]);
      if (!pk.ok) return false;
      return new Store(storeDir, n.value).get(req(i, n.value)) !== undefined;
    };
    expect(served(base)).toBe(true);
    // The order projects are listed in must not change the namespace.
    const one = join(root, "real-1");
    const two = join(root, "real-2");
    for (const d of [one, two]) {
      mkdirSync(join(d, "node_modules"), { recursive: true });
      symlinkSync(
        `../../${d === one ? "real-2" : "real-1"}`,
        join(d, "node_modules", "zz"),
      );
    }
    const at = (r: string) => ({ ...project(), root: r });
    const a = collectInputs(root, [at(one), at(two)], {}, root);
    const b = collectInputs(root, [at(two), at(one)], {}, root);
    expect(namespaceFor(a)).toEqual(namespaceFor(b));

    const clone = (f: (i: Inputs) => void): Inputs => {
      const i = structuredClone(base);
      i.projects = [project()];
      f(i);
      return i;
    };
    const onDisk = (name: string, mutate: () => void, undo: () => void) => ({
      name,
      inputs: () => {
        mutate();
        try {
          return collect();
        } finally {
          undo();
        }
      },
    });
    const rows: { name: string; inputs: () => Inputs }[] = [
      { name: "env value", inputs: () => collect({ NODE_ENV: "production" }) },
      onDisk(
        "manifest: package.json",
        () => write("package.json", '{"name":"fx2"}'),
        () => write("package.json", '{"name":"fx"}'),
      ),
      onDisk(
        "manifest: lockfile",
        () => write("bun.lock", "lock-2"),
        () => write("bun.lock", "lock-1"),
      ),
      onDisk(
        "manifest: tsconfig",
        () => write("tsconfig.base.json", '{"a":1}'),
        () => write("tsconfig.base.json", "{}"),
      ),
      onDisk(
        "patch",
        () => write("patches/a.patch", "patch-2"),
        () => write("patches/a.patch", "patch-1"),
      ),
      onDisk(
        "package identity",
        () => mkdirSync(join(root, "node_modules/.bun/foo@2.0.0")),
        () =>
          rmSync(join(root, "node_modules/.bun/foo@2.0.0"), {
            recursive: true,
          }),
      ),
      onDisk(
        "symlink retarget",
        () => {
          unlinkSync(join(root, "node_modules/link"));
          symlinkSync("../real-2", join(root, "node_modules/link"));
        },
        () => {
          unlinkSync(join(root, "node_modules/link"));
          symlinkSync("../real-1", join(root, "node_modules/link"));
        },
      ),
      onDisk(
        "symlink retarget in a workspace package that is not a project",
        () => {
          mkdirSync(join(root, "packages/x/node_modules"), { recursive: true });
          symlinkSync(
            "../../../real-1",
            join(root, "packages/x/node_modules/lnk"),
          );
        },
        () =>
          rmSync(join(root, "packages/x/node_modules"), { recursive: true }),
      ),
      onDisk(
        "gitignored build output added",
        () => write("packages/x/dist/f.js", ""),
        () => rmSync(join(root, "packages/x/dist"), { recursive: true }),
      ),
      onDisk(
        "file added",
        () => write("src/new.ts", ""),
        () => unlinkSync(join(root, "src/new.ts")),
      ),
      onDisk(
        "file deleted",
        () => unlinkSync(join(root, "src/b.ts")),
        () => write("src/b.ts", "export const b = 1;"),
      ),
      onDisk(
        "file renamed",
        () => renameSync(join(root, "src/b.ts"), join(root, "src/c.ts")),
        () => renameSync(join(root, "src/c.ts"), join(root, "src/b.ts")),
      ),
      {
        name: "root relocated",
        inputs: () =>
          clone((i) => {
            i.root = `${root}-moved`;
          }),
      },
      {
        name: "platform",
        inputs: () =>
          clone((i) => {
            i.runtime.platform = "win32";
          }),
      },
      {
        name: "resolve conditions",
        inputs: () =>
          clone((i) => {
            (
              i.projects[0].config as { resolve: { conditions: string[] } }
            ).resolve.conditions = ["node", "x"];
          }),
      },
      {
        name: "project config define",
        inputs: () =>
          clone((i) => {
            i.projects[0].config = { define: { A: "1" } };
          }),
      },
      {
        name: "vitest version",
        inputs: () =>
          clone((i) => {
            i.versions.vitest = "3.2.8";
          }),
      },
      {
        name: "inventory unavailable",
        inputs: () =>
          clone((i) => {
            i.inventory = undefined;
          }),
      },
      {
        name: "unsupported plugin",
        inputs: () =>
          clone((i) => {
            i.projects[0].plugins.push("some-user-plugin");
          }),
      },
      {
        name: "third-party vite:-prefixed plugin",
        inputs: () =>
          clone((i) => {
            i.projects[0].plugins.push("vite:react-babel");
          }),
      },
      {
        name: "plugin option closure",
        inputs: () =>
          clone((i) => {
            i.projects[0].config = {
              resolve: { alias: [{ find: "x", customResolver() {} }] },
            };
          }),
      },
    ];
    for (const row of rows) {
      expect(served(row.inputs()), row.name).toBe(false);
    }
    // These must not merely change the key: the project has to stay native.
    for (const name of [
      "unsupported plugin",
      "third-party vite:-prefixed plugin",
      "plugin option closure",
    ]) {
      const row = rows.find((r) => r.name === name);
      expect(
        projectKey(row?.inputs().projects[0] as ProjectInput).ok,
        name,
      ).toBe(false);
    }
    // The rows restored the fixture, so the seeded entry is reachable again.
    expect(served(collect())).toBe(true);

    // Entry-level bypass: never cached, whatever the store holds.
    const file = (id: string, src?: string) =>
      bypassReason(
        { id, filepath: join(root, "src/a.ts") },
        src === undefined ? undefined : Buffer.from(src),
      );
    expect(file("/src/a.ts", "export {}")).toBeUndefined();
    expect(
      bypassReason({ id: "virtual:x", filepath: "virtual:x" }, Buffer.from("")),
    ).toBe("virtual id");
    expect(bypassReason({ id: "\0x", filepath: "\0x" }, Buffer.from(""))).toBe(
      "virtual id",
    );
    expect(file("/src/a.ts?raw", "")).toBeDefined();
    expect(file("/src/a.ts")).toBeDefined();
    expect(file("/src/a.ts", "import.meta.glob('./*.ts')")).toMatch(/glob/);
    expect(file("/src/a.ts", "import.meta.globEager('./*.ts')")).toMatch(
      /glob/,
    );
    expect(file("/src/a.ts", "require.context('./')")).toMatch(/glob/);

    // Storage: read or parse failure, schema, checksum and identity are misses.
    const path = (k: string) => join(seed.nsDir, k.slice(0, 2), `${k}.json`);
    const good = readFileSync(path(key), "utf8");
    const bad: [string, string][] = [
      ["garbage", "{nope"],
      ["empty", ""],
      ["truncated", good.slice(0, good.length / 2)],
      ["schema", good.replace(`"schema":${SCHEMA_VERSION}`, '"schema":999')],
      ["checksum", good.replace("/src/b.ts", "/src/z.ts")],
      ["wrong key", good.replace(key, "0".repeat(64))],
      ["non-string dep", good.replace('"/src/b.ts"', "5")],
    ];
    for (const [name, text] of bad) {
      writeFileSync(path(key), text);
      expect(seed.get(key), name).toBeUndefined();
    }
    writeFileSync(path(key), good);
    expect(seed.get(key)).toEqual(deps);

    // GC: namespace cap, size bound, stale temp files, old schema dirs, and
    // nothing outside `v<digits>` is ever removed.
    const NOW = 1_700_000_000_000;
    const gcDir = join(root, ".gc-store");
    const old = (path: string, ageSec: number) => {
      const t = new Date(NOW - ageSec * 1000);
      utimesSync(path, t, t);
    };
    const space = (name: string, ageSec: number) => {
      const st = new Store(gcDir, name);
      st.touch();
      old(join(st.nsDir, ".used"), ageSec);
      return st;
    };
    const [n0, n1, n2] = [space("n0", 400), space("n1", 300), space("n2", 200)];
    const cur = space("cur", 0);
    for (let i = 0; i < 4; i++) {
      expect(cur.put(`ab${i}`, deps)).toBe(true);
      old(join(cur.nsDir, "ab", `ab${i}.json`), 100 - i * 10); // ab0 oldest
    }
    const size = statSync(join(cur.nsDir, "ab", "ab0.json")).size;
    writeFileSync(join(cur.nsDir, "ab", "stale.tmp"), "x");
    old(join(cur.nsDir, "ab", "stale.tmp"), 120);
    writeFileSync(join(cur.nsDir, "ab", "fresh.tmp"), "x");
    old(join(cur.nsDir, "ab", "fresh.tmp"), 0);
    mkdirSync(join(gcDir, "v0"), { recursive: true });
    mkdirSync(join(gcDir, "keep-me"), { recursive: true });

    cur.gc(1 << 30, 3, NOW);
    expect(existsSync(join(cur.nsDir, "ab", "stale.tmp"))).toBe(false);
    expect(existsSync(join(cur.nsDir, "ab", "fresh.tmp"))).toBe(true);
    expect(cur.get("ab0"), "nothing evicted under the bound").toEqual(deps);

    cur.gc(size * 2 + 1, 3, NOW);
    expect(existsSync(n0.nsDir), "oldest namespace evicted").toBe(false);
    expect(existsSync(n1.nsDir), "newer namespace kept").toBe(true);
    expect(existsSync(n2.nsDir)).toBe(true);
    expect(existsSync(cur.nsDir), "current namespace kept").toBe(true);
    expect(
      cur.get("ab0"),
      "oldest entry evicted for the size bound",
    ).toBeUndefined();
    expect(cur.get("ab1")).toBeUndefined();
    expect(cur.get("ab2")).toEqual(deps);
    expect(cur.get("ab3")).toEqual(deps);
    expect(existsSync(join(gcDir, "v0")), "old schema dir").toBe(false);
    expect(existsSync(join(gcDir, "keep-me")), "foreign dir untouched").toBe(
      true,
    );
  });

  it("serves cached lists only until finish, stores atomically, rejects an unstable file", async () => {
    const calls: string[] = [];
    const file = join(root, "src/a.ts");
    const node = {
      transformPromiseMap: { ssr: new Map() },
      _transformRequest: async (id: string) => {
        calls.push(id);
        return { code: "x", deps: ["/src/b.ts"], dynamicDeps: ["/src/c.ts"] };
      },
    };
    const original = node._transformRequest;
    const inputs = collect();
    const dir = join(root, ".roundtrip");
    const run = () =>
      install([{ name: "p", vitenode: node, input: project() }], inputs, dir);
    const first = run();
    expect(first).toBeDefined();
    await node._transformRequest("/src/a.ts", file, "ssr" as never);
    first?.finish();
    expect(node._transformRequest).toBe(original);
    expect(first?.stats).toMatchObject({ hits: 0, misses: 1 });

    const second = run();
    const got = await node._transformRequest("/src/a.ts", file, "ssr" as never);
    expect(got).toMatchObject({
      deps: ["/src/b.ts"],
      dynamicDeps: ["/src/c.ts"],
    });
    expect(got).not.toHaveProperty("code");
    expect(calls).toEqual(["/src/a.ts"]);
    expect(second?.stats.hits).toBe(1);

    // The source changes while it is being transformed: not stored. Only a
    // stored entry could be hit by the stable re-run below.
    const flip = join(root, "src/flip.ts");
    writeFileSync(flip, "export {}");
    let n = 0;
    const flipNode = {
      _transformRequest: async () => {
        writeFileSync(flip, `export const t = ${++n};`);
        return { code: "x", deps: ["/src/b.ts"], dynamicDeps: [] };
      },
    };
    const third = install(
      [{ name: "p", vitenode: flipNode, input: project() }],
      inputs,
      dir,
    );
    await flipNode._transformRequest("/src/flip.ts", flip, "ssr" as never);
    third?.finish();
    expect(third?.stats).toMatchObject({ unstable: 1, misses: 1 });
    second?.finish();

    writeFileSync(flip, "export {}");
    const steadyNode = {
      _transformRequest: async () => ({
        code: "x",
        deps: ["/src/b.ts"],
        dynamicDeps: [],
      }),
    };
    const fourth = install(
      [{ name: "p", vitenode: steadyNode, input: project() }],
      inputs,
      dir,
    );
    await steadyNode._transformRequest("/src/flip.ts", flip, "ssr" as never);
    fourth?.finish();
    expect(fourth?.stats).toMatchObject({ hits: 0, misses: 1 });
  });
});

describe("glob counterexample (AC-4)", () => {
  it("selects the covering test after a file is added under a glob, through the reporter", async () => {
    // A subdirectory of the file fixture's repository (committed in beforeAll).
    const proj = join(root, "globproj");
    const exitCode = process.exitCode;
    vi.stubEnv("MX_AFFECTED_CACHE", "1");
    vi.stubEnv("CI", "");
    try {
      // The nominal keys stay fixed across the runs: only the directory changes.
      const fixed = collect();
      const dir = join(proj, ".store");

      const select = async (related: string, cached: boolean) => {
        const reporter = new AffectedCacheReporter({
          dir,
          inputs: (_r, projects) => ({ ...fixed, projects }),
        });
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((m) => {
          lines.push(String(m));
        });
        const ctx = await createVitest(
          "test",
          {
            root: proj,
            config: false,
            watch: false,
            run: true,
            globals: true,
            related: [join(proj, related)],
            reporters: cached ? [reporter] : [],
          },
          {},
          { stdout: process.stderr },
        );
        let during: unknown;
        try {
          const node = ctx.projects[0].vitenode as unknown as {
            _transformRequest: unknown;
          };
          const nativeFn = node._transformRequest;
          await ctx.start();
          during = node._transformRequest === nativeFn;
          const files = ctx.state
            .getFiles()
            .map((f) => f.filepath.slice(proj.length + 1))
            .sort();
          return { files, restored: during, line: lines.join("\n") };
        } finally {
          log.mockRestore();
          await ctx.close();
        }
      };

      const cold = await select("cases/a.ts", true);
      expect(cold.files).toEqual(["glob.test.ts", "plain.test.ts"]);
      expect(cold.restored).toBe(true);
      const warm = await select("cases/a.ts", true);
      expect(warm.line).toMatch(/[1-9]\d* hits/);
      expect(warm.line).toMatch(/1x glob import/);
      writeFileSync(join(proj, "cases", "b.ts"), "export const value = 2;");
      const added = await select("cases/b.ts", true);
      const native = await select("cases/b.ts", false);
      expect(native.files).toEqual(["glob.test.ts"]);
      expect(added.files).toEqual(native.files);
      expect(added.line).toMatch(/[1-9]\d* hits/);
    } finally {
      vi.unstubAllEnvs();
      process.exitCode = exitCode;
      rmSync(join(proj, "cases", "b.ts"), { force: true });
    }
  }, 60_000);
});
