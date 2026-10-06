import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
} from "./target-loader.ts";

// A resolution miss must not stick: the
// runtime's resolver keeps a miss once the project has a node_modules, so the
// loader checks the filesystem itself. Each case runs in a fresh Bun and a
// fresh Node process, because the miss is process state: miss, install, load.

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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

describe("fresh resolution honours the package's own entry fields", () => {
  const descriptor = named("n");

  function projectWith(
    pkg: Record<string, unknown>,
    files: Record<string, string>,
  ) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    return {
      root,
      install(name = "@fake/late-target") {
        const dir = join(root, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name, ...pkg }),
        );
        for (const [file, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, file)), { recursive: true });
          writeFileSync(join(dir, file), text);
        }
      },
    };
  }

  const attempt = (spec: string, from: string) => {
    try {
      loadTargetDescriptor(spec, from);
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "loaded";
  };

  // The runtime's resolver must still report the miss after the install, or
  // these cases would pass through plain `require.resolve` and prove nothing.
  const stillMissed = (spec: string, from: string) =>
    expect(() =>
      createRequire(join(from, "package.json")).resolve(spec),
    ).toThrow();

  /** The `name` of the descriptor that loaded: which file `resolveFresh` chose. */
  const loadedName = (spec: string, from: string) =>
    loadTargetDescriptor(spec, from).name;

  // No "root index.js" case: Node's own resolver caches the missing manifest and
  // falls back to the directory's index.js, so it never reports that miss.
  it.each([
    ["main", { main: "lib/entry.cjs" }, { "lib/entry.cjs": named("main") }],
    [
      "main without extension (legacy probing)",
      { main: "lib/entry" },
      { "lib/entry.cjs": named("main") },
    ],
    [
      "exports string",
      { exports: "./e.cjs", main: "./m.cjs" },
      { "e.cjs": named("exports"), "m.cjs": named("main") },
    ],
    [
      "exports conditions",
      { exports: { import: "./x.mjs", require: "./e.cjs" } },
      { "e.cjs": named("exports") },
    ],
    [
      "exports '.' map",
      { exports: { ".": { default: "./e.cjs" } } },
      { "e.cjs": named("exports") },
    ],
    [
      "exports array",
      { exports: [{ import: "./x.mjs" }, "./e.cjs"] },
      { "e.cjs": named("exports") },
    ],
  ])("%s", (_label, pkg, files) => {
    const p = projectWith(pkg, files);
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
    p.install();
    stillMissed("@fake/late-target", p.root);
    expect(loadedName("@fake/late-target", p.root)).toBe(
      "exports" in pkg ? "exports" : "main",
    );
  });

  it("a subpath export", () => {
    const p = projectWith(
      { exports: { "./t": "./t.cjs" } },
      { "t.cjs": named("sub") },
    );
    expect(attempt("@fake/late-target/t", p.root)).toBe("not-found");
    p.install();
    stillMissed("@fake/late-target/t", p.root);
    expect(loadedName("@fake/late-target/t", p.root)).toBe("sub");
    expect(attempt("@fake/late-target/other", p.root)).toBe("not-found");
  });

  it("finds a package in a parent directory's node_modules", () => {
    const p = projectWith({ main: "i.cjs" }, { "i.cjs": descriptor });
    const nested = join(p.root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(attempt("@fake/late-target", nested)).toBe("not-found");
    p.install();
    stillMissed("@fake/late-target", nested);
    expect(attempt("@fake/late-target", nested)).toBe("loaded");
  });

  it("a missing entry stays not-found", () => {
    const p = projectWith({ main: "gone.cjs" }, {});
    p.install();
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
  });

  it("an exports target is never extension-probed (Node resolves it verbatim)", () => {
    const p = projectWith({ exports: "./e" }, { "e.js": descriptor });
    p.install();
    stillMissed("@fake/late-target", p.root);
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
  });

  it.each([
    ["a wildcard subpath pattern", { exports: { "./*": "./*.cjs" } }],
    ["a null target", { exports: { ".": null } }],
    ["a map exporting only import", { exports: { import: "./x.mjs" } }],
  ])("%s is not-found, never a guessed file", (_label, pkg) => {
    const p = projectWith(pkg, { "x.mjs": descriptor, "t.cjs": descriptor });
    p.install();
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
  });

  it("a package that throws reports load-failed, not not-found", () => {
    const p = projectWith(
      { main: "i.cjs" },
      { "i.cjs": `throw new Error("boom");` },
    );
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
    p.install();
    expect(attempt("@fake/late-target", p.root)).toBe("load-failed");
  });

  it("a fresh load that vanishes between stat and realpath is not a raw error", () => {
    const p = projectWith({ main: "i.cjs" }, { "i.cjs": descriptor });
    p.install();
    // A dangling symlink entry: stat fails, so the package reads as not-found.
    rmSync(join(p.root, "node_modules", "@fake/late-target", "i.cjs"));
    symlinkSync(
      join(p.root, "nowhere.cjs"),
      join(p.root, "node_modules", "@fake/late-target", "i.cjs"),
    );
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
  });
});

// The invalid-manifest and condition cases run in fresh Bun and Node processes:
// the miss is process state, and the condition set depends on the runtime.

interface Outcome {
  ok?: string;
  err?: string;
  message?: string;
}

