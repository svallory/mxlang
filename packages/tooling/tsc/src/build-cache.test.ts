import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_CACHE_FORMAT,
  type CacheKeyInputs,
  cacheKey,
  compilerCliInput,
  descriptorOf,
  mayStore,
  type ProjectCacheEntry,
  projectCacheEntry,
  readStoredAnswer,
  type StoreFacts,
  TOOL_EXTERNALS,
  type ToolExternal,
  toolIdentity,
  writeStoredAnswer,
} from "./build-cache.ts";

/**
 * The `-b` template pass's sidecar cache (`build-cache.ts`), unit by unit:
 * the key, the tool identity, the store rules, the sidecar and the project
 * entry, each over a temp fixture. The whole-build cases over the ng-build
 * fixtures are in `build-cache-build.test.ts` (slow lane).
 */

const typescript = createRequire(import.meta.url)(
  "typescript",
) as typeof import("typescript");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-build-cache-")));
  dirs.push(dir);
  return dir;
}

describe("build-cache key", () => {
  const base: CacheKeyInputs = {
    format: 1,
    tool: "tool",
    typescriptVersion: "6.0.3",
    astro: false,
    tsconfigPath: "/p/tsconfig.json",
    buildInfoPath: "/p/out/tsconfig.tsbuildinfo",
    fileNames: ["../src/a.ng.mx"],
    fileInfos: [{ version: "v1" }],
    configFiles: [{ path: "/p/tsconfig.json", text: "{}" }],
    mxFiles: [{ path: "/p/src/a.ng.mx", text: "a" }],
    configInputs: [{ path: "/p/package.json", text: "{}" }],
    tagInputs: [{ path: "/p/src/tags/", text: null }],
    compilerCli: [
      {
        dir: "/p",
        status: "ok",
        version: "22.1.7",
        packageJson: "/n/@angular/compiler-cli/package.json",
        typescript: "ok:6.0.3",
      },
    ],
    previous: "",
    position: 0,
    claimed: [],
  };

  it("is the same for the same inputs", () => {
    expect(cacheKey({ ...base })).toBe(cacheKey(base));
  });

  const variants: [string, Partial<CacheKeyInputs>][] = [
    ["the format number (row 9)", { format: 2 }],
    ["the typescript version (row 6)", { typescriptVersion: "6.0.4" }],
    ["the position (row 8)", { position: 1 }],
    ["the claimed files", { claimed: ["/q/b.ng.mx"] }],
    ["--astro", { astro: true }],
  ];
  it.each(variants)("changes with %s", (_name, change) => {
    expect(cacheKey({ ...base, ...change })).not.toBe(cacheKey(base));
  });

  it("changes with the compiler-cli version, its package.json realpath and the checker's typescript (row 5)", () => {
    const input = (version: string, packageJson: string, tsVersion: string) =>
      compilerCliInput("/p", {
        resolveCompilerCli: () => ({
          status: "ok" as const,
          version,
          module: {} as never,
          packageJson,
        }),
        resolveTypescript: () => ({
          status: "ok" as const,
          version: tsVersion,
          module: {} as never,
        }),
      });
    const first = input("22.1.7", "/n/a/package.json", "6.0.3");
    expect(first).toEqual({
      dir: "/p",
      status: "ok",
      version: "22.1.7",
      packageJson: "/n/a/package.json",
      typescript: "ok:6.0.3",
    });
    const key = (cli: ReturnType<typeof input>) =>
      cacheKey({ ...base, compilerCli: [cli] });
    expect(key(input("22.1.8", "/n/a/package.json", "6.0.3"))).not.toBe(
      key(first),
    );
    expect(key(input("22.1.7", "/n/b/package.json", "6.0.3"))).not.toBe(
      key(first),
    );
    expect(key(input("22.1.7", "/n/a/package.json", "6.0.4"))).not.toBe(
      key(first),
    );
    const missing = compilerCliInput("/p", {
      resolveCompilerCli: () => ({ status: "missing", message: "m" }),
    });
    expect(missing).toEqual({
      dir: "/p",
      status: "missing",
      version: undefined,
    });
    expect(key(missing)).not.toBe(key(first));
  });
});

