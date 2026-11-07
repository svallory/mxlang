import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import AffectedCacheReporter, {
  projectInput,
} from "./test-affected-cache-reporter.ts";

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
  root = mkdtempSync(join(tmpdir(), "mx-affected-cache-"));
  storeDir = join(root, ".store");
  write(".gitignore", "node_modules/\n.store/\n");
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
  mkdirSync(join(root, "real-1"));
  mkdirSync(join(root, "real-2"));
  symlinkSync("../real-1", join(root, "node_modules", "link"));
  spawnSync("git", ["init", "-q"], { cwd: root });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cache switch (AC-2)", () => {
  it("is off by default, with CI, and with MX_AFFECTED_NATIVE=1; reads nothing then", () => {
    expect(cacheMode({}).on).toBe(false);
    expect(cacheMode({ MX_AFFECTED_CACHE: "1" }).on).toBe(true);
    expect(cacheMode({ MX_AFFECTED_CACHE: "1", CI: "true" }).on).toBe(false);
    expect(
      cacheMode({ MX_AFFECTED_CACHE: "1", MX_AFFECTED_NATIVE: "1" }).on,
    ).toBe(false);
    expect(cacheArgs({})).toEqual([]);
    expect(cacheArgs({ MX_AFFECTED_CACHE: "1", CI: "1" })).toEqual([]);
    expect(
      cacheArgs({ MX_AFFECTED_CACHE: "1", MX_AFFECTED_NATIVE: "1" }),
    ).toEqual([]);
    expect(cacheArgs({ MX_AFFECTED_CACHE: "1" }).join(" ")).toContain(
      "test-affected-cache-reporter.ts",
    );

    // The reporter, with the switch on but CI set, leaves vite-node untouched.
    const transform = async () => null;
    const vitenode = { _transformRequest: transform };
    vi.stubEnv("MX_AFFECTED_CACHE", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("MX_AFFECTED_CACHE_DIR", join(root, ".ci-store"));
    try {
      new AffectedCacheReporter().onInit({
        config: { root },
        projects: [],
      } as never);
      expect(vitenode._transformRequest).toBe(transform);
      expect(() => readFileSync(join(root, ".ci-store"))).toThrow();
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
          return collect({ ...(name === "env" ? { NODE_ENV: "x" } : {}) });
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
        name: "runtime",
        inputs: () =>
          clone((i) => {
            i.runtime.node = "v0.0.0";
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
        name: "vite-node missing",
        inputs: () =>
          clone((i) => {
            i.versions["vite-node"] = "missing";
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
        name: "function in config",
        inputs: () =>
          clone((i) => {
            i.projects[0].config = { define: () => 1 };
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
      "function in config",
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
  });

  it("serves cached lists only until finish, stores atomically, rejects an unstable file", async () => {
    const calls: string[] = [];
    const file = join(root, "src/a.ts");
    const node = {
      transformPromiseMap: { ssr: new Map() },
      _transformRequest: async (id: string) => {
        calls.push(id);
        if (id === "/src/flip.ts")
          writeFileSync(file, `export const a = ${calls.length};`);
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

    // The source changes while it is being transformed: not stored.
    const flip = join(root, "src/flip.ts");
    writeFileSync(flip, "export {}");
    const flipNode = {
      _transformRequest: async () => {
        writeFileSync(flip, `export const t = ${Math.random()};`);
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
    const fourth = install(
      [{ name: "p", vitenode: flipNode, input: project() }],
      inputs,
      dir,
    );
    await flipNode._transformRequest("/src/flip.ts", flip, "ssr" as never);
    fourth?.finish();
    expect(fourth?.stats.hits).toBe(0);
  });
});

describe("glob counterexample (AC-4)", () => {
  it("selects the covering test after a file is added under a glob", async () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "mx-affected-glob-")));
    try {
      const w = (rel: string, text: string) => {
        mkdirSync(join(proj, rel, ".."), { recursive: true });
        writeFileSync(join(proj, rel), text);
      };
      w("package.json", '{"name":"glob-fx","type":"module"}');
      w("cases/a.ts", "export const value = 1;");
      w(
        "glob.test.ts",
        'export const modules = import.meta.glob("./cases/*.ts");',
      );
      w(
        "plain.test.ts",
        'import { value } from "./cases/a.ts";\nexport { value };',
      );
      spawnSync("git", ["init", "-q"], { cwd: proj });
      // The four nominal keys stay fixed across both runs.
      const inputs = collectInputs(proj, [], {}, root);
      const dir = join(proj, ".store");

      const select = async (related: string, cached: boolean) => {
        const ctx = await createVitest(
          "test",
          {
            root: proj,
            config: false,
            watch: false,
            run: true,
            related: [join(proj, related)],
            reporters: [],
          },
          {},
          { stdout: process.stderr },
        );
        try {
          const handle = cached
            ? install(
                ctx.projects.map((p) => ({
                  name: p.name,
                  vitenode: p.vitenode as never,
                  input: { ...projectInput(p as never), plugins: [] },
                })),
                inputs,
                dir,
              )
            : undefined;
          const specs =
            await ctx.specifications.getRelevantTestSpecifications();
          handle?.finish();
          return {
            files: specs.map((s) => s.moduleId.slice(proj.length + 1)).sort(),
            stats: handle?.stats,
          };
        } finally {
          await ctx.close();
        }
      };

      const cold = await select("cases/a.ts", true);
      expect(cold.files).toEqual(["glob.test.ts", "plain.test.ts"]);
      w("cases/b.ts", "export const value = 2;");
      const warm = await select("cases/b.ts", true);
      const native = await select("cases/b.ts", false);
      expect(native.files).toEqual(["glob.test.ts"]);
      expect(warm.files).toEqual(native.files);
      expect(warm.stats?.hits).toBeGreaterThan(0);
      expect(warm.stats?.reasons.size).toBeGreaterThan(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 60_000);
});