const probeScript = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [loaderPath, root, planPath, spec] = process.argv.slice(2);
const { loadTargetDescriptor } = await import(loaderPath);
const plan = (await import("node:fs")).readFileSync(planPath, "utf8");
const attempt = () => {
  try {
    return { ok: loadTargetDescriptor(spec, root).name };
  } catch (e) {
    return { err: e.code ?? "RAW:" + e.name, message: e.message };
  }
};
const first = attempt();
for (const [file, text] of Object.entries(JSON.parse(plan))) {
  const target = join(root, "node_modules", file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
console.log(JSON.stringify({ first, second: attempt() }));
`;

function probe(
  runtime: "bun" | "node",
  files: Record<string, string>,
  spec = "@fake/late-target",
): { first: Outcome; second: Outcome; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  const plan = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, v.replaceAll("$ROOT", root)]),
  );
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(root, "probe.mjs"), probeScript);
  const out = spawnSync(
    runtime,
    [join(root, "probe.mjs"), loader, root, join(root, "plan.json"), spec],
    { encoding: "utf8" },
  );
  expect(out.status, out.stderr).toBe(0);
  const result = JSON.parse(out.stdout.trim().split("\n").pop() as string);
  return { ...result, root };
}

const pkgFiles = (
  manifest: unknown,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  "@fake/late-target/package.json":
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  ...extra,
});

describe.each(["bun", "node"] as const)("fresh resolution (%s)", (runtime) => {
  describe("an invalid package target is load-failed, never another file", () => {
    it.each([
      [
        "a traversing exports target",
        { exports: { ".": { require: "../escaped.cjs" } } },
      ],
      [
        "an absolute exports target",
        { exports: { ".": "$ROOT/node_modules/@fake/escaped.cjs" } },
      ],
      ["a bare exports target", { exports: "escaped.cjs" }],
      ["a dot segment", { exports: "./a/../../escaped.cjs" }],
      ["a node_modules segment", { exports: "./node_modules/x/escaped.cjs" }],
      ["a trailing slash", { exports: "./lib/" }],
      ["an invalid array entry", { exports: ["../escaped.cjs"] }],
      ["a traversing main", { main: "../escaped.cjs" }],
      ["an absolute main", { main: "$ROOT/node_modules/@fake/escaped.cjs" }],
    ])("%s", (_label, manifest) => {
      const text = JSON.stringify(manifest);
      const r = probe(runtime, {
        "@fake/escaped.cjs": named("ESCAPED"),
        "@fake/late-target/package.json": text,
      });
      expect(r.first.err).toBe("not-found");
      expect(r.second.ok).toBeUndefined();
      expect(r.second.err).toBe("load-failed");
      expect(r.second.message).toMatch(/invalid package target/i);
      expect(r.second.message).toContain("@fake/late-target");
    });

    it("a mixed subpath/condition exports map is an invalid package config", () => {
      const r = probe(
        runtime,
        pkgFiles(
          { exports: { ".": "./e.cjs", require: "./e.cjs" } },
          { "@fake/late-target/e.cjs": named("e") },
        ),
      );
      expect(r.second.err).toBe("load-failed");
      expect(r.second.message).toMatch(/invalid package config/i);
    });

    it("a top-level exports array is valid, as in Node", () => {
      const r = probe(
        runtime,
        pkgFiles(
          { exports: ["./e.cjs"] },
          { "@fake/late-target/e.cjs": named("e") },
        ),
      );
      expect(r.second).toEqual({ ok: "e" });
    });
  });

  describe("an unusable package.json is load-failed and names the manifest", () => {
    it.each([
      ["null", "null"],
      ["an array", "[]"],
      ["a number", "42"],
      ["a string", '"x"'],
      ["malformed JSON", "{nope"],
    ])("%s", (_label, text) => {
      const r = probe(
        runtime,
        pkgFiles(text, { "@fake/late-target/other.cjs": named("i") }),
      );
      expect(r.first.err).toBe("not-found");
      expect(r.second.err).toBe("load-failed");
      expect(r.second.message).toContain(
        join(r.root, "node_modules", "@fake/late-target", "package.json"),
      );
    });
  });

  describe("conditions follow the runtime, in the package's key order", () => {
    const files = {
      "@fake/late-target/bun.cjs": named("bun"),
      "@fake/late-target/node.cjs": named("node"),
      "@fake/late-target/cjs.cjs": named("cjs"),
      "@fake/late-target/d.cjs": named("default"),
    };
    // Bun honours `bun`; Node never does.
    it.each([
      [
        "bun before require",
        { bun: "./bun.cjs", require: "./cjs.cjs", default: "./d.cjs" },
        { bun: "bun", node: "cjs" },
      ],
      [
        "require before bun",
        { require: "./cjs.cjs", bun: "./bun.cjs" },
        { bun: "cjs", node: "cjs" },
      ],
      [
        "node before require",
        { node: "./node.cjs", require: "./cjs.cjs" },
        { bun: "node", node: "node" },
      ],
      [
        "default first wins over later conditions",
        { default: "./d.cjs", require: "./cjs.cjs" },
        { bun: "default", node: "default" },
      ],
      [
        "only bun, then default",
        { bun: "./bun.cjs", default: "./d.cjs" },
        { bun: "bun", node: "default" },
      ],
      [
        "import and types are never matched",
        { types: "./bun.cjs", import: "./node.cjs", default: "./d.cjs" },
        { bun: "default", node: "default" },
      ],
    ])("%s", (_label, exports, expected) => {
      const r = probe(runtime, pkgFiles({ exports }, files));
      expect(r.second).toEqual({ ok: expected[runtime] });
    });
  });
});
