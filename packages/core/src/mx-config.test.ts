import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetPolicyDetailed } from "./host-policy.ts";
import {
  clearMxConfigCache,
  findMxConfig,
  isMxConfigFile,
  MX_CONFIG_SEARCH_PLACES,
  moduleLoadMessage,
  mxConfigSearchPaths,
  provideMxConfig,
} from "./mx-config.ts";
import { clearPackageJsonCache } from "./package-json.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { createTargetLookup, type TargetLookup } from "./target-descriptor.ts";
import { dialectProject } from "./test-dialect-project.ts";

/**
 * A fixture lookup (core names no real target): a hostless default target
 * and two hosted ones, so `mx.host` and `mx.target` can agree or disagree.
 */
const lookup: TargetLookup = createTargetLookup(
  [
    {
      descriptorVersion: 0,
      name: "page",
      packageName: "@t/page",
      defaultTag: "node",
      legacyHostValues: [{ value: "page" }],
    },
    {
      descriptorVersion: 0,
      name: "view-jsx",
      packageName: "@t/view",
      defaultTag: "node",
      host: { name: "view" },
    },
    {
      descriptorVersion: 0,
      name: "unit-jsx",
      packageName: "@t/unit",
      defaultTag: "node",
      host: { name: "unit" },
    },
  ],
  { defaultTarget: "page" },
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  clearMxConfigCache();
  clearPackageJsonCache();
  clearScanCache();
});

/** A fresh project directory holding `files` (relative path to text). */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-config-")));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Rewrites `path` and moves its mtime, so a same-millisecond edit still reads as one. */
function edit(root: string, path: string, text: string, tick = 1): void {
  write(root, path, text);
  const when = new Date(Date.now() + tick * 2000);
  utimesSync(join(root, path), when, when);
}

/** The policy and diagnostics of `<root>/src/App.mx`, with `root` shown as `<root>`. */
function policyOf(root: string, file = "src/App.mx") {
  const { policy, diagnostics } = resolveTargetPolicyDetailed(
    join(root, file),
    lookup,
    { quiet: true },
  );
  return JSON.parse(
    JSON.stringify({ policy, diagnostics }).replaceAll(root, "<root>"),
  ) as { policy: Record<string, unknown>; diagnostics: unknown[] };
}

const PACKAGE = JSON.stringify({ name: "app" });

describe("MX_CONFIG_SEARCH_PLACES spells out cosmiconfig's defaults", () => {
  it("equals cosmiconfig 10's getDefaultSearchPlaces plus the extra spellings", async () => {
    // The list is hardcoded so importing core loads no cosmiconfig (the
    // cold-start guard); this pin fails loudly if the pinned cosmiconfig
    // (10.0.1, exact) ever changes its defaults.
    const cosmiconfig = (await import("cosmiconfig")) as unknown as {
      getDefaultSearchPlaces: (name: string) => string[];
    };
    expect(MX_CONFIG_SEARCH_PLACES.slice(0, -5)).toEqual(
      cosmiconfig.getDefaultSearchPlaces("mx"),
    );
    expect(MX_CONFIG_SEARCH_PLACES.slice(-5)).toEqual([
      "mx.config.mts",
      "mx.config.cts",
      "mx.config.json",
      "mx.config.yaml",
      "mx.config.yml",
    ]);
  });
});