describe("build-cache tool identity (row 7)", () => {
  /** mx-tsc as one bundle, an external with a sibling, a manifest-only one. */
  function tool() {
    const dir = tempDir();
    const pkg = (name: string, files: Record<string, string>) => {
      const root = join(dir, "node_modules", name);
      mkdirSync(root, { recursive: true });
      for (const [file, text] of Object.entries(files)) {
        writeFileSync(join(root, file), text);
      }
    };
    writeFileSync(join(dir, "self.cjs"), "self 1");
    pkg("@t/a", {
      "package.json": JSON.stringify({
        name: "@t/a",
        version: "1.0.0",
        dependencies: { "@t/dep": "^3.0.0" },
      }),
      "index.js": "a 1",
      "side.cjs": "side 1",
    });
    pkg("@t/dep", {
      "package.json": JSON.stringify({
        name: "@t/dep",
        version: "3.0.0",
        dependencies: { "@t/sub": "^4.0.0" },
      }),
    });
    pkg("@t/sub", {
      "package.json": JSON.stringify({ name: "@t/sub", version: "4.0.0" }),
    });
    pkg("@t/b", {
      "package.json": JSON.stringify({ name: "@t/b", version: "2.0.0" }),
    });
    const externals: ToolExternal[] = [
      { name: "@t/a", from: "self", siblings: ["side.cjs"] },
      { name: "@t/b", from: "@t/a", manifestOnly: true },
    ];
    const identity = () =>
      toolIdentity({ self: join(dir, "self.cjs"), externals });
    return { identity, at: (path: string) => join(dir, path) };
  }

  it.each([
    ["mx-tsc's own bundle", "self.cjs", "self 2"],
    ["an external's entry", "node_modules/@t/a/index.js", "a 2"],
    [
      "an external's sibling (core's parse layer)",
      "node_modules/@t/a/side.cjs",
      "side 2",
    ],
    [
      "an external's version",
      "node_modules/@t/a/package.json",
      JSON.stringify({
        name: "@t/a",
        version: "1.0.1",
        dependencies: { "@t/dep": "^3.0.0" },
      }),
    ],
    [
      "a runtime dependency's installed version (a lockfile bump)",
      "node_modules/@t/dep/package.json",
      JSON.stringify({
        name: "@t/dep",
        version: "3.0.1",
        dependencies: { "@t/sub": "^4.0.0" },
      }),
    ],
    [
      "a transitive dependency's installed version (a lockfile refresh)",
      "node_modules/@t/sub/package.json",
      JSON.stringify({ name: "@t/sub", version: "4.0.1" }),
    ],
    [
      "a manifest-only external's version (@angular/compiler)",
      "node_modules/@t/b/package.json",
      JSON.stringify({ name: "@t/b", version: "2.0.1" }),
    ],
  ])("changes with the bytes of %s", (_name, file, text) => {
    const { identity, at } = tool();
    const before = identity();
    expect(before).toBeDefined();
    writeFileSync(at(file), text);
    expect(identity()).not.toBe(before);
  });

  it("is undefined for an external that does not resolve", () => {
    const { identity, at } = tool();
    expect(identity()).toBeDefined();
    rmSync(at("node_modules/@t/b"), { recursive: true });
    expect(identity()).toBeUndefined();
  });

  it.each([
    ["a sibling", "node_modules/@t/a/side.cjs"],
    ["a dependency", "node_modules/@t/dep"],
  ])(
    "counts %s that is gone as an input, not as uncacheable",
    (_name, path) => {
      const { identity, at } = tool();
      const before = identity();
      expect(before).toBeDefined();
      rmSync(at(path), { recursive: true });
      const after = identity();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    },
  );

  it("run from source, counts every non-test .ts file beside and below mx-tsc's module, fixtures and dot-directories aside", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    for (const file of ["self.ts", "deep/other.ts", "x.test.ts"]) {
      writeFileSync(join(dir, "src", file), file);
    }
    const identity = () =>
      toolIdentity({ self: join(dir, "src", "self.ts"), externals: [] });
    const before = identity();
    expect(before).toBeDefined();
    writeFileSync(join(dir, "src", "x.test.ts"), "edited");
    // A test's scratch project or a fixture beside the sources is no code.
    for (const sub of ["fixtures/p", ".tmp-x"]) {
      mkdirSync(join(dir, "src", sub), { recursive: true });
      writeFileSync(join(dir, "src", sub, "y.ts"), "y");
    }
    expect(identity()).toBe(before);
    writeFileSync(join(dir, "src", "deep", "other.ts"), "edited");
    expect(identity()).not.toBe(before);
  });

  it("run from source, counts where each file sits, not only its name and bytes", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src", "a"), { recursive: true });
    mkdirSync(join(dir, "src", "b"));
    writeFileSync(join(dir, "src", "self.ts"), "self");
    writeFileSync(join(dir, "src", "a", "x.ts"), "x");
    const identity = () =>
      toolIdentity({ self: join(dir, "src", "self.ts"), externals: [] });
    const before = identity();
    expect(before).toBeDefined();
    rmSync(join(dir, "src", "a", "x.ts"));
    writeFileSync(join(dir, "src", "b", "x.ts"), "x");
    expect(identity()).not.toBe(before);
  });

  it("run from source, follows an extensionless, an index and a second-level import outside src/", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "plugin", "deep"), { recursive: true });
    writeFileSync(
      join(dir, "src", "self.ts"),
      'import { paths } from "../plugin/paths";\n',
    );
    writeFileSync(
      join(dir, "plugin", "paths.ts"),
      'export { deep as paths } from "./deep";\n',
    );
    writeFileSync(
      join(dir, "plugin", "deep", "index.ts"),
      "export const deep = 1;",
    );
    const identity = () =>
      toolIdentity({ self: join(dir, "src", "self.ts"), externals: [] });
    const before = identity();
    expect(before).toBeDefined();
    writeFileSync(
      join(dir, "plugin", "deep", "index.ts"),
      "export const deep = 2;",
    );
    expect(identity()).not.toBe(before);
  });

  it("run from source, follows a .js specifier to its .ts source and a require() outside src/", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "plugin"));
    writeFileSync(
      join(dir, "src", "self.ts"),
      'import { a } from "../plugin/a.js";\nconst b = require("../plugin/b.ts");\n',
    );
    writeFileSync(join(dir, "plugin", "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "plugin", "b.ts"), "export const b = 1;");
    const identity = () =>
      toolIdentity({ self: join(dir, "src", "self.ts"), externals: [] });
    const first = identity();
    writeFileSync(join(dir, "plugin", "a.ts"), "export const a = 2;");
    const second = identity();
    writeFileSync(join(dir, "plugin", "b.ts"), "export const b = 2;");
    expect(new Set([first, second, identity()]).size).toBe(3);
  });

  it("run from source, counts a module a relative import reaches outside src/", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "plugin"));
    writeFileSync(
      join(dir, "src", "self.ts"),
      'import { paths } from "../plugin/paths.ts";\n',
    );
    writeFileSync(join(dir, "plugin", "paths.ts"), "export const paths = 1;");
    const identity = () =>
      toolIdentity({ self: join(dir, "src", "self.ts"), externals: [] });
    const before = identity();
    expect(before).toBeDefined();
    writeFileSync(join(dir, "plugin", "paths.ts"), "export const paths = 2;");
    expect(identity()).not.toBe(before);
  });

  it("covers core's parse layer, the element table and @angular/compiler, and resolves here", () => {
    expect(
      TOOL_EXTERNALS.map(({ name, from, siblings, manifestOnly }) => [
        name,
        from,
        siblings ?? [],
        manifestOnly ?? false,
      ]),
    ).toEqual([
      ["@mxlang/angular-checker", "self", [], false],
      ["@mxlang/host-angular", "self", [], false],
      ["@mxlang/typescript-plugin", "self", [], false],
      [
        "@mxlang/core",
        "@mxlang/typescript-plugin",
        ["marko-frontend.cjs"],
        false,
      ],
      ["@mxlang/tsx-bridge", "@mxlang/typescript-plugin", [], false],
      ["@mxlang/web-elements", "@mxlang/host-angular", [], false],
      ["@angular/compiler", "@mxlang/host-angular", [], true],
    ]);
    expect(toolIdentity()).toBeDefined();
  });
});

