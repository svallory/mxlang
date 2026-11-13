import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_CACHE_FORMAT,
  buildPassCounters,
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
import {
  APP_ERROR,
  BROKEN,
  CASE_TIMEOUT_MS,
  mxTscIn,
  mxTscSpawn,
  type Run,
  refsFixture,
  scratch,
  setBody,
  setTemplate,
  solutionFixture,
  templateErrors,
  unlinkProjects,
} from "./build-uptodate-support.ts";

/**
 * The `-b` template pass's sidecar cache (`build-cache.ts`). A hit is proven
 * by the seam counters (`buildPassCounters`: the per-project program and the
 * Angular checker), never by timing; every miss is shown by its counters and
 * by the new output it prints. Each integration case works on its own scratch
 * copy and makes its own cold run, so cases are independent of order.
 */

const typescript = createRequire(import.meta.url)(
  "typescript",
) as typeof import("typescript");

interface Pass extends Run {
  compiles: number;
  checkers: number;
}

async function pass(cwd: string, args: string[] = ["-b", "."]): Promise<Pass> {
  buildPassCounters.compileProjectNgMx = 0;
  buildPassCounters.createChecker = 0;
  const run = await mxTscIn(cwd, args);
  return {
    ...run,
    compiles: buildPassCounters.compileProjectNgMx,
    checkers: buildPassCounters.createChecker,
  };
}

const sidecar = (dir: string, project: "lib" | "app") =>
  join(dir, project, "out", "tsconfig.tsbuildinfo.mx-ng.json");

interface Json {
  compilerOptions: Record<string, unknown>;
  [key: string]: unknown;
}

