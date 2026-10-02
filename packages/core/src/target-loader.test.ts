import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as core from "./index.ts";
import { TranslateError } from "./index.ts";
import { TargetDescriptorError } from "./target-descriptor.ts";
import {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
  TargetLoadError,
} from "./target-loader.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/targets");

function loadError(spec: string, fromDir: string): TargetLoadError {
  try {
    loadTargetDescriptor(spec, fromDir);
  } catch (error) {
    expect(error).toBeInstanceOf(TargetLoadError);
    return error as TargetLoadError;
  }
  throw new Error("expected loadTargetDescriptor to throw");
}

beforeEach(() => clearTargetDescriptorCache());

describe("loadTargetDescriptor: fixture packages", () => {
  it("loads a well-formed descriptor and the compiler it lazily returns", () => {
    const descriptor = loadTargetDescriptor("./ok/index.ts", FIXTURES);
    expect(descriptor.name).toBe("acme-jsx");
    expect(descriptor.host?.name).toBe("acme");

    const compiler = descriptor.load?.(core);
    expect(compiler?.compileModule("hi", "a.mx", {}).code).toBe(
      'export default "hi";',
    );
  });

  it("hands the tool's own core to load(): errors thrown with it pass the tool's instanceof check", () => {
    const compiler = loadTargetDescriptor("./ok/index.ts", FIXTURES).load?.(
      core,
    );
    let thrown: unknown;
    try {
      compiler?.compileModule("BOOM", "a.mx", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TranslateError);
  });

  it("reports not-found for a package that is not installed", () => {
    const error = loadError("@acme/not-installed", join(FIXTURES, "missing"));
    expect(error.code).toBe("not-found");
    expect(error.spec).toBe("@acme/not-installed");
    expect(error.fromDir).toBe(join(FIXTURES, "missing"));
    expect(error.message).toContain(
      '"@acme/not-installed" cannot be resolved from',
    );
    expect(error.message).toContain(join(FIXTURES, "missing"));
    expect(error.message).not.toContain("\n");
    expect(error.path).toBeUndefined();
  });

  it("reports not-found when fromDir does not exist", () => {
    expect(loadError("./x.js", join(FIXTURES, "no-such-dir")).code).toBe(
      "not-found",
    );
  });

  it("reports load-failed, naming the file and the cause, when the module throws on require", () => {
    const error = loadError("./throws/index.ts", FIXTURES);
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("target exploded");
    expect(error.message).toContain(join(FIXTURES, "throws", "index.ts"));
    expect(error.path).toBe(join(FIXTURES, "throws", "index.ts"));
    expect((error.cause as Error).message).toBe("target exploded");
  });

  it("reports invalid-descriptor naming the first failing field", () => {
    const error = loadError("./invalid/index.ts", FIXTURES);
    expect(error.code).toBe("invalid-descriptor");
    expect(error.message).toBe(
      '"./invalid/index.ts" must export a target descriptor (default export or "mxTarget"): "name" is missing, expected a string. See the TargetDescriptor contract (unstable).',
    );
    expect(error.cause).toBeInstanceOf(TargetDescriptorError);
  });

  it("reports a version mismatch as invalid-descriptor with the version in the message", () => {
    const error = loadError("./version/index.ts", FIXTURES);
    expect(error.code).toBe("invalid-descriptor");
    expect(error.message).toBe(
      '"./version/index.ts" targets descriptor version 1; this mx supports 0.',
    );
  });

  it("loads own-core, which ignores the injected core, and pins that its errors fail the tool's instanceof", () => {
    // OQ10. A target that uses its own `@mxlang/core` (the fixture's
    // `core-copy.ts` stands in for one) throws a `TranslateError` of a
    // different class.
    // The brand check that makes such errors recognisable anyway (`name` plus
    // a `Symbol.for` marker, replacing `instanceof TranslateError` in core)
    // is PR 3's, per the design note §4.4; until it lands this test records
    // the divergence rather than a fix.
    const compiler = loadTargetDescriptor(
      "./own-core/index.ts",
      FIXTURES,
    ).load?.(core);
    let thrown: unknown;
    try {
      compiler?.compileModule("x", "a.mx", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("TranslateError");
    expect((thrown as Error).message).toBe("from the target's own core");
    expect(thrown).not.toBeInstanceOf(TranslateError);
  });
});

describe("loadTargetDescriptor: installed packages and export shapes", () => {
  let project: string;

  /** Writes `node_modules/<name>/index.js` and returns its path. */
  function install(
    name: string,
    body: string,
    pkg: Record<string, unknown> = {},
  ): string {
    const dir = join(project, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, main: "index.js", ...pkg }),
    );
    const file = join(dir, "index.js");
    writeFileSync(file, body);
    return file;
  }

  const DESCRIPTOR = `{ descriptorVersion: 0, name: "pkg-target", packageName: "pkg" }`;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "mx-target-loader-")));
    writeFileSync(join(project, "package.json"), "{}");
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("resolves a bare package name from the project, not from core", () => {
    install("pkg", `module.exports = { default: ${DESCRIPTOR} };`);
    expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
  });

  it("resolves from the nearest node_modules above fromDir", () => {
    install("pkg", `module.exports = { default: ${DESCRIPTOR} };`);
    const nested = join(project, "apps", "web");
    mkdirSync(nested, { recursive: true });
    expect(loadTargetDescriptor("pkg", nested).name).toBe("pkg-target");
  });

  it("prefers the default export", () => {
    install(
      "pkg",
      `module.exports = { default: ${DESCRIPTOR}, mxTarget: { nope: true } };`,
    );
    expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
  });

  it("falls back to a named mxTarget export", () => {
    install("pkg", `module.exports = { mxTarget: ${DESCRIPTOR} };`);
    expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
  });

  it("falls back to a default export that is null, then to mxTarget", () => {
    install(
      "pkg",
      `module.exports = { default: null, mxTarget: ${DESCRIPTOR} };`,
    );
    expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
  });

  it("accepts a CommonJS module.exports that is the descriptor itself", () => {
    install("pkg", `module.exports = ${DESCRIPTOR};`);
    expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
  });

  it("reports invalid-descriptor when the module exports neither", () => {
    install("pkg", `module.exports = { something: 1 };`);
    const error = loadError("pkg", project);
    expect(error.code).toBe("invalid-descriptor");
    expect(error.message).toContain(
      'must export a target descriptor (default export or "mxTarget")',
    );
    expect(error.message).toContain("expected an object");
  });

  it("reports invalid-descriptor for a non-object default export", () => {
    install("pkg", `module.exports = { default: "nope" };`);
    expect(loadError("pkg", project).code).toBe("invalid-descriptor");
  });

  it("restates the no-top-level-await constraint, as the sidecar loader does", () => {
    install(
      "pkg",
      `throw new Error("await is only valid in async functions and the top level bodies of modules; top-level await");`,
    );
    const error = loadError("pkg", project);
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("top-level `await`");
    expect(error.message).toContain("loaded synchronously");
  });

  it("restates the explicit-extension constraint when a relative import cannot be found", () => {
    install("pkg", `require("./helper");`);
    const error = loadError("pkg", project);
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("explicit extensions");
  });

  it.each([
    ['throw "boom"', "boom"],
    ["throw null", "null"],
    ["throw undefined", "undefined"],
    ["throw {}", "[object Object]"],
    ["throw 42", "42"],
    ["throw Object.create(null)", "a non-Error value was thrown"],
    [
      'throw { toString() { throw new Error("toString exploded"); } }',
      "a non-Error value was thrown",
    ],
  ])(
    "turns a non-Error throw (%s) into load-failed, not a raw TypeError",
    (statement, text) => {
      install("pkg", statement);
      const error = loadError("pkg", project);
      expect(error.code).toBe("load-failed");
      expect(error.message).toContain(text);
      expect(error.message).not.toContain("\n");
    },
  );

  it.each([
    ['new Error("")', "first line is blank"],
    ['new Error("   \\nx")', "first line is only whitespace"],
  ])("names a placeholder when the thrown message's %s (%s)", (expression) => {
    install("pkg", `throw ${expression};`);
    const error = loadError("pkg", project);
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("failed to load: <no message>. (");
    expect(error.message).not.toContain("\n");
  });

  it("keeps a multi-line load failure to its first line, the full text in cause", () => {
    install("pkg", `throw new Error("line one\\nline two\\nline three");`);
    const error = loadError("pkg", project);
    expect(error.message).not.toContain("\n");
    expect(error.message).toContain("line one");
    expect(error.message).not.toContain("line two");
    expect((error.cause as Error).message).toContain("line three");
  });

  it("puts a period before the resolved path, as note §4.3 shows", () => {
    install("pkg", `throw new Error("plain");`);
    expect(loadError("pkg", project).message).toMatch(
      /plain\. \(.+index\.js\)$/,
    );
  });

  it("accepts a relative fromDir, resolved against the cwd, rather than crashing", () => {
    install("pkg", `module.exports = { default: ${DESCRIPTOR} };`);
    const rel = relative(process.cwd(), project);
    expect(loadTargetDescriptor("pkg", rel).name).toBe("pkg-target");
    expect(loadError("nope-not-here", rel).code).toBe("not-found");
  });

  it("does not hint on an unrelated load failure", () => {
    install("pkg", `throw new Error("plain");`);
    const message = loadError("pkg", project).message;
    expect(message).toContain("plain");
    expect(message).not.toContain("explicit extensions");
    expect(message).not.toContain("top-level `await`");
  });

  describe("cache (design note §4.2)", () => {
    const counting = (marker: string) => `
      globalThis.__mxTargetLoads = (globalThis.__mxTargetLoads ?? 0) + 1;
      module.exports = { default: { descriptorVersion: 0, name: "pkg-target", packageName: "pkg", pending: "${marker}" } };
    `;

    const loads = () =>
      (globalThis as { __mxTargetLoads?: number }).__mxTargetLoads ?? 0;

    beforeEach(() => {
      (globalThis as { __mxTargetLoads?: number }).__mxTargetLoads = 0;
    });

    afterEach(() => {
      delete (globalThis as { __mxTargetLoads?: number }).__mxTargetLoads;
    });

    it("returns the identical descriptor object on repeated loads and evaluates the module once", () => {
      install("pkg", counting("one"));
      const first = loadTargetDescriptor("pkg", project);
      const second = loadTargetDescriptor("pkg", project);
      expect(second).toBe(first);
      expect(loads()).toBe(1);
    });

    it("shares one entry between two fromDirs that resolve to the same file", () => {
      install("pkg", counting("one"));
      const nested = join(project, "apps", "web");
      mkdirSync(nested, { recursive: true });
      expect(loadTargetDescriptor("pkg", nested)).toBe(
        loadTargetDescriptor("pkg", project),
      );
      expect(loads()).toBe(1);
    });

    it("keeps separate entries for separate resolved paths", () => {
      install("pkg", counting("one"));
      const other = realpathSync(
        mkdtempSync(join(tmpdir(), "mx-target-loader-")),
      );
      try {
        writeFileSync(join(other, "package.json"), "{}");
        const dir = join(other, "node_modules", "pkg");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "pkg", main: "index.js" }),
        );
        writeFileSync(join(dir, "index.js"), counting("two"));
        expect(loadTargetDescriptor("pkg", project).pending).toBe("one");
        expect(loadTargetDescriptor("pkg", other).pending).toBe("two");
        expect(loads()).toBe(2);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("reloads when the package's package.json mtime changes, and only then", () => {
      const file = install("pkg", counting("one"));
      const manifest = join(dirname(file), "package.json");
      const first = loadTargetDescriptor("pkg", project);

      // Edited source with the manifest untouched: still the cached object. A
      // host package is installed, not edited, so the entry is not re-read.
      writeFileSync(file, counting("two"));
      expect(loadTargetDescriptor("pkg", project)).toBe(first);
      expect(loads()).toBe(1);

      // A new install bumps the manifest mtime: the entry file is re-evaluated.
      const later = new Date(Date.now() + 60_000);
      utimesSync(manifest, later, later);
      const second = loadTargetDescriptor("pkg", project);
      expect(second).not.toBe(first);
      expect(second.pending).toBe("two");
      expect(loads()).toBe(2);
      expect(loadTargetDescriptor("pkg", project)).toBe(second);
    });

    it("on a manifest mtime change, re-evaluates the package's internal modules too", () => {
      const entry = install(
        "pkg",
        `const v = require("./v.js");
         module.exports = { default: { descriptorVersion: 0, name: "pkg-target", packageName: "pkg", pending: v } };`,
      );
      const dir = dirname(entry);
      const internal = join(dir, "v.js");
      writeFileSync(internal, `module.exports = "v1";`);
      const first = loadTargetDescriptor("pkg", project);
      expect(first.pending).toBe("v1");

      // Only the internal file changes; the entry file is untouched.
      writeFileSync(internal, `module.exports = "v2";`);
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "package.json"), later, later);
      expect(loadTargetDescriptor("pkg", project).pending).toBe("v2");
    });

    it("evicts only the entry when the nearest manifest is the project's own, so the project's modules keep their identity", () => {
      // A local target has no manifest of its own, so the nearest one above
      // it is the project's. The prefix must not become the project root,
      // or every module under it — node_modules included — is dropped and the
      // next load gets a second copy of each.
      const dir = join(project, "targets");
      mkdirSync(dir, { recursive: true });
      const dep = join(project, "node_modules", "dep");
      mkdirSync(dep, { recursive: true });
      writeFileSync(
        join(dep, "package.json"),
        JSON.stringify({ name: "dep", main: "index.js" }),
      );
      writeFileSync(
        join(dep, "index.js"),
        `globalThis.__mxDep = (globalThis.__mxDep ?? 0) + 1; module.exports = 1;`,
      );
      // A project-owned module is not protected by the node_modules rule:
      // only the choice of prefix keeps it.
      writeFileSync(
        join(project, "shared.js"),
        `globalThis.__mxShared = (globalThis.__mxShared ?? 0) + 1; module.exports = 1;`,
      );
      const local = (marker: string) =>
        `require("dep"); require("../shared.js"); module.exports = { default: { descriptorVersion: 0, name: "local", packageName: "local", pending: "${marker}" } };`;
      writeFileSync(join(dir, "vue.js"), local("one"));
      const first = loadTargetDescriptor("./targets/vue.js", project);
      expect(first.pending).toBe("one");

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(project, "package.json"), later, later);
      writeFileSync(join(dir, "vue.js"), local("two"));
      const second = loadTargetDescriptor("./targets/vue.js", project);
      expect(second).not.toBe(first);
      expect(second.pending).toBe("two");
      expect((globalThis as { __mxDep?: number }).__mxDep).toBe(1);
      expect((globalThis as { __mxShared?: number }).__mxShared).toBe(1);
      delete (globalThis as { __mxDep?: number }).__mxDep;
      delete (globalThis as { __mxShared?: number }).__mxShared;
    });

    it("evicts only the entry when the nearest manifest is above fromDir", () => {
      const dir = join(project, "targets");
      mkdirSync(dir, { recursive: true });
      const dep = join(project, "node_modules", "dep");
      mkdirSync(dep, { recursive: true });
      writeFileSync(
        join(dep, "package.json"),
        JSON.stringify({ name: "dep", main: "index.js" }),
      );
      writeFileSync(
        join(dep, "index.js"),
        `globalThis.__mxDep = (globalThis.__mxDep ?? 0) + 1; module.exports = 1;`,
      );
      writeFileSync(
        join(dir, "vue.js"),
        `require("dep"); module.exports = { default: { descriptorVersion: 0, name: "local", packageName: "local", pending: "one" } };`,
      );
      const nested = join(project, "apps", "web");
      mkdirSync(nested, { recursive: true });
      // The manifest is neither fromDir nor below it: it is above it, and it
      // is still the project's own, so only the entry is evicted.
      expect(loadTargetDescriptor("../../targets/vue.js", nested).pending).toBe(
        "one",
      );

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(project, "package.json"), later, later);
      loadTargetDescriptor("../../targets/vue.js", nested);
      expect((globalThis as { __mxDep?: number }).__mxDep).toBe(1);
      delete (globalThis as { __mxDep?: number }).__mxDep;
    });

    it("keeps another package that sits in a nested node_modules below the package directory", () => {
      const entry = install("pkg", `require("dep"); ${counting("one")}`);
      const dir = dirname(entry);
      const nested = join(dir, "node_modules", "dep");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(nested, "package.json"),
        JSON.stringify({ name: "dep", main: "index.js" }),
      );
      writeFileSync(
        join(nested, "index.js"),
        `globalThis.__mxNested = (globalThis.__mxNested ?? 0) + 1; module.exports = 1;`,
      );
      expect(loadTargetDescriptor("pkg", project).pending).toBe("one");

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "package.json"), later, later);
      writeFileSync(entry, `require("dep"); ${counting("two")}`);
      expect(loadTargetDescriptor("pkg", project).pending).toBe("two");
      expect((globalThis as { __mxNested?: number }).__mxNested).toBe(1);
      delete (globalThis as { __mxNested?: number }).__mxNested;
    });

    it("keeps a sibling package whose directory shares the prefix", () => {
      const file = install("pkg", counting("a1"));
      install("pkg-other", counting("b1"));
      const first = loadTargetDescriptor("pkg", project);
      expect(first.pending).toBe("a1");
      const sibling = loadTargetDescriptor("pkg-other", project);
      expect(sibling.pending).toBe("b1");

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dirname(file), "package.json"), later, later);
      writeFileSync(file, counting("a2"));
      expect(loadTargetDescriptor("pkg", project).pending).toBe("a2");
      expect(loadTargetDescriptor("pkg-other", project)).toBe(sibling);
      expect(sibling.pending).toBe("b1");
      expect(loads()).toBe(3);
    });

    it("drops its own cached entries for the package it evicts, so the two caches agree", () => {
      const dir = join(project, "node_modules", "pkg");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "pkg", main: "index.js" }),
      );
      const counter = (key: string) =>
        `globalThis.${key} = (globalThis.${key} ?? 0) + 1; module.exports = globalThis.${key};`;
      writeFileSync(join(dir, "v.js"), counter("__mxV"));
      writeFileSync(join(dir, "w.js"), counter("__mxW"));
      const entry = (internal: string) =>
        `const n = require("./${internal}.js");
         module.exports = { default: { descriptorVersion: 0, name: "pkg-target", packageName: "pkg", pending: String(n), load: () => require("./${internal}.js") } };`;
      writeFileSync(join(dir, "index.js"), entry("v"));
      writeFileSync(join(dir, "other.js"), entry("w"));
      const INDEX = "./node_modules/pkg/index.js";
      const OTHER = "./node_modules/pkg/other.js";
      const index1 = loadTargetDescriptor(INDEX, project);
      const other1 = loadTargetDescriptor(OTHER, project);
      expect(index1.pending).toBe("1");
      expect(other1.pending).toBe("1");

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "package.json"), later, later);
      const index2 = loadTargetDescriptor(INDEX, project);
      expect(index2).not.toBe(index1);
      expect(index2.pending).toBe("2");
      const other2 = loadTargetDescriptor(OTHER, project);
      expect(other2).not.toBe(other1);
      expect(other2.pending).toBe("2");

      // The other entry's reload must not have evicted the index entry that
      // was just loaded: the loader serves index2 from its own cache, so its
      // internal module has to still be the one it was loaded with.
      expect(loadTargetDescriptor(INDEX, project)).toBe(index2);
      expect(index2.load?.(core)).toBe(2);
      expect(other2.load?.(core)).toBe(2);
      delete (globalThis as { __mxV?: number }).__mxV;
      delete (globalThis as { __mxW?: number }).__mxW;
    });

    it("forgets the cached descriptor when a reload fails, so the next call does not evict the package again", () => {
      const file = install(
        "pkg",
        `require("./v.js"); module.exports = { default: ${"{"} descriptorVersion: 0, name: "pkg-target", packageName: "pkg" ${"}"} };`,
      );
      const dir = dirname(file);
      writeFileSync(
        join(dir, "v.js"),
        `globalThis.__mxV = (globalThis.__mxV ?? 0) + 1; module.exports = globalThis.__mxV;`,
      );
      expect(loadTargetDescriptor("pkg", project).pending).toBeUndefined();
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "package.json"), later, later);
      writeFileSync(
        file,
        `require("./v.js"); throw new Error("still broken");`,
      );
      // Re-evaluating on every call after a failure is by design; what must not
      // happen is the stale entry driving an eviction on top of it.
      expect(loadError("pkg", project).code).toBe("load-failed");
      expect((globalThis as { __mxV?: number }).__mxV).toBe(2);
      expect(loadError("pkg", project).code).toBe("load-failed");
      expect((globalThis as { __mxV?: number }).__mxV).toBe(2);
      delete (globalThis as { __mxV?: number }).__mxV;
    });

    it("loads a repaired target after an upgrade broke it", () => {
      // Green on Node with or without the load-failed purge: Node drops a
      // module whose evaluation threw. Bun keeps a failed ESM-syntax module in
      // its registry and re-throws it until `require.cache[path]` is deleted,
      // so this only pins the purge on Bun (see the round 5 report).
      const file = install("pkg", counting("one"));
      expect(loadTargetDescriptor("pkg", project).pending).toBe("one");
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dirname(file), "package.json"), later, later);
      writeFileSync(file, `throw new Error("boom");`);
      expect(loadError("pkg", project).code).toBe("load-failed");
      writeFileSync(file, counting("fixed"));
      expect(loadTargetDescriptor("pkg", project).pending).toBe("fixed");
    });

    it("does not serve a stale descriptor after a failed reload, even when the manifest mtime returns to the cached one", () => {
      const dir = join(project, "targets");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "vue.js");
      const body = (marker: string) =>
        `module.exports = { default: { descriptorVersion: 0, name: "local", packageName: "local", pending: "${marker}" } };`;
      writeFileSync(target, body("one"));
      const manifest = join(project, "package.json");
      const original = statSync(manifest).mtimeMs / 1000;
      expect(loadTargetDescriptor("./targets/vue.js", project).pending).toBe(
        "one",
      );

      const later = new Date(Date.now() + 60_000);
      utimesSync(manifest, later, later);
      writeFileSync(target, `throw new Error("broken");`);
      expect(loadError("./targets/vue.js", project).code).toBe("load-failed");

      utimesSync(manifest, original, original);
      expect(loadError("./targets/vue.js", project).code).toBe("load-failed");
    });

    it("forgets the cached descriptor when a reload is invalid", () => {
      const file = install(
        "pkg",
        `require("./v.js"); module.exports = { default: ${"{"} descriptorVersion: 0, name: "pkg-target", packageName: "pkg" ${"}"} };`,
      );
      const dir = dirname(file);
      writeFileSync(
        join(dir, "v.js"),
        `globalThis.__mxV = (globalThis.__mxV ?? 0) + 1; module.exports = globalThis.__mxV;`,
      );
      expect(loadTargetDescriptor("pkg", project).name).toBe("pkg-target");
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "package.json"), later, later);
      writeFileSync(
        file,
        `require("./v.js"); module.exports = { default: { nope: true } };`,
      );
      expect(loadError("pkg", project).code).toBe("invalid-descriptor");
      expect((globalThis as { __mxV?: number }).__mxV).toBe(2);
      expect(loadError("pkg", project).code).toBe("invalid-descriptor");
      expect((globalThis as { __mxV?: number }).__mxV).toBe(2);
      delete (globalThis as { __mxV?: number }).__mxV;
    });

    it("leaves modules outside the package directory cached when it reloads", () => {
      const shared = join(project, "shared.js");
      writeFileSync(
        shared,
        `globalThis.__mxShared = (globalThis.__mxShared ?? 0) + 1; module.exports = 1;`,
      );
      const entry = install(
        "pkg",
        `require(${JSON.stringify(shared)}); ${counting("one")}`,
      );
      loadTargetDescriptor("pkg", project);
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dirname(entry), "package.json"), later, later);
      writeFileSync(
        entry,
        `require(${JSON.stringify(shared)}); ${counting("two")}`,
      );
      expect(loadTargetDescriptor("pkg", project).pending).toBe("two");
      expect((globalThis as { __mxShared?: number }).__mxShared).toBe(1);
      delete (globalThis as { __mxShared?: number }).__mxShared;
    });

    it("does not cache a failure: the next load retries", () => {
      const file = install("pkg", `throw new Error("not yet");`);
      expect(loadError("pkg", project).code).toBe("load-failed");
      writeFileSync(file, counting("fixed"));
      expect(loadTargetDescriptor("pkg", project).pending).toBe("fixed");
    });

    it("does not cache an invalid descriptor either", () => {
      const file = install(
        "pkg",
        `module.exports = { default: { descriptorVersion: 0 } };`,
      );
      expect(loadError("pkg", project).code).toBe("invalid-descriptor");
      writeFileSync(file, counting("fixed"));
      const manifest = join(dirname(file), "package.json");
      const later = new Date(Date.now() + 60_000);
      utimesSync(manifest, later, later);
      expect(loadTargetDescriptor("pkg", project).pending).toBe("fixed");
    });

    it("clearTargetDescriptorCache drops entries", () => {
      install("pkg", counting("one"));
      const first = loadTargetDescriptor("pkg", project);
      clearTargetDescriptorCache();
      expect(loadTargetDescriptor("pkg", project)).not.toBe(first);
    });
  });
});