describe("build-cache descriptor import", () => {
  const descriptor = { descriptorVersion: 1, name: "angular" };
  it.each([
    ["the descriptor itself", descriptor],
    ["an ESM namespace", { default: descriptor }],
    [
      "a CommonJS interop wrapper",
      { __esModule: true, default: { default: descriptor } },
    ],
  ])("finds the descriptor in %s", (_name, module) => {
    expect(descriptorOf(module)).toBe(descriptor);
  });

  it("throws for a module without one", () => {
    expect(() => descriptorOf({ default: {} })).toThrow(/no descriptor/);
  });
});

describe("build-cache store rules", () => {
  const storable: StoreFacts = {
    projectErrors: 0,
    ambientErrors: 0,
    compileDiagnostics: 0,
    policyDiagnostics: 0,
    compiled: ["/p/a.ng.mx"],
    listed: ["/p/a.ng.mx"],
    diagnosticsOff: false,
  };

  it("stores a pass that printed nothing but template diagnostics", () => {
    expect(mayStore(storable)).toBe(true);
  });

  it.each<[string, Partial<StoreFacts>]>([
    ["a project-level error", { projectErrors: 1 }],
    ["an ambient-types error", { ambientErrors: 1 }],
    ["an MX compile diagnostic", { compileDiagnostics: 1 }],
    ["a host-policy diagnostic", { policyDiagnostics: 1 }],
    ["Angular diagnostics off", { diagnosticsOff: true }],
    [
      "a compiled file the build info does not list",
      { compiled: ["/p/a.ng.mx", "/p/b.ng.mx"] },
    ],
    [
      "a listed file the program did not compile",
      { listed: ["/p/a.ng.mx", "/p/b.ng.mx"] },
    ],
  ])("does not store with %s", (_name, change) => {
    expect(mayStore({ ...storable, ...change })).toBe(false);
  });
});