const editJson = (file: string, edit: (json: Json) => void) => {
  const json = JSON.parse(readFileSync(file, "utf8")) as Json;
  edit(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
const NULLISH = '<p>${user.name ?? "x"}</p>';
const NG8102 = "warning TS-998102: NG8102:";
const SUPPRESS_NG8102 = {
  extendedDiagnostics: { checks: { nullishCoalescingNotNullable: "suppress" } },
};

describe("mx-tsc -b template cache: ng-build-refs", () => {
  it(
    "a no-change run replays both projects (no program, no checker, same output); a broken template is stored and replayed with its exact text; a truncated sidecar is a miss and is rewritten; --force bypasses",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      const cold = await pass(app);
      expect(cold.status).toBe(0);
      expect(cold.output).toBe("");
      expect([cold.compiles, cold.checkers]).toEqual([2, 2]);
      expect(existsSync(sidecar(dir, "lib"))).toBe(true);

      const warm = await pass(app);
      expect([warm.compiles, warm.checkers]).toEqual([0, 0]);
      expect(warm.status).toBe(0);
      expect(warm.output).toBe("");

      setTemplate(dir, "app", BROKEN);
      const broken = await pass(app);
      // lib is a hit; app's own text changed.
      expect([broken.compiles, broken.checkers]).toEqual([1, 1]);
      expect(broken.status).toBe(1);
      expect(templateErrors(broken.output)).toEqual([APP_ERROR]);
      expect(broken.output).toContain(
        "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.",
      );

      const replay = await pass(app);
      expect([replay.compiles, replay.checkers]).toEqual([0, 0]);
      expect(replay.status).toBe(1);
      expect(replay.output).toBe(broken.output);

      const valid = readFileSync(sidecar(dir, "app"), "utf8");
      writeFileSync(sidecar(dir, "app"), valid.slice(0, 40));
      const truncated = await pass(app);
      expect([truncated.compiles, truncated.checkers]).toEqual([1, 1]);
      expect(truncated.output).toBe(broken.output);
      expect(readFileSync(sidecar(dir, "app"), "utf8")).toBe(valid);

      const forced = await pass(app, ["-b", "--force", "."]);
      expect([forced.compiles, forced.checkers]).toEqual([2, 2]);
      expect(forced.output).toBe(broken.output);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "package.json mx.angular, and a nearer package.json created later, are inputs",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      expect(templateErrors((await pass(app)).output)).toEqual([APP_ERROR]);

      const manifest = join(app, "package.json");
      const original = readFileSync(manifest, "utf8");
      editJson(manifest, (json) => {
        json.mx = { angular: { diagnostics: "off" } };
      });
      const off = await pass(app);
      expect(off.compiles).toBe(1);
      expect(off.output).toBe("");
      expect(off.status).toBe(0);

      // Back to the cold run's manifest; only a nearer one is new.
      writeFileSync(manifest, original);
      writeFileSync(
        join(app, "src", "package.json"),
        JSON.stringify({
          name: "nearer",
          mx: { angular: { diagnostics: "off" } },
        }),
      );
      const nearer = await pass(app);
      expect(nearer.compiles).toBe(1);
      expect(nearer.output).toBe("");
      expect(nearer.status).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "the tsconfig and its extends parent are inputs (angularCompilerOptions)",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", NULLISH);
      writeFileSync(
        join(app, "tsconfig.base.json"),
        JSON.stringify({ angularCompilerOptions: SUPPRESS_NG8102 }),
      );
      editJson(join(app, "tsconfig.json"), (json) => {
        json.extends = "./tsconfig.base.json";
      });
      expect((await pass(app)).output).toBe("");

      // Only the parent changes.
      writeFileSync(join(app, "tsconfig.base.json"), "{}");
      const parent = await pass(app);
      expect(parent.compiles).toBe(1);
      expect(parent.output).toContain(`app.component.ng.mx(5,18): ${NG8102}`);

      // Only the tsconfig itself changes.
      editJson(join(app, "tsconfig.json"), (json) => {
        json.angularCompilerOptions = SUPPRESS_NG8102;
      });
      const own = await pass(app);
      expect(own.compiles).toBe(1);
      expect(own.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a project whose pass printed a host-policy warning is not stored, and prints it again",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      editJson(join(app, "package.json"), (json) => {
        json.mx = { host: "bogus" };
      });
      const first = await pass(app);
      const policy = first.output
        .split("\n")
        .filter((line) => line.includes("warning TS80003"));
      expect(policy).toEqual([
        expect.stringContaining('warning TS80003: unknown mx.host "bogus"'),
      ]);
      expect(existsSync(sidecar(dir, "app"))).toBe(false);
      expect(existsSync(sidecar(dir, "lib"))).toBe(true);

      const second = await pass(app);
      expect(second.compiles).toBe(1);
      expect(second.output).toBe(first.output);
      expect(existsSync(sidecar(dir, "app"))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a run whose TypeScript pass failed stores nothing",
    async () => {
      const dir = scratch(refsFixture);
      writeFileSync(
        join(dir, "lib", "src", "extra.ts"),
        'export const x: number = "s";\n',
      );
      const run = await pass(join(dir, "app"));
      expect(run.output).toContain("error TS2322");
      expect(run.status).not.toBe(0);
      expect(existsSync(sidecar(dir, "lib"))).toBe(false);
      expect(existsSync(sidecar(dir, "app"))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("mx-tsc -b template cache: the built binary", () => {
  it(
    "dist/bin.cjs stores both projects' answers and replays them on the next run",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      const cold = await mxTscSpawn(app, ["-b", "."]);
      expect(templateErrors(cold.output)).toEqual([APP_ERROR]);
      expect(existsSync(sidecar(dir, "lib"))).toBe(true);
      expect(existsSync(sidecar(dir, "app"))).toBe(true);

      // Only a replay can print what the stored answer says.
      const stored = JSON.parse(readFileSync(sidecar(dir, "app"), "utf8"));
      for (const report of stored.ngResult.reports) {
        for (const d of report.diagnostics)
          d.message = "replayed from the sidecar";
      }
      writeFileSync(sidecar(dir, "app"), JSON.stringify(stored));
      const warm = await mxTscSpawn(app, ["-b", "."]);
      expect(warm.status).toBe(1);
      expect(warm.output).toContain("replayed from the sidecar");
      expect(warm.output).not.toContain("'nmae'");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("mx-tsc -b template cache: ownership chain", () => {
  it(
    "a change to an earlier project makes a later one with an overlapping include a miss",
    async () => {
      const dir = scratch(refsFixture);
      unlinkProjects(dir);
      editJson(join(dir, "app", "tsconfig.json"), (json) => {
        json.include = ["src", "../lib/src"];
        json.compilerOptions.rootDir = "..";
      });
      const roots = ["-b", join(dir, "lib"), join(dir, "app")];
      const cold = await pass(dir, roots);
      expect(cold.output).toBe("");
      expect(cold.compiles).toBe(2);
      expect((await pass(dir, roots)).compiles).toBe(0);

      // Nothing app reads changes: only lib's own tsconfig.
      editJson(join(dir, "lib", "tsconfig.json"), (json) => {
        json.compilerOptions.removeComments = true;
      });
      const after = await pass(dir, roots);
      expect(after.compiles).toBe(2);
      expect(after.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("mx-tsc -b template cache: ng-build-solution", () => {
  it(
    "a .ts file the component imports is an input: a type change and a body-only change are misses",
    async () => {
      const dir = scratch(solutionFixture);
      // The fixture's lib lists only `.ts` (TS6307); a failed tsc pass
      // disables the cache, so list the templates too.
      editJson(join(dir, "lib", "tsconfig.json"), (json) => {
        json.include = ["src"];
      });
      setBody(join(dir, "lib", "src", "lib.component.ng.mx"), NULLISH);
      const model = join(dir, "lib", "src", "model.ts");

      const cold = await pass(dir);
      expect(cold.status).toBe(0);
      expect(cold.output).toContain(`lib.component.ng.mx(6,18): ${NG8102}`);
      expect((await pass(dir)).compiles).toBe(0);

      // Nullable now: the template's `??` is needed, and the warning goes.
      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\n",
      );
      const typed = await pass(dir);
      expect(typed.compiles).toBeGreaterThan(0);
      expect(typed.output).toBe("");

      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\nexport const unused = 1;\n",
      );
      const body = await pass(dir);
      expect(body.compiles).toBeGreaterThan(0);
      expect(body.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );
});

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
      "package.json": JSON.stringify({ name: "@t/a", version: "1.0.0" }),
      "index.js": "a 1",
      "side.cjs": "side 1",
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
      JSON.stringify({ name: "@t/a", version: "1.0.1" }),
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

  it.each([
    ["an external that does not resolve", "node_modules/@t/b"],
    ["a sibling that is missing", "node_modules/@t/a/side.cjs"],
  ])("is undefined for %s", (_name, path) => {
    const { identity, at } = tool();
    expect(identity()).toBeDefined();
    rmSync(at(path), { recursive: true });
    expect(identity()).toBeUndefined();
  });

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

  it("is not cacheable with an MX config module (its imports are no input)", () => {
    const { dir, entry } = project();
    expect(entry()).toBeDefined();
    writeFileSync(join(dir, "mx.config.cjs"), "module.exports = {};\n");
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
