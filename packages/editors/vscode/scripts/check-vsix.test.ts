import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareRequires, checkExtensionRoot, lockedVersions } from "./check-vsix";
import { pluginEntries } from "./plugin-entries";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const tmp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-vsix-test-")));
  dirs.push(dir);
  return dir;
};
const write = (root: string, path: string, contents = "") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};

const BUILD =
  "rm -rf dist && bun build src/index.ts src/ng-worker.ts --outdir dist --target node --format cjs";
const FACTORY = "module.exports = function (m) { return { create() {} }; };";
const PLUGIN = "node_modules/@mxlang/typescript-plugin";

interface Options {
  /** Files of the shipped extension, path to contents. */
  files?: Record<string, string>;
  plugins?: string[];
  /** Plugin `build` script. */
  build?: string;
  /** Whether the plugin's built dist/ exists. */
  built?: boolean;
  /** `name@version` pairs the lockfile pins. */
  locked?: string[];
}

const pkg = (name: string, version: string, main = "index.js") =>
  JSON.stringify({ name, version, main });

/** A healthy extension, overridden per case. */
function fixture(options: Options = {}) {
  const root = tmp();
  const plugins = options.plugins ?? ["@mxlang/typescript-plugin"];
  write(
    root,
    "package.json",
    JSON.stringify({
      contributes: {
        typescriptServerPlugins: plugins.map((name) => ({ name })),
      },
    }),
  );
  const files: Record<string, string> = options.files ?? {
    [`${PLUGIN}/package.json`]: pkg(
      "@mxlang/typescript-plugin",
      "0.0.0",
      "dist/index.cjs",
    ),
    [`${PLUGIN}/dist/index.cjs`]: FACTORY,
    [`${PLUGIN}/dist/ng-worker.cjs`]: "",
    "node_modules/@marko/compiler/package.json": pkg(
      "@marko/compiler",
      "5.42.5",
    ),
    "node_modules/@marko/compiler/index.js": "",
  };
  for (const [path, contents] of Object.entries(files)) {
    write(root, path, contents);
  }

  const pluginDir = tmp();
  write(
    pluginDir,
    "package.json",
    JSON.stringify({ scripts: { build: options.build ?? BUILD } }),
  );
  if (options.built !== false) mkdirSync(join(pluginDir, "dist"));

  const lockfile = join(tmp(), "bun.lock");
  const locked = options.locked ?? ["@marko/compiler@5.42.5"];
  writeFileSync(
    lockfile,
    `{\n  "packages": {\n${locked
      .map((ident) => {
        const name = ident.slice(0, ident.lastIndexOf("@"));
        return `    "${name}": ["${ident}", "", {}, "sha"],`;
      })
      .join("\n")}\n  },\n}\n`,
  );
  return { root, pluginDir, lockfile };
}

const check = (options?: Options) => {
  const { root, pluginDir, lockfile } = fixture(options);
  return checkExtensionRoot(root, { pluginDir, lockfile });
};

