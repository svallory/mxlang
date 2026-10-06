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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
} from "./target-loader.ts";

// A resolution miss must not stick (TODO target-loader-sticky-not-found): the
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

describe("fresh resolution honours the package's own entry fields", () => {
  const descriptor = `module.exports = { descriptorVersion: 0, name: "n", packageName: "p", defaultTag: "node" };`;

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
      install(name = "late-target") {
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

  it.each([
    ["main", { main: "lib/entry.cjs" }, { "lib/entry.cjs": descriptor }],
    ["no main: index.js", {}, { "index.js": descriptor }],
    ["exports string", { exports: "./e.cjs" }, { "e.cjs": descriptor }],
    [
      "exports conditions",
      { exports: { import: "./x.mjs", require: "./e.cjs" } },
      { "e.cjs": descriptor },
    ],
    [
      "exports '.' map",
      { exports: { ".": { default: "./e.cjs" } } },
      { "e.cjs": descriptor },
    ],
    [
      "exports array",
      { exports: [{ import: "./x.mjs" }, "./e.cjs"] },
      { "e.cjs": descriptor },
    ],
  ])("%s", (_label, pkg, files) => {
    const p = projectWith(pkg, files);
    expect(attempt("late-target", p.root)).toBe("not-found");
    p.install();
    expect(attempt("late-target", p.root)).toBe("loaded");
  });

  it("a subpath export", () => {
    const p = projectWith(
      { exports: { "./t": "./t.cjs" } },
      { "t.cjs": descriptor },
    );
    expect(attempt("late-target/t", p.root)).toBe("not-found");
    p.install();
    expect(attempt("late-target/t", p.root)).toBe("loaded");
    expect(attempt("late-target/other", p.root)).toBe("not-found");
  });

  it("finds a package in a parent directory's node_modules", () => {
    const p = projectWith({ main: "i.cjs" }, { "i.cjs": descriptor });
    const nested = join(p.root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(attempt("late-target", nested)).toBe("not-found");
    p.install();
    expect(attempt("late-target", nested)).toBe("loaded");
  });

  it("a missing entry or a malformed manifest stays not-found", () => {
    const p = projectWith({ main: "gone.cjs" }, {});
    p.install();
    expect(attempt("late-target", p.root)).toBe("not-found");
    writeFileSync(
      join(p.root, "node_modules", "late-target", "package.json"),
      "{nope",
    );
    expect(attempt("late-target", p.root)).toBe("not-found");
  });

  it("a package that throws reports load-failed, not not-found", () => {
    const p = projectWith(
      { main: "i.cjs" },
      { "i.cjs": `throw new Error("boom");` },
    );
    expect(attempt("late-target", p.root)).toBe("not-found");
    p.install();
    expect(attempt("late-target", p.root)).toBe("load-failed");
  });
});