describe("findMxConfig: where MX's config comes from", () => {
  it("answers undefined with no config, and the policy is the default with nothing said", () => {
    const root = project({ "package.json": PACKAGE, "src/App.mx": "" });
    expect(findMxConfig(join(root, "src"))).toBeUndefined();
    expect(policyOf(root)).toEqual({
      policy: { target: "page" },
      diagnostics: [],
    });
  });

  it("answers the same as before for a package.json#mx alone", () => {
    const text = `{\n  "name": "app",\n  "mx": { "target": "view-jsx", "strict": true }\n}\n`;
    const root = project({ "package.json": text });
    const source = findMxConfig(join(root, "src"));
    expect(source?.file).toBe(join(root, "package.json"));
    expect(source?.format).toBe("package.json");
    expect(source?.config).toEqual({ target: "view-jsx", strict: true });
    expect(source?.locate(["target"])).toEqual({
      line: 3,
      column: 20,
      length: 10,
    });
    expect(policyOf(root)).toEqual({
      policy: { target: "view-jsx", host: "view", strict: true },
      diagnostics: [],
    });
  });

  it.each([
    ["mx.config.json", `{\n  "target": "view-jsx"\n}\n`],
    ["mx.config.yaml", "# MX\ntarget: view-jsx\n"],
    ["mx.config.yml", "target: view-jsx\n"],
    [".mxrc", "target: view-jsx\n"],
    [".mxrc.json", `{ "target": "view-jsx" }`],
    [".config/mxrc.json", `{ "target": "view-jsx" }`],
    ["mx.config.cjs", `module.exports = { target: "view-jsx" };\n`],
    ["mx.config.js", `module.exports = { target: "view-jsx" };\n`],
    ["mx.config.mjs", `export default { target: "view-jsx" };\n`],
    [
      "mx.config.ts",
      `const config: { target: string } = { target: "view-jsx" };\nexport default config;\n`,
    ],
  ])("loads %s", (place, text) => {
    const root = project({ "package.json": PACKAGE, [place]: text });
    const source = findMxConfig(join(root, "src"));
    expect(source?.file).toBe(join(root, place));
    expect(source?.dir).toBe(root);
    expect(source?.error).toBeUndefined();
    expect(source?.config).toEqual({ target: "view-jsx" });
    expect(policyOf(root).policy).toEqual({ target: "view-jsx", host: "view" });
  });

  it("prefers package.json#mx over a config file in the same directory (cosmiconfig's order)", () => {
    const root = project({
      "package.json": JSON.stringify({ mx: { target: "unit-jsx" } }),
      "mx.config.json": `{ "target": "view-jsx" }`,
      ".mxrc.json": `{ "target": "page" }`,
    });
    expect(findMxConfig(root)?.file).toBe(join(root, "package.json"));
    expect(policyOf(root).policy).toEqual({ target: "unit-jsx", host: "unit" });
  });

  it("prefers .mxrc.* over mx.config.* in one directory, and names the file it hides", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "view-jsx" }`,
      ".mxrc.json": `{ "target": "unit-jsx" }`,
    });
    const source = findMxConfig(root);
    expect(source?.file).toBe(join(root, ".mxrc.json"));
    expect(source?.shadowed).toEqual([join(root, "mx.config.json")]);
    expect(policyOf(root)).toEqual({
      policy: { target: "unit-jsx", host: "unit" },
      diagnostics: [
        {
          code: "shadowed-config",
          severity: "warning",
          file: "<root>/mx.config.json",
          message:
            "<root>/mx.config.json is not read: <root>/.mxrc.json is this project's MX config, and one file serves the project; move these settings there, or delete this file",
          line: 1,
          column: 0,
        },
      ],
    });
  });

  it("warns at an mx.config.* that package.json#mx hides", () => {
    const root = project({
      "package.json": JSON.stringify({ mx: { target: "unit-jsx" } }),
      "mx.config.json": `{ "target": "view-jsx" }`,
    });
    expect(policyOf(root).diagnostics).toEqual([
      {
        code: "shadowed-config",
        severity: "warning",
        file: "<root>/mx.config.json",
        message:
          "<root>/mx.config.json is not read: <root>/package.json is this project's MX config, and one file serves the project; move these settings there, or delete this file",
        line: 1,
        column: 0,
      },
    ]);
  });

  it("ignores a config in a subdirectory: the project's config applies to every file", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "unit-jsx" }`,
      "src/mx.config.json": `{ "target": "view-jsx" }`,
      "src/nested/.mxrc.json": `{ "target": "page" }`,
    });
    for (const dir of [root, join(root, "src"), join(root, "src/nested")]) {
      expect(findMxConfig(dir)?.file).toBe(join(root, "mx.config.json"));
    }
    expect(policyOf(root, "src/nested/App.mx").policy).toEqual({
      target: "unit-jsx",
      host: "unit",
    });
  });

  it("gives every reader the same config for one file: host policy, tag scan, watch list", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "unit-jsx", "tags": "./ui" }`,
      "src/mx.config.json": `{ "target": "view-jsx", "tags": "./other" }`,
      "src/deep/.mxrc.json": `{ "target": "page", "tags": "./other" }`,
      "ui/card.mx": "<div/>\n",
      "other/badge.mx": "<span/>\n",
      "src/deep/App.mx": "",
    });
    const file = join(root, "src/deep/App.mx");
    expect(findMxConfig(dirname(file))?.file).toBe(
      join(root, "mx.config.json"),
    );
    expect(policyOf(root, "src/deep/App.mx").policy).toEqual({
      target: "unit-jsx",
      host: "unit",
    });
    const scan = scanCached(file, { targets: lookup });
    expect([...scan.tags.keys()]).toEqual(["card"]);
    const nested = [
      join(root, "src/mx.config.json"),
      join(root, "src/deep/.mxrc.json"),
    ];
    for (const ignored of nested) {
      expect(scan.configFiles).not.toContain(ignored);
      expect(mxConfigSearchPaths(dirname(file))).not.toContain(ignored);
    }
  });

  it("ignores a subdirectory's config when the project has none", () => {
    const root = project({
      "package.json": PACKAGE,
      "src/mx.config.json": `{ "target": "view-jsx" }`,
    });
    expect(findMxConfig(join(root, "src"))).toBeUndefined();
    expect(policyOf(root, "src/App.mx")).toEqual({
      policy: { target: "page" },
      diagnostics: [],
    });
  });

  it("never reads a config from outside the project (the nearest package.json ends the search)", () => {
    const root = project({
      "mx.config.json": `{ "target": "view-jsx" }`,
      "app/package.json": PACKAGE,
    });
    expect(findMxConfig(join(root, "app/src"))).toBeUndefined();
    expect(policyOf(root, "app/src/App.mx")).toEqual({
      policy: { target: "page" },
      diagnostics: [],
    });
  });

  it("reads no config without a package.json: there is no project", () => {
    const root = project({ "mx.config.json": `{ "target": "view-jsx" }` });
    expect(findMxConfig(root)).toBeUndefined();
  });

  it("hands dialect sections and `extensions` on uninterpreted", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": JSON.stringify({
        target: "view-jsx",
        extensions: { ".mesh": "mesh" },
        mesh: { strictModels: true },
        html: { defaultTag: "div" },
      }),
    });
    const source = findMxConfig(root);
    expect(source?.extensions).toEqual({ ".mesh": "mesh" });
    expect(source?.sections).toEqual({
      mesh: { strictModels: true },
      html: { defaultTag: "div" },
    });
  });

  describe("`mx.dialect` is a dialect package's identity, never project config", () => {
    const identity = {
      id: "mesh",
      name: "Mesh",
      extensions: [".mesh.mx"],
      module: "./dist/dialect.js",
    };

    it("loads the settings beside it in package.json#mx unchanged", () => {
      const root = project({
        "package.json": JSON.stringify({
          name: "app",
          mx: {
            dialect: identity,
            target: "view-jsx",
            extensions: { ".page": "mesh" },
            mesh: { strictModels: true },
          },
        }),
      });
      const source = findMxConfig(root);
      expect(source?.config).toEqual({
        target: "view-jsx",
        extensions: { ".page": "mesh" },
        mesh: { strictModels: true },
      });
      expect(source?.extensions).toEqual({ ".page": "mesh" });
      expect(source?.sections).toEqual({ mesh: { strictModels: true } });
      expect(Object.keys(source?.sections ?? {})).not.toContain("dialect");
      expect(policyOf(root).policy).toMatchObject({ target: "view-jsx" });
    });

    it("is dropped from a config file too", () => {
      const root = project({
        "package.json": PACKAGE,
        "mx.config.json": JSON.stringify({
          dialect: identity,
          target: "view-jsx",
        }),
      });
      const source = findMxConfig(root);
      expect(source?.config).toEqual({ target: "view-jsx" });
      expect(source?.sections).toEqual({});
    });

    it("alone in package.json#mx is no config, so an mx.config.* beside it applies", () => {
      const alone = project({
        "package.json": JSON.stringify({
          name: "mesh-dialect",
          mx: { dialect: identity },
        }),
      });
      expect(findMxConfig(alone)).toBeUndefined();

      const beside = project({
        "package.json": JSON.stringify({
          name: "mesh-dialect",
          mx: { dialect: identity },
        }),
        "mx.config.json": JSON.stringify({ target: "unit-jsx" }),
      });
      const source = findMxConfig(beside);
      expect(source?.file).toBe(join(beside, "mx.config.json"));
      expect(source?.config).toEqual({ target: "unit-jsx" });
    });
  });

  it("lists every search place up to the end of the search, for watchers", () => {
    const root = project({ "package.json": PACKAGE });
    const paths = mxConfigSearchPaths(join(root, "src"));
    // A package.json created in src/ would make src/ the project; then the
    // project directory's places, package.json first.
    expect(paths.slice(0, 3)).toEqual([
      join(root, "src/package.json"),
      join(root, "package.json"),
      join(root, ".mxrc"),
    ]);
    expect(paths.length).toBe(MX_CONFIG_SEARCH_PLACES.length + 1);
    expect(paths.at(-1)).toBe(join(root, "mx.config.yml"));
    const root2 = project({
      "package.json": PACKAGE,
      ".mxrc.json": `{ "target": "view-jsx" }`,
    });
    expect(findMxConfig(join(root2, "src"))?.watch.at(-1)).toBe(
      join(root2, ".mxrc.json"),
    );
    expect(isMxConfigFile(join(root, "mx.config.ts"))).toBe(true);
    expect(isMxConfigFile(join(root, ".config/mxrc.yaml"))).toBe(true);
    expect(isMxConfigFile(join(root, "mxrc.yaml"))).toBe(false);
  });
});

describe("why a module config could not be loaded, restated", () => {
  const ESM =
    "MX needs Node 22.12 or later for an ES module config (22.18 or later for TypeScript), or Bun; otherwise write the config as JSON, YAML or CommonJS";

  it("an ES module on a Node that cannot require one (.mjs)", () => {
    const error = Object.assign(
      new Error(
        "require() of ES Module /p/mx.config.mjs not supported.\nInstead change...",
      ),
      { code: "ERR_REQUIRE_ESM" },
    );
    expect(moduleLoadMessage(error, "/p/mx.config.mjs")).toBe(
      `this runtime cannot load an ES module config synchronously (require() of ES Module /p/mx.config.mjs not supported.); ${ESM}`,
    );
  });

  it("ES module syntax read as CommonJS (.js, .ts)", () => {
    for (const file of ["/p/mx.config.js", "/p/mx.config.ts"]) {
      expect(
        moduleLoadMessage(new SyntaxError("Unexpected token 'export'"), file),
      ).toBe(
        `this runtime cannot load an ES module config synchronously (Unexpected token 'export'); ${ESM}`,
      );
    }
  });

  it("TypeScript syntax on a Node that does not strip types", () => {
    expect(
      moduleLoadMessage(
        new SyntaxError("Unexpected token ':'"),
        "/p/mx.config.cts",
      ),
    ).toBe(
      "this runtime cannot load a TypeScript config (Unexpected token ':'); MX needs Node 22.18 or later, or Bun, for one; otherwise write the config as JSON, YAML or CommonJS",
    );
  });

  it("an extensionless relative import names the file it meant", () => {
    const root = project({ "x.ts": "export const x = 1;\n" });
    const error = Object.assign(
      new Error(
        `Cannot find module '${join(root, "x")}' imported from ${join(root, "mx.config.ts")}`,
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(moduleLoadMessage(error, join(root, "mx.config.ts"))).toBe(
      `Cannot find module '${join(root, "x")}' imported from ${join(root, "mx.config.ts")}; Node's ES module loader needs the file extension: ./x.ts`,
    );
  });

  it("anything else keeps the runtime's first line", () => {
    expect(
      moduleLoadMessage(new Error("boom\n    at x"), "/p/mx.config.js"),
    ).toBe("boom");
  });
});