describe("checkExtensionRoot", () => {
  it("passes a healthy extension", () => {
    expect(check()).toEqual([]);
  });

  it("fails when the plugin is not shipped (today's main)", () => {
    expect(check({ files: {} })).toEqual([
      expect.stringContaining('"@mxlang/typescript-plugin" does not resolve'),
    ]);
  });

  it("fails when the manifest declares no plugin", () => {
    expect(check({ plugins: [] })).toEqual([
      "package.json declares no typescriptServerPlugins",
    ]);
  });

  it("fails for a declared plugin that is missing even if another resolves", () => {
    const problems = check({
      plugins: ["@mxlang/typescript-plugin", "@mxlang/other"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@mxlang/other");
  });

  describe("plugin entries come from the build script", () => {
    it("fails when an entry the build script declares is not shipped", () => {
      const problems = check({
        build:
          "bun build src/index.ts src/ng-worker.ts src/other.ts --outdir dist",
      });
      expect(problems).toEqual([
        '"@mxlang/typescript-plugin" is missing dist/other.cjs',
      ]);
    });

    it("does not depend on what the built dist/ holds", () => {
      // An empty built dist/ must not make a missing worker pass.
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]: FACTORY,
        },
        locked: [],
      });
      expect(problems).toContain(
        '"@mxlang/typescript-plugin" is missing dist/ng-worker.cjs',
      );
    });

    it("throws, never silently weakens, when the plugin dist/ is missing", () => {
      expect(() => check({ built: false })).toThrow(/dist is missing/);
    });

    it("throws when the build script's entries cannot be read", () => {
      expect(() => check({ build: "tsc" })).toThrow(
        /cannot read the bundle entries/,
      );
    });
  });

  describe("the entry tsserver loads", () => {
    // These depend on the plugin-shape PR (fix/typescript-plugin-cjs-factory):
    // the plugin's build today emits an object, so the real VSIX stays red on
    // the first case until that merges.
    it("fails when the entry exports an object, not a factory function", () => {
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]:
            "exports.default = function () { return { create() {} }; };",
          [`${PLUGIN}/dist/ng-worker.cjs`]: "",
        },
        locked: [],
      });
      expect(problems).toEqual([
        expect.stringContaining("exports object, not a factory function"),
      ]);
    });

    it("fails when the factory does not return { create }", () => {
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]:
            "module.exports = function () { return {}; };",
          [`${PLUGIN}/dist/ng-worker.cjs`]: "",
        },
        locked: [],
      });
      expect(problems).toEqual([
        expect.stringContaining("did not return { create }"),
      ]);
    });

    it("fails when loading the entry throws", () => {
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]: 'throw new Error("boom");',
          [`${PLUGIN}/dist/ng-worker.cjs`]: "",
        },
        locked: [],
      });
      expect(problems).toEqual([
        expect.stringContaining("could not be loaded: boom"),
      ]);
    });
  });

  describe("bare requires in shipped bundles", () => {
    const withIndex = (code: string, extra: Record<string, string> = {}) => ({
      [`${PLUGIN}/package.json`]: pkg(
        "@mxlang/typescript-plugin",
        "0.0.0",
        "dist/index.cjs",
      ),
      [`${PLUGIN}/dist/index.cjs`]: `${FACTORY}\n${code}`,
      [`${PLUGIN}/dist/ng-worker.cjs`]: "",
      ...extra,
    });

    it("fails on a bare require that does not resolve from the bundle", () => {
      const problems = check({
        files: withIndex('function f() { return require2("left-pad"); }'),
        locked: [],
      });
      expect(problems).toEqual([
        expect.stringContaining('requires "left-pad", which does not resolve'),
      ]);
    });

    it("passes a bare require that resolves from the shipped node_modules", () => {
      expect(
        check({
          files: withIndex('require("@marko/compiler")', {
            "node_modules/@marko/compiler/package.json": pkg(
              "@marko/compiler",
              "5.42.5",
            ),
            "node_modules/@marko/compiler/index.js": "",
          }),
        }),
      ).toEqual([]);
    });

    it.each([
      "@angular/compiler-cli",
      "typescript",
      "@astrojs/language-server",
    ])("allows the project-resolved module %s to be absent", (name) => {
      expect(
        check({
          files: withIndex(
            `function f() { return require3("${name}/package.json"); }`,
          ),
          locked: [],
        }),
      ).toEqual([]);
    });

    it.each([
      ["index.cjs", "index"],
      ["ng-worker.cjs", "ng-worker"],
    ])(
      "fails on a plain top-level require of typescript in %s (the HIGH-2 regression)",
      (_label, file) => {
        const base = withIndex("");
        base[`${PLUGIN}/dist/${file}.cjs`] =
          `${file === "index" ? FACTORY : ""}\nfunction f() { require("typescript"); }`;
        const problems = check({ files: base, locked: [] });
        expect(problems).toEqual([
          expect.stringContaining(`dist/${file}.cjs requires "typescript"`),
        ]);
      },
    );

    it.each(["require", "__require"])(
      "fails on a plain %s of @angular/compiler-cli",
      (callee) => {
        const problems = check({
          files: withIndex(
            `function f() { ${callee}("@angular/compiler-cli"); }`,
          ),
          locked: [],
        });
        expect(problems).toEqual([
          expect.stringContaining('requires "@angular/compiler-cli"'),
        ]);
      },
    );

    it("ignores node builtins", () => {
      expect(
        check({
          files: withIndex(
            'require("node:fs"); require("path"); require("fs/promises")',
          ),
          locked: [],
        }),
      ).toEqual([]);
    });
  });

  describe("shipped versions against bun.lock", () => {
    it("fails when a shipped package's version is not pinned", () => {
      const problems = check({ locked: ["@marko/compiler@5.41.0"] });
      expect(problems).toEqual([
        expect.stringContaining(
          "@marko/compiler@5.42.5 is not a version bun.lock pins (5.41.0)",
        ),
      ]);
    });

    it("fails when a shipped package is not in the lockfile at all", () => {
      const problems = check({ locked: [] });
      expect(problems).toEqual([
        expect.stringContaining("not in the lockfile"),
      ]);
    });

    it("accepts any of several locked versions of the same name", () => {
      expect(
        check({ locked: ["@marko/compiler@5.41.0", "@marko/compiler@5.42.5"] }),
      ).toEqual([]);
    });

    it("checks packages nested under another package's node_modules", () => {
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]: FACTORY,
          [`${PLUGIN}/dist/ng-worker.cjs`]: "",
          "node_modules/a/package.json": pkg("a", "1.0.0"),
          "node_modules/a/node_modules/b/package.json": pkg("b", "2.0.0"),
        },
        locked: ["a@1.0.0"],
      });
      expect(problems).toEqual([expect.stringContaining("b@2.0.0")]);
    });
  });

  it.each(["@angular/compiler-cli", "typescript"])(
    "fails when %s is shipped",
    (name) => {
      const problems = check({
        files: {
          [`${PLUGIN}/package.json`]: pkg(
            "@mxlang/typescript-plugin",
            "0.0.0",
            "dist/index.cjs",
          ),
          [`${PLUGIN}/dist/index.cjs`]: FACTORY,
          [`${PLUGIN}/dist/ng-worker.cjs`]: "",
          [`node_modules/${name}/package.json`]: pkg(name, "1.0.0"),
        },
        locked: [`${name}@1.0.0`],
      });
      expect(problems).toEqual([
        expect.stringContaining(`${name} must not be shipped`),
      ]);
    },
  );
});

