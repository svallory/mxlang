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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
} from "./target-loader.ts";

// A resolution miss must not stick: the runtime's resolver keeps a miss once
// the project has a node_modules, so the loader resolves from the filesystem
// itself. Each case runs in a fresh Bun and a fresh Node process, because the
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
// against the runtime itself in fresh-resolve.test.ts.
describe("the loader around a fresh resolution", () => {
  function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-loader-miss-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    const pkg = join(root, "node_modules", "@fake", "late-target");
    mkdirSync(pkg, { recursive: true });
    return { root, pkg };
  }

  const attempt = (spec: string, from: string) => {
    try {
      return loadTargetDescriptor(spec, from).name;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  it("a package that throws reports load-failed, not not-found", () => {
    const p = project();
    writeFileSync(join(p.pkg, "package.json"), '{"main":"i.cjs"}');
    writeFileSync(join(p.pkg, "i.cjs"), `throw new Error("boom");`);
    expect(attempt("@fake/late-target", p.root)).toBe("load-failed");
  });

  it("a dangling-symlink entry is not-found", () => {
    const p = project();
    writeFileSync(join(p.pkg, "package.json"), '{"main":"i.cjs"}');
    symlinkSync(join(p.root, "nowhere.cjs"), join(p.pkg, "i.cjs"));
    expect(attempt("@fake/late-target", p.root)).toBe("not-found");
  });

  it("an invalid exports target is load-failed naming the manifest", () => {
    const p = project();
    writeFileSync(join(p.pkg, "package.json"), '{"exports":"../x.cjs"}');
    expect(() => loadTargetDescriptor("@fake/late-target", p.root)).toThrow(
      `invalid package target "../x.cjs" in ${join(p.pkg, "package.json")}`,
    );
  });

  // Not in fresh-resolve.test.ts: Bun 1.3.14 normalizes `p/../escaped` on
  // Linux and loads the neighbour's file, but not on macOS. Node rejects it
  // (ERR_INVALID_MODULE_SPECIFIER); the loader follows Node on both runtimes.
  it("an exports pattern match that leaves the package is load-failed", () => {
    const p = project();
    writeFileSync(join(p.pkg, "package.json"), '{"exports":{"./*":"./*.cjs"}}');
    writeFileSync(
      join(p.root, "node_modules", "@fake", "escaped.cjs"),
      named("x"),
    );
    expect(attempt("@fake/late-target/../escaped", p.root)).toBe("load-failed");
  });

  it("a package that exports nothing for the specifier says so", () => {
    const p = project();
    writeFileSync(join(p.pkg, "package.json"), '{"exports":{"./t":"./t.cjs"}}');
    writeFileSync(join(p.pkg, "t.cjs"), named("t"));
    expect(attempt("@fake/late-target/t", p.root)).toBe("t");
    expect(() =>
      loadTargetDescriptor("@fake/late-target/other", p.root),
    ).toThrow(/does not export "\.\/other"/);
  });

  it("a specifier no node_modules holds is still the runtime's not-found", () => {
    const p = project();
    expect(() => loadTargetDescriptor("@fake/never", p.root)).toThrow(
      "Cannot find module '@fake/never'",
    );
  });
});