describe("a config that is not an object", () => {
  const SYNC =
    "; MX reads its config synchronously, so export the object itself";
  const NOT_APPLIED =
    '; its settings are not applied until it loads (the target comes from the @mxlang dependencies, or the default "page")';
  const cases: [string, string, string, string, number, number][] = [
    [
      "a function",
      "mx.config.mjs",
      'export default function () {\n  return { target: "view-jsx" };\n}\n',
      `the config must be an object, and it is a function${SYNC}`,
      1,
      0,
    ],
    [
      "an async function",
      "mx.config.mjs",
      'export default async function () {\n  return { target: "view-jsx" };\n}\n',
      `the config must be an object, and it is an async function${SYNC}`,
      1,
      0,
    ],
    [
      "a Promise",
      "mx.config.mjs",
      'export default Promise.resolve({ target: "view-jsx" });\n',
      `the config must be an object, and it is a Promise${SYNC}`,
      1,
      0,
    ],
    [
      "a CommonJS function",
      "mx.config.cjs",
      'module.exports = () => ({ target: "view-jsx" });\n',
      `the config must be an object, and it is a function${SYNC}`,
      1,
      0,
    ],
    [
      "a JSON array",
      "mx.config.json",
      '\n  ["view-jsx"]\n',
      "the config must be an object, and it is an array",
      2,
      2,
    ],
    [
      "a JSON string",
      "mx.config.json",
      '"view-jsx"\n',
      "the config must be an object, and it is a string",
      1,
      0,
    ],
    [
      "JSON null",
      "mx.config.json",
      "null\n",
      "the config must be an object, and it is null",
      1,
      0,
    ],
    [
      "a YAML array",
      "mx.config.yaml",
      "# the target\n- target: view-jsx\n",
      "the config must be an object, and it is an array",
      1,
      0,
    ],
    [
      "a YAML scalar in .mxrc",
      ".mxrc",
      "view-jsx\n",
      "the config must be an object, and it is a string",
      1,
      0,
    ],
  ];

  it.each(cases)(
    "refuses %s at its position, applying none of it",
    (_name, file, text, message, line, column) => {
      const root = project({ "package.json": PACKAGE, [file]: text });
      const source = findMxConfig(root);
      expect(source?.config).toBeUndefined();
      expect(source?.error).toEqual({ message, line, column });
      expect(policyOf(root)).toEqual({
        policy: { target: "page" },
        diagnostics: [
          {
            code: "malformed-config",
            severity: "error",
            file: `<root>/${file}`,
            message: `<root>/${file} could not be loaded: ${message}${NOT_APPLIED}`,
            line,
            column,
          },
        ],
      });
    },
  );

  it("keeps the last good revision in force while the config is not an object", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "view-jsx" }`,
    });
    expect(policyOf(root).policy.target).toBe("view-jsx");
    edit(root, "mx.config.json", `["unit-jsx"]\n`);
    expect(policyOf(root)).toEqual({
      policy: { target: "view-jsx", host: "view" },
      diagnostics: [
        {
          code: "malformed-config",
          severity: "error",
          file: "<root>/mx.config.json",
          message:
            "<root>/mx.config.json could not be loaded: the config must be an object, and it is an array; the last revision that loaded stays in force until this one does",
          line: 1,
          column: 0,
        },
      ],
    });
  });
});

describe("mx.host and mx.target in a config file", () => {
  const config = (body: string) =>
    project({ "package.json": PACKAGE, "mx.config.json": body });

  it("selects the target by mx.target alone", () => {
    expect(policyOf(config(`{ "target": "unit-jsx" }`))).toEqual({
      policy: { target: "unit-jsx", host: "unit" },
      diagnostics: [],
    });
  });

  it("selects the host's default target by mx.host alone", () => {
    expect(policyOf(config(`{ "host": "view" }`))).toEqual({
      policy: { target: "view-jsx", host: "view" },
      diagnostics: [],
    });
  });

  it("takes both when they agree", () => {
    expect(
      policyOf(config(`{ "host": "view", "target": "view-jsx" }`)),
    ).toEqual({
      policy: { target: "view-jsx", host: "view" },
      diagnostics: [],
    });
  });

  it("reports a mismatch at both keys of the config file and hands on mx.target", () => {
    const root = config(`{\n  "host": "view",\n  "target": "unit-jsx"\n}\n`);
    expect(policyOf(root)).toEqual({
      policy: { target: "unit-jsx", host: "unit" },
      diagnostics: [
        {
          code: "target-host-mismatch",
          severity: "error",
          file: "<root>/mx.config.json",
          message:
            'mx.target "unit-jsx" belongs to host "unit", but mx.host is "view". Remove one of them: mx.host "view" selects target "view-jsx"; mx.target "unit-jsx" selects host "unit".',
          line: 3,
          column: 12,
          length: 10,
          relatedInformation: [
            {
              file: "<root>/mx.config.json",
              message: 'mx.host "view" selects target "view-jsx".',
              line: 2,
              column: 10,
              length: 6,
            },
          ],
        },
      ],
    });
  });

  it("applies the same rule in YAML, positioned at the YAML keys' values", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.yaml": "host: view\ntarget: unit-jsx\n",
    });
    const { diagnostics } = policyOf(root);
    expect(diagnostics).toMatchObject([
      {
        code: "target-host-mismatch",
        file: "<root>/mx.config.yaml",
        line: 2,
        column: 8,
        relatedInformation: [{ line: 1, column: 6 }],
      },
    ]);
  });

  it("reports an unknown mx.target in a config file at its value", () => {
    const root = config(`{\n  "target": "nope"\n}\n`);
    expect(policyOf(root).diagnostics).toEqual([
      {
        code: "unknown-target",
        severity: "error",
        value: "nope",
        file: "<root>/mx.config.json",
        message:
          'unknown mx.target "nope"; valid targets: page, view-jsx, unit-jsx. Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.',
        line: 2,
        column: 12,
        length: 6,
      },
    ]);
  });

  it("reports a module config's problems at the file's start", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.cjs": `module.exports = { target: "nope" };\n`,
    });
    expect(policyOf(root).diagnostics).toMatchObject([
      {
        code: "unknown-target",
        file: "<root>/mx.config.cjs",
        line: 1,
        column: 0,
      },
    ]);
  });
});

describe("provideMxConfig: a config passed in", () => {
  it("replaces the file search under its root until it is removed", () => {
    const root = project({
      "package.json": JSON.stringify({ mx: { target: "unit-jsx" } }),
    });
    provideMxConfig(root, { target: "view-jsx" }, { file: "mesh.config.ts" });
    const source = findMxConfig(join(root, "src/deep"));
    expect(source).toMatchObject({
      file: "mesh.config.ts",
      dir: root,
      format: "provided",
      config: { target: "view-jsx" },
    });
    expect(policyOf(root).policy).toEqual({ target: "view-jsx", host: "view" });
    provideMxConfig(root, undefined);
    expect(policyOf(root).policy).toEqual({ target: "unit-jsx", host: "unit" });
  });

  it("names its root in diagnostics when no file is given", () => {
    const root = project({});
    provideMxConfig(root, { target: "nope" });
    expect(policyOf(root).diagnostics).toMatchObject([
      { code: "unknown-target", file: "<root>", line: 1, column: 0 },
    ]);
  });
});

describe("a long-lived reader", () => {
  it("picks up an edit without a restart", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "view-jsx" }`,
    });
    expect(policyOf(root).policy.target).toBe("view-jsx");
    edit(root, "mx.config.json", `{ "target": "unit-jsx" }`);
    expect(policyOf(root).policy.target).toBe("unit-jsx");
  });

  it("picks up a CommonJS config's edit without a restart", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.cjs": `module.exports = { target: "view-jsx" };\n`,
    });
    expect(policyOf(root).policy.target).toBe("view-jsx");
    edit(root, "mx.config.cjs", `module.exports = { target: "unit-jsx" };\n`);
    expect(policyOf(root).policy.target).toBe("unit-jsx");
  });

  it("picks up a config file created after the first read", () => {
    const root = project({ "package.json": PACKAGE });
    expect(policyOf(root).policy.target).toBe("page");
    write(root, "mx.config.yaml", "target: unit-jsx\n");
    expect(policyOf(root).policy.target).toBe("unit-jsx");
  });

  it("keeps the last good revision in force and reports the broken one where it broke", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "target": "view-jsx" }`,
    });
    expect(policyOf(root).policy.target).toBe("view-jsx");
    edit(root, "mx.config.json", `{\n  "target": "unit-jsx",\n}\n`);
    const broken = policyOf(root);
    expect(broken.policy).toEqual({ target: "view-jsx", host: "view" });
    expect(broken.diagnostics).toHaveLength(1);
    const [diagnostic] = broken.diagnostics as {
      message: string;
      line: number;
      column: number;
    }[];
    expect(diagnostic).toMatchObject({
      code: "malformed-config",
      severity: "error",
      file: "<root>/mx.config.json",
      // JavaScriptCore's JSON errors carry no position (bun-jsc-error-line-column).
      ...("bun" in process.versions ? {} : { line: 3, column: 0 }),
    });
    expect(diagnostic?.message).toMatch(
      /^<root>\/mx\.config\.json could not be loaded: .+; the last revision that loaded stays in force until this one does$/,
    );
    edit(root, "mx.config.json", `{ "target": "unit-jsx" }`, 2);
    expect(policyOf(root)).toEqual({
      policy: { target: "unit-jsx", host: "unit" },
      diagnostics: [],
    });
  });

  it("reports a config that never loaded, and applies none of it", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.yaml": "target: [view-jsx\n",
    });
    const { policy, diagnostics } = policyOf(root);
    expect(policy).toEqual({ target: "page" });
    expect(diagnostics).toEqual([
      {
        code: "malformed-config",
        severity: "error",
        file: "<root>/mx.config.yaml",
        message:
          '<root>/mx.config.yaml could not be loaded: deficient indentation; its settings are not applied until it loads (the target comes from the @mxlang dependencies, or the default "page")',
        line: 2,
        column: 0,
      },
    ]);
  });

  it("loads a TypeScript config, and either reloads its edit (Bun) or says a restart applies it (Node)", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.ts": `export default { target: "view-jsx" as string };\n`,
    });
    expect(policyOf(root).policy.target).toBe("view-jsx");
    edit(
      root,
      "mx.config.ts",
      `export default { target: "unit-jsx" as string };\n`,
    );
    const after = policyOf(root);
    if ("bun" in process.versions) {
      expect(after).toEqual({
        policy: { target: "unit-jsx", host: "unit" },
        diagnostics: [],
      });
    } else {
      expect(after).toEqual({
        policy: { target: "view-jsx", host: "view" },
        diagnostics: [
          {
            code: "malformed-config",
            severity: "error",
            file: "<root>/mx.config.ts",
            message:
              "<root>/mx.config.ts could not be loaded: this process cannot reload an ES module config after an edit; restart the tool to apply it (a JSON, YAML or CommonJS config reloads in place); the last revision that loaded stays in force until this one does",
            line: 1,
            column: 0,
          },
        ],
      });
    }
    // Back to the text that last loaded: in force again, with no error.
    edit(
      root,
      "mx.config.ts",
      `export default { target: "view-jsx" as string };\n`,
      2,
    );
    expect(policyOf(root)).toEqual({
      policy: { target: "view-jsx", host: "view" },
      diagnostics: [],
    });
  });

  it("reports a module config that cannot be loaded synchronously at its start", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.mjs": `await Promise.resolve();\nexport default { target: "view-jsx" };\n`,
    });
    const after = policyOf(root);
    if ("bun" in process.versions) {
      // Bun's `require` settles an already-resolved top-level await.
      expect(after.policy).toEqual({ target: "view-jsx", host: "view" });
      return;
    }
    expect(after).toEqual({
      policy: { target: "page" },
      diagnostics: [
        {
          code: "malformed-config",
          severity: "error",
          file: "<root>/mx.config.mjs",
          message:
            '<root>/mx.config.mjs could not be loaded: it uses top-level `await`, and MX reads its config synchronously; remove the top-level `await`, or write the config as JSON or YAML; its settings are not applied until it loads (the target comes from the @mxlang dependencies, or the default "page")',
          line: 1,
          column: 0,
        },
      ],
    });
  });
});

describe("the tag scan reads the same config", () => {
  it("indexes `tags` from a config file, relative to the project root for .config/", () => {
    const root = project({
      "package.json": PACKAGE,
      ".config/mxrc.json": `{ "tags": "./ui" }`,
      "ui/card.mx": "<div/>\n",
      "src/App.mx": "",
    });
    const scan = scanCached(join(root, "src/App.mx"), { targets: lookup });
    expect([...scan.tags.keys()]).toEqual(["card"]);
    expect(scan.configFiles).toContain(join(root, ".config/mxrc.json"));
  });

  it("follows provideMxConfig with the scan already cached", () => {
    const root = project({
      "package.json": PACKAGE,
      "ui/card.mx": "<div/>\n",
      "other/badge.mx": "<span/>\n",
      "src/App.mx": "",
    });
    const file = join(root, "src/App.mx");
    const tags = () => [...scanCached(file, { targets: lookup }).tags.keys()];
    expect(tags()).toEqual([]);
    provideMxConfig(root, { tags: "./ui" });
    expect(tags()).toEqual(["card"]);
    provideMxConfig(root, { tags: "./other" });
    expect(tags()).toEqual(["badge"]);
    provideMxConfig(root, undefined);
    expect(tags()).toEqual([]);
  });

  it("notices a config file created and edited between scans", () => {
    const root = project({
      "package.json": PACKAGE,
      "ui/card.mx": "<div/>\n",
      "other/badge.mx": "<span/>\n",
      "src/App.mx": "",
    });
    const scan = () =>
      [
        ...scanCached(join(root, "src/App.mx"), {
          targets: lookup,
        }).tags.keys(),
      ].sort();
    expect(scan()).toEqual([]);
    write(root, "mx.config.json", `{ "tags": "./ui" }`);
    expect(scan()).toEqual(["card"]);
    edit(root, "mx.config.json", `{ "tags": ["./ui", "./other"] }`);
    expect(scan()).toEqual(["badge", "card"]);
  });

  it("keeps the last good tags while a config revision is broken, with a positioned diagnostic", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{ "tags": "./ui" }`,
      "ui/card.mx": "<div/>\n",
      "src/App.mx": "",
    });
    const options = { targets: lookup };
    expect([
      ...scanCached(join(root, "src/App.mx"), options).tags.keys(),
    ]).toEqual(["card"]);
    edit(root, "mx.config.json", `{ "tags": "./ui",, }`);
    const broken = scanCached(join(root, "src/App.mx"), options);
    expect([...broken.tags.keys()]).toEqual(["card"]);
    expect(broken.diagnostics).toEqual([
      {
        file: join(root, "mx.config.json"),
        message: expect.stringMatching(
          /^`mx\.config\.json` could not be loaded: .+; the previous valid `tags` and `contracts` stay in force$/,
        ),
        line: 1,
        column: expect.any(Number),
      },
    ]);
  });
});