describe("bareRequires", () => {
  it("finds plain and bundler-renamed requires, dedupes, and skips builtins and relatives", () => {
    const code = [
      'require("a"); require7("a"); require22("@s/pkg/sub");',
      'require("node:path"); require("./x"); foo.require("nope");',
      'require("a"); __require("b");',
      "require(variable);",
    ].join("\n");
    expect(bareRequires(code)).toEqual([
      { spec: "@s/pkg/sub", fromBundleLocation: false },
      { spec: "a", fromBundleLocation: false },
      { spec: "a", fromBundleLocation: true },
      { spec: "b", fromBundleLocation: true },
    ]);
  });
});

describe("lockedVersions", () => {
  it("parses bun.lock's trailing commas and scoped names", () => {
    const dir = tmp();
    write(
      dir,
      "bun.lock",
      '{ "packages": { "@a/b": ["@a/b@1.2.3", "", {}, "x",], "c": ["c@4.5.6", "", {},], }, }',
    );
    const v = lockedVersions(join(dir, "bun.lock"));
    expect([...(v.get("@a/b") ?? [])]).toEqual(["1.2.3"]);
    expect([...(v.get("c") ?? [])]).toEqual(["4.5.6"]);
  });
});

describe("pluginEntries", () => {
  const entries = (build: string) => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build } }));
    return pluginEntries(dir);
  };

  it("reads every src entry before --outdir", () => {
    expect(entries(BUILD)).toEqual(["index", "ng-worker"]);
  });

  it("rejects a build with no index entry", () => {
    expect(() => entries("bun build src/other.ts --outdir dist")).toThrow(
      /no src\/index.ts/,
    );
  });
});