describe("build-cache sidecar", () => {
  const result = {
    reports: [
      {
        fileName: "/p/a.ng.mx",
        source: "a",
        diagnostics: [
          {
            start: 0,
            length: 1,
            code: 2339,
            message: "m",
            category: "error" as const,
            source: "angular" as const,
            mapped: "exact" as const,
          },
        ],
      },
    ],
    errors: [],
    warnings: ["w"],
  };
  function stored(): ProjectCacheEntry {
    const entry = {
      key: "k",
      sidecar: join(tempDir(), "s.json"),
      ngFiles: ["/p/a.ng.mx"],
    };
    writeStoredAnswer(entry, ["/p/a.ng.mx"], result as never);
    return entry;
  }

  it("reads back what it wrote", () => {
    expect(readStoredAnswer(stored(), new Set())).toEqual({
      format: BUILD_CACHE_FORMAT,
      key: "k",
      ownedFiles: ["/p/a.ng.mx"],
      ngResult: result,
    });
  });

  it.each<[string, (text: string) => string]>([
    ["empty", () => ""],
    ["truncated", (text) => text.slice(0, 40)],
    [
      "of another format",
      (text) =>
        JSON.stringify({ ...JSON.parse(text), format: BUILD_CACHE_FORMAT + 1 }),
    ],
    [
      "under another key",
      (text) => JSON.stringify({ ...JSON.parse(text), key: "other" }),
    ],
    [
      "holding a project-level error",
      (text) => {
        const json = JSON.parse(text);
        json.ngResult.errors = ["e"];
        return JSON.stringify(json);
      },
    ],
    [
      "with a malformed report",
      (text) => {
        const json = JSON.parse(text);
        json.ngResult.reports[0].diagnostics[0].start = "0";
        return JSON.stringify(json);
      },
    ],
  ])("is a miss when %s", (_name, corrupt) => {
    const entry = stored();
    writeFileSync(entry.sidecar, corrupt(readFileSync(entry.sidecar, "utf8")));
    expect(readStoredAnswer(entry, new Set())).toBeUndefined();
  });

  it("is a miss when the files it owned are no longer the ones it would own", () => {
    expect(readStoredAnswer(stored(), new Set(["/p/a.ng.mx"]))).toBeUndefined();
  });

  it("swallows a write into a directory that does not exist", () => {
    const entry = {
      key: "k",
      sidecar: join(tempDir(), "no", "s.json"),
      ngFiles: [],
    };
    expect(() => writeStoredAnswer(entry, [], result as never)).not.toThrow();
    expect(readStoredAnswer(entry, new Set())).toBeUndefined();
  });
});

