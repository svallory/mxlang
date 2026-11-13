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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILD_CACHE_FORMAT,
  type CacheKeyInputs,
  cacheKey,
  compilerCliInput,
  projectCacheEntry,
  toolIdentity,
} from "./build-cache.ts";
import {
  APP_ERROR,
  BROKEN,
  CASE_TIMEOUT_MS,
  CLEAN,
  mxTscIn,
  type Run,
  refsFixture,
  scratch,
  setBody,
  setTemplate,
  solutionFixture,
  templateErrors,
  unlinkProjects,
} from "./build-uptodate-support.ts";
import { buildPassCounters } from "./index.ts";

/**
 * The `-b` template pass's sidecar cache (`build-cache.ts`). A hit is proven
 * by the seam counters (`buildPassCounters`: the per-project program and the
 * Angular checker), never by timing; every miss is shown by its counters and
 * by the new output it prints. Integration cases share one scratch copy per
 * describe and run in order, each leaving the project settled for the next
 * (the watch test files' pattern); `beforeAll` makes the cold run, so `-t` on
 * any case works.
 */

const typescript = createRequire(import.meta.url)(
  "typescript",
) as typeof import("typescript");

interface Pass extends Run {
  compiles: number;
  checkers: number;
}

async function pass(cwd: string, args: string[]): Promise<Pass> {
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

describe("mx-tsc -b template cache: ng-build-refs", () => {
  let dir: string;
  let app: string;
  let cold: Pass;
  beforeAll(async () => {
    dir = scratch(refsFixture);
    app = join(dir, "app");
    cold = await pass(app, ["-b", "."]);
  }, CASE_TIMEOUT_MS);

  it(
    "a no-change second run replays both projects: no program, no checker, the same output; --force bypasses and rewrites",
    async () => {
      expect(cold.status).toBe(0);
      expect(cold.output).toBe("");
      expect([cold.compiles, cold.checkers]).toEqual([2, 2]);
      expect(existsSync(sidecar(dir, "lib"))).toBe(true);
      expect(existsSync(sidecar(dir, "app"))).toBe(true);

      const warm = await pass(app, ["-b", "."]);
      expect([warm.compiles, warm.checkers]).toEqual([0, 0]);
      expect(warm.status).toBe(0);
      expect(warm.output).toBe(cold.output);

      const forced = await pass(app, ["-b", "--force", "."]);
      expect([forced.compiles, forced.checkers]).toEqual([2, 2]);
      expect(forced.output).toBe("");
      const after = await pass(app, ["-b", "."]);
      expect([after.compiles, after.checkers]).toEqual([0, 0]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a broken template is stored and replayed with its exact text; fixing the .ng.mx text is a miss",
    async () => {
      setTemplate(dir, "app", BROKEN);
      const broken = await pass(app, ["-b", "."]);
      // lib is a hit; app's own text changed.
      expect([broken.compiles, broken.checkers]).toEqual([1, 1]);
      expect(broken.status).toBe(1);
      expect(templateErrors(broken.output)).toEqual([APP_ERROR]);
      expect(broken.output).toContain(
        "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.",
      );

      const replay = await pass(app, ["-b", "."]);
      expect([replay.compiles, replay.checkers]).toEqual([0, 0]);
      expect(replay.status).toBe(1);
      expect(replay.output).toBe(broken.output);

      setTemplate(dir, "app", CLEAN);
      const fixed = await pass(app, ["-b", "."]);
      expect([fixed.compiles, fixed.checkers]).toEqual([1, 1]);
      expect(fixed.status).toBe(0);
      expect(fixed.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "package.json mx.angular, and a nearer package.json created later, are inputs",
    async () => {
      setTemplate(dir, "app", BROKEN);
      expect(templateErrors((await pass(app, ["-b", "."])).output)).toEqual([
        APP_ERROR,
      ]);

      editJson(join(app, "package.json"), (json) => {
        json.mx = { angular: { diagnostics: "off" } };
      });
      const off = await pass(app, ["-b", "."]);
      expect(off.compiles).toBe(1);
      expect(off.output).toBe("");
      expect(off.status).toBe(0);

      editJson(join(app, "package.json"), (json) => {
        delete json.mx;
      });
      const on = await pass(app, ["-b", "."]);
      expect(on.compiles).toBe(1);
      expect(templateErrors(on.output)).toEqual([APP_ERROR]);
      expect((await pass(app, ["-b", "."])).compiles).toBe(0);

      writeFileSync(
        join(app, "src", "package.json"),
        JSON.stringify({
          name: "nearer",
          mx: { angular: { diagnostics: "off" } },
        }),
      );
      const nearer = await pass(app, ["-b", "."]);
      expect(nearer.compiles).toBe(1);
      expect(nearer.output).toBe("");
      expect(nearer.status).toBe(0);
      rmSync(join(app, "src", "package.json"));
      setTemplate(dir, "app", CLEAN);
      expect((await pass(app, ["-b", "."])).status).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "the tsconfig and its extends parent are inputs (angularCompilerOptions)",
    async () => {
      setTemplate(dir, "app", NULLISH);
      writeFileSync(
        join(app, "tsconfig.base.json"),
        JSON.stringify({
          angularCompilerOptions: {
            extendedDiagnostics: {
              checks: { nullishCoalescingNotNullable: "suppress" },
            },
          },
        }),
      );
      editJson(join(app, "tsconfig.json"), (json) => {
        json.extends = "./tsconfig.base.json";
      });
      const suppressed = await pass(app, ["-b", "."]);
      expect(suppressed.compiles).toBe(1);
      expect(suppressed.output).toBe("");

      // Only the parent changes.
      writeFileSync(join(app, "tsconfig.base.json"), "{}");
      const parent = await pass(app, ["-b", "."]);
      expect(parent.compiles).toBe(1);
      expect(parent.output).toContain(`app.component.ng.mx(5,18): ${NG8102}`);
      const replay = await pass(app, ["-b", "."]);
      expect(replay.compiles).toBe(0);
      expect(replay.output).toBe(parent.output);

      // Only the tsconfig itself changes.
      editJson(join(app, "tsconfig.json"), (json) => {
        json.angularCompilerOptions = {
          extendedDiagnostics: {
            checks: { nullishCoalescingNotNullable: "suppress" },
          },
        };
      });
      const own = await pass(app, ["-b", "."]);
      expect(own.compiles).toBe(1);
      expect(own.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "an empty, truncated, wrong-format or wrong-key sidecar is a miss and is rewritten",
    async () => {
      expect((await pass(app, ["-b", "."])).compiles).toBe(0);
      const valid = JSON.parse(readFileSync(sidecar(dir, "app"), "utf8"));
      const corrupt: [string, string][] = [
        ["", ""],
        ["truncated", JSON.stringify(valid).slice(0, 40)],
        [
          "wrong format",
          JSON.stringify({ ...valid, format: BUILD_CACHE_FORMAT + 1 }),
        ],
        ["wrong key", JSON.stringify({ ...valid, key: "0".repeat(64) })],
      ];
      for (const [name, text] of corrupt) {
        writeFileSync(sidecar(dir, "app"), text);
        const run = await pass(app, ["-b", "."]);
        expect(run.compiles, name).toBe(1);
        expect(run.status, name).toBe(0);
        expect(run.output, name).toBe("");
        expect(
          JSON.parse(readFileSync(sidecar(dir, "app"), "utf8")),
          name,
        ).toEqual(valid);
      }
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
      const roots = [join(dir, "lib"), join(dir, "app")];
      const cold = await pass(dir, ["-b", ...roots]);
      expect(cold.output).toBe("");
      expect(cold.compiles).toBe(2);
      expect((await pass(dir, ["-b", ...roots])).compiles).toBe(0);

      // Nothing app reads changes: only lib's own tsconfig.
      editJson(join(dir, "lib", "tsconfig.json"), (json) => {
        json.compilerOptions.removeComments = true;
      });
      const after = await pass(dir, ["-b", ...roots]);
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
      const component = join(dir, "lib", "src", "lib.component.ng.mx");
      setBody(component, NULLISH);
      const model = join(dir, "lib", "src", "model.ts");

      const cold = await pass(dir, ["-b", "."]);
      expect(cold.status).toBe(0);
      expect(cold.output).toContain(`lib.component.ng.mx(6,18): ${NG8102}`);
      expect((await pass(dir, ["-b", "."])).compiles).toBe(0);

      // Nullable now: the template's `??` is needed, and the warning goes.
      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\n",
      );
      const typed = await pass(dir, ["-b", "."]);
      expect(typed.compiles).toBeGreaterThan(0);
      expect(typed.output).toBe("");

      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\nexport const unused = 1;\n",
      );
      const body = await pass(dir, ["-b", "."]);
      expect(body.compiles).toBeGreaterThan(0);
      expect(body.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );
});

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
    configInputs: [
      { path: "/p/package.json", text: "{}" },
      { path: "/p/src/package.json", text: null },
    ],
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

  it("is SHA-256 hex, the same for the same inputs", () => {
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...base })).toBe(cacheKey(base));
  });

  const variants: [string, Partial<CacheKeyInputs>][] = [
    ["format number (row 9)", { format: 2 }],
    ["tool bytes (row 7)", { tool: "tool2" }],
    ["typescript version (row 6)", { typescriptVersion: "6.0.4" }],
    ["fileInfos (row 1)", { fileInfos: [{ version: "v2" }] }],
    [
      ".ng.mx text (row 3)",
      { mxFiles: [{ path: "/p/src/a.ng.mx", text: "b" }] },
    ],
    [
      "a probed manifest appears (row 4)",
      {
        configInputs: [
          { path: "/p/package.json", text: "{}" },
          { path: "/p/src/package.json", text: "{}" },
        ],
      },
    ],
    ["previous key (row 8)", { previous: "k" }],
    ["position (row 8)", { position: 1 }],
    ["claimed files", { claimed: ["/q/b.ng.mx"] }],
    ["--astro", { astro: true }],
  ];
  it.each(variants)("changes with %s", (_name, change) => {
    expect(cacheKey({ ...base, ...change })).not.toBe(cacheKey(base));
  });

  it("changes with the compiler-cli version, its package.json realpath and the checker's typescript (row 5)", () => {
    const fake = (version: string, packageJson: string) => () => ({
      status: "ok" as const,
      version,
      module: {} as never,
      packageJson,
    });
    const ts = (version: string) => () => ({
      status: "ok" as const,
      version,
      module: {} as never,
    });
    const input = (version: string, packageJson: string, tsVersion: string) =>
      compilerCliInput("/p", {
        resolveCompilerCli: fake(version, packageJson),
        resolveTypescript: ts(tsVersion),
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

  it("names the tool by the bytes of this module and its externals", () => {
    expect(toolIdentity()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("build-cache project entry (inputs read from disk)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const noCli = {
    resolveCompilerCli: () => ({ status: "missing" as const, message: "m" }),
  };

  /** A composite project with one `.ng.mx` and a hand-written build info. */
  function project(buildInfo?: object) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-build-cache-")));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "out"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { composite: true, outDir: "out" } }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
    writeFileSync(join(dir, "src", "a.ng.mx"), "a");
    writeFileSync(
      join(dir, "out", "tsconfig.tsbuildinfo"),
      JSON.stringify(
        buildInfo ?? {
          version: typescript.version,
          fileNames: ["../src/a.ng.mx"],
          fileInfos: [{ version: "v1", signature: "s1" }],
        },
      ),
    );
    const entry = () =>
      projectCacheEntry(typescript, {
        tsconfigPath: join(dir, "tsconfig.json"),
        rootNames: [join(dir, "src", "a.ng.mx")],
        astro: false,
        tool: "tool",
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

  it.each([
    [
      "the .ng.mx text (row 3, a build info older than the file)",
      (dir: string) => writeFileSync(join(dir, "src", "a.ng.mx"), "b"),
    ],
    [
      "package.json mx.host (row 4)",
      (dir: string) =>
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "p", mx: { host: "angular" } }),
        ),
    ],
    [
      "a nearer package.json created later (row 4)",
      (dir: string) => writeFileSync(join(dir, "src", "package.json"), "{}"),
    ],
    [
      "an mx config file created later (row 4)",
      (dir: string) => writeFileSync(join(dir, ".mxrc.json"), '{"angular":{}}'),
    ],
    [
      "the tsconfig bytes (row 2)",
      (dir: string) =>
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { composite: true, outDir: "out" },
            angularCompilerOptions: { strictTemplates: false },
          }),
        ),
    ],
    [
      "the build info's fileInfos (row 1)",
      (dir: string) =>
        writeFileSync(
          join(dir, "out", "tsconfig.tsbuildinfo"),
          JSON.stringify({
            version: typescript.version,
            fileNames: ["../src/a.ng.mx"],
            fileInfos: [{ version: "v2", signature: "s1" }],
          }),
        ),
    ],
  ])("changes with %s", (_name, change) => {
    const { dir, entry } = project();
    const before = entry()?.key;
    expect(before).toBeDefined();
    change(dir);
    expect(entry()?.key).not.toBe(before);
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
  ])("is not cacheable with %s", (_name, buildInfo) => {
    expect(project(buildInfo).entry()).toBeUndefined();
  });
});