describe("a top-level key that is neither MX's, a target's nor a dialect's", () => {
  const unknown = (key: string) =>
    `\`mx.${key}\` is not a setting: MX's config holds MX's own keys (target, host, strict, tags, contracts, data, extensions), a target's or host's settings under its name, and a dialect's settings under its id, and no dialect among this project's dependencies has the id \`${key}\``;
  const error = (file: string, key: string, line: number, column: number) => ({
    code: "unknown-config-key",
    severity: "error",
    file,
    message: unknown(key),
    line,
    column,
  });

  it("is an error at its key in package.json#mx", () => {
    const root = project({
      "package.json": `{\n  "name": "app",\n  "mx": {\n    "target": "page",\n    "mesh": { "strictModels": true }\n  }\n}\n`,
    });
    expect(policyOf(root)).toEqual({
      policy: { target: "page" },
      diagnostics: [error("<root>/package.json", "mesh", 5, 4)],
    });
  });

  it.each([
    [
      "mx.config.json",
      `{\n  "target": "page",\n  "pgae": { "defaultTag": "div" }\n}\n`,
      "pgae",
      [3, 2],
    ],
    [
      "mx.config.yaml",
      "target: page\nmesh:\n  strictModels: true\n",
      "mesh",
      [2, 0],
    ],
  ])("is an error at its key in %s", (name, text, key, [line, column]) => {
    const root = project({ "package.json": PACKAGE, [name]: text });
    expect(policyOf(root).diagnostics).toEqual([
      error(`<root>/${name}`, key, line as number, column as number),
    ]);
  });

  it("MX's keys, a target's or host's block, a discovered dialect's id and `tagRules` are not", () => {
    const root = project({});
    dialectProject(root, {
      mx: {
        target: "view-jsx",
        strict: true,
        extensions: { ".page": "test" },
        page: { defaultTag: "div" },
        "unit-jsx": { defaultTag: "div" },
        unit: { setting: true },
        test: { strictModels: true },
        tagRules: "none",
      },
    });
    expect(policyOf(root).diagnostics).toEqual([]);
  });

  it("a `$` key (`$schema`, `$comment`) is JSON metadata, not a setting", () => {
    const root = project({
      "package.json": PACKAGE,
      "mx.config.json": `{\n  "$schema": "https://example.com/mx.schema.json",\n  "$comment": "x",\n  "target": "page"\n}\n`,
    });
    expect(policyOf(root)).toEqual({
      policy: { target: "page" },
      diagnostics: [],
    });
  });

  it("a dialect package's own `mx.dialect` is not a setting, and its id is a dialect's", () => {
    const root = project({
      "package.json": JSON.stringify({
        name: "own-dialect",
        mx: {
          dialect: {
            id: "own",
            name: "Own",
            extensions: [".own"],
            module: "./index.mjs",
          },
          own: { strictModels: true },
        },
      }),
    });
    expect(policyOf(root).diagnostics).toEqual([]);
  });

  it("says nothing when discovery itself fails: routing reports that", () => {
    const root = project({});
    dialectProject(root, { manifest: { id: "Bad" }, mx: { mesh: {} } });
    expect(policyOf(root).diagnostics).toEqual([]);
  });
});