describe("build-cache project entry (inputs read from disk)", () => {
  const noCli = {
    resolveCompilerCli: () => ({ status: "missing" as const, message: "m" }),
  };

  /** A composite project with one `.ng.mx` and a hand-written build info. */
  function project(buildInfo?: object) {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "out"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { composite: true, outDir: "out" } }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
    const info = buildInfo ?? {
      version: typescript.version,
      fileNames: ["../src/a.ng.mx"],
      fileInfos: [{ version: "v1", signature: "s1" }],
    };
    // Every listed file exists, so a row fails only on its own reason.
    for (const name of (info as { fileNames?: string[] }).fileNames ?? []) {
      writeFileSync(
        join(dir, "out", name),
        name === "../src/a.ng.mx" ? "a" : "",
      );
    }
    writeFileSync(join(dir, "src", "a.ng.mx"), "a");
    writeFileSync(
      join(dir, "out", "tsconfig.tsbuildinfo"),
      JSON.stringify(info),
    );
    const entry = () =>
      projectCacheEntry(typescript, {
        tsconfigPath: join(dir, "tsconfig.json"),
        rootNames: [join(dir, "src", "a.ng.mx")],
        astro: false,
        tool: () => "tool",
        previous: "",
        position: 0,
        claimed: new Set(),
        deps: noCli,
      });
    return { dir, entry };
  }

  it("reads the key and the .ng.mx files from the build info; the sidecar sits beside it", () => {
    const { dir, entry } = project();
    expect(entry()).toEqual({
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      sidecar: join(dir, "out", "tsconfig.tsbuildinfo.mx-ng.json"),
      ngFiles: [join(dir, "src", "a.ng.mx")],
    });
  });

  it.each<[string, (dir: string) => void]>([
    [
      "the .ng.mx text (row 3, a build info older than the file)",
      (dir) => writeFileSync(join(dir, "src", "a.ng.mx"), "b"),
    ],
    [
      "package.json mx.host (row 4)",
      (dir) =>
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "p", mx: { host: "angular" } }),
        ),
    ],
    [
      "an MX config file created later (row 4)",
      (dir) => writeFileSync(join(dir, ".mxrc.json"), '{"angular":{}}'),
    ],
    [
      "a nearer tag file created later",
      (dir) => {
        mkdirSync(join(dir, "src", "tags"));
        writeFileSync(join(dir, "src", "tags", "card.mx"), "<p/>");
      },
    ],
  ])("changes with %s", (_name, change) => {
    const { dir, entry } = project();
    const before = entry()?.key;
    expect(before).toBeDefined();
    change(dir);
    expect(entry()?.key).not.toBe(before);
  });

  it.each([
    ["a tag file's bytes", "card.mx"],
    [
      "the bytes of a file under a tag directory the scan does not index",
      "notes.txt",
    ],
  ])("changes with %s", (_name, file) => {
    const { dir, entry } = project();
    mkdirSync(join(dir, "tags"));
    writeFileSync(join(dir, "tags", "card.mx"), "<p/>");
    writeFileSync(join(dir, "tags", "notes.txt"), "1");
    const before = entry()?.key;
    expect(before).toBeDefined();
    writeFileSync(join(dir, "tags", file), "<div/>");
    expect(entry()?.key).not.toBe(before);
  });

  it("rethrows a bug in building the key instead of turning the cache off", () => {
    const { dir } = project();
    expect(() =>
      projectCacheEntry(typescript, {
        tsconfigPath: join(dir, "tsconfig.json"),
        rootNames: [join(dir, "src", "a.ng.mx")],
        astro: false,
        tool: () => {
          throw new TypeError("a key-building bug");
        },
        previous: "",
        position: 0,
        claimed: new Set(),
      }),
    ).toThrow(TypeError);
  });

  it("rethrows a Node ERR_* error (a programming error, not an unreadable input)", () => {
    const { dir } = project();
    const bug = Object.assign(new TypeError("bad argument"), {
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(() =>
      projectCacheEntry(typescript, {
        tsconfigPath: join(dir, "tsconfig.json"),
        rootNames: [join(dir, "src", "a.ng.mx")],
        astro: false,
        tool: () => {
          throw bug;
        },
        previous: "",
        position: 0,
        claimed: new Set(),
      }),
    ).toThrow(bug);
  });

  it("is not cacheable with a build info that is not JSON (an unreadable input)", () => {
    const { dir, entry } = project();
    writeFileSync(join(dir, "out", "tsconfig.tsbuildinfo"), "{");
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with an MX config module (its imports are no input)", () => {
    const { dir, entry } = project();
    expect(entry()).toBeDefined();
    writeFileSync(join(dir, "mx.config.cjs"), "module.exports = {};\n");
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with a JSON MX config that pulls a file in through $import", () => {
    const { dir, entry } = project();
    writeFileSync(join(dir, "shared-mx.json"), JSON.stringify({}));
    writeFileSync(join(dir, ".mxrc.json"), JSON.stringify({ strict: true }));
    expect(entry()).toBeDefined();
    writeFileSync(
      join(dir, ".mxrc.json"),
      JSON.stringify({ $import: "./shared-mx.json", strict: true }),
    );
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with an MX config that fails to load (malformed JSON)", () => {
    const { dir, entry } = project();
    writeFileSync(join(dir, ".mxrc.json"), '{ "strict": true, }');
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with a tag sidecar that imports a linked workspace package", () => {
    const { dir, entry } = project();
    const pkg = (root: string, name: string) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
      writeFileSync(join(root, "index.js"), "exports.v = 1;\n");
    };
    pkg(join(dir, "node_modules", "installed"), "installed");
    pkg(join(dir, "packages", "linked"), "linked");
    symlinkSync(
      join(dir, "packages", "linked"),
      join(dir, "node_modules", "linked"),
    );
    mkdirSync(join(dir, "tags"));
    writeFileSync(
      join(dir, "tags", "card.tag.ts"),
      'import type { T } from "linked";\nimport { v } from "installed";\nexport default { transform: () => v };\n',
    );
    expect(entry()).toBeDefined();
    writeFileSync(
      join(dir, "tags", "card.tag.ts"),
      'import { v } from "linked";\nexport default { transform: () => v };\n',
    );
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with a target given as a specifier (its descriptor module is no input)", () => {
    const { dir, entry } = project();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "p", mx: { target: "angular" } }),
    );
    expect(entry()).toBeDefined();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "p", mx: { target: "./t.js" } }),
    );
    expect(entry()).toBeUndefined();
  });

  it("is not cacheable with a tag sidecar that imports a file outside the tag directories", () => {
    const { dir, entry } = project();
    mkdirSync(join(dir, "tags"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "x.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "tags", "helper.ts"), "export const h = 1;\n");
    writeFileSync(
      join(dir, "tags", "card.tag.ts"),
      'import { h } from "./helper.ts";\nexport default { transform: () => h };\n',
    );
    expect(entry()).toBeDefined();
    writeFileSync(
      join(dir, "tags", "card.tag.ts"),
      'import { x } from "../lib/x.ts";\nexport default { transform: () => x };\n',
    );
    expect(entry()).toBeUndefined();
  });

  it.each([
    [
      "another TypeScript's build info",
      {
        version: "5.0.0",
        fileNames: ["../src/a.ng.mx"],
        fileInfos: [{ version: "v" }],
      },
    ],
    [
      "no fileInfos (a non-incremental -b build info)",
      { version: typescript.version, root: ["../src/a.ng.mx"] },
    ],
    [
      "fileInfos of another length",
      {
        version: typescript.version,
        fileNames: ["../src/a.ng.mx"],
        fileInfos: [],
      },
    ],
    [
      "a root file it does not list",
      { version: typescript.version, fileNames: [], fileInfos: [] },
    ],
    [
      "a file kind the key does not cover",
      {
        version: typescript.version,
        fileNames: ["../src/a.ng.mx", "../src/b.probe"],
        fileInfos: [{ version: "v" }, { version: "w" }],
      },
    ],
    [
      "another host's region file beside the .ng.mx (its tag scan is not the Angular one)",
      {
        version: typescript.version,
        fileNames: ["../src/a.ng.mx", "../src/b.solid.mx"],
        fileInfos: [{ version: "v" }, { version: "w" }],
      },
    ],
    [
      "an .astro.mx file",
      {
        version: typescript.version,
        fileNames: ["../src/a.ng.mx", "../src/b.astro.mx"],
        fileInfos: [{ version: "v" }, { version: "w" }],
      },
    ],
    [
      "a dialect's .mx file",
      {
        version: typescript.version,
        fileNames: ["../src/a.ng.mx", "../src/b.probe.mx"],
        fileInfos: [{ version: "v" }, { version: "w" }],
      },
    ],
  ])("is not cacheable with %s", (_name, buildInfo) => {
    expect(project(buildInfo).entry()).toBeUndefined();
  });
});
