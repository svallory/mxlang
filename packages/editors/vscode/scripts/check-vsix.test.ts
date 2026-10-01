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

const pkg = (name: string, version: string, main = "index.js") =>
  JSON.stringify({ name, version, main });

const FACTORY = "module.exports = function (m) { return { create() {} }; };";
const PLUGIN = "node_modules/@mxlang/typescript-plugin";

interface Options {
  /** Files of the shipped extension, path to contents. */
  files?: Record<string, string>;
  plugins?: string[];
  /** `dist/<entry>.cjs` files expected (default: the plugin's bundled entries). */
  entries?: string[];
  /** `name@version` pairs the lockfile pins. */
  locked?: string[];
  /** Files of the shipped language server (default: a healthy one); `{}` ships none. */
  lsFiles?: Record<string, string>;
  /** `dist/<entry>.cjs` files expected of the language server. */
  lsEntries?: string[];
}

const LS = "node_modules/@mxlang/language-server";
const HEALTHY_LS: Record<string, string> = {
  [`${LS}/package.json`]: pkg(
    "@mxlang/language-server",
    "0.1.0",
    "dist/bin.cjs",
  ),
  [`${LS}/dist/bin.cjs`]: "",
};

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
  for (const [path, contents] of Object.entries({
    ...files,
    ...(options.lsFiles ?? HEALTHY_LS),
  })) {
    write(root, path, contents);
  }

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
  return {
    root,
    lockfile,
    entries: options.entries,
    lsEntries: options.lsEntries,
  };
}

const check = (options?: Options) => {
  const { root, lockfile, entries, lsEntries } = fixture(options);
  return checkExtensionRoot(root, {
    lockfile,
    ...(entries ? { entries } : {}),
    ...(lsEntries ? { lsEntries } : {}),
  });
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

  describe("the language server", () => {
    it("fails on a VSIX with the language server removed (today's main)", () => {
      expect(check({ lsFiles: {} })).toEqual([
        expect.stringContaining(
          "@mxlang/language-server does not resolve from",
        ),
      ]);
    });

    it("fails when the entry the build declares is not shipped", () => {
      expect(check({ lsEntries: ["bin", "other"] })).toEqual([
        '"@mxlang/language-server" is missing dist/other.cjs',
      ]);
    });

    it("fails when main is not the bundled bin", () => {
      const problems = check({
        lsFiles: {
          [`${LS}/package.json`]: pkg(
            "@mxlang/language-server",
            "0.1.0",
            "dist/other.cjs",
          ),
          [`${LS}/dist/other.cjs`]: "",
          [`${LS}/dist/bin.cjs`]: "",
        },
      });
      expect(problems).toEqual([expect.stringContaining("main is")]);
    });

    it("fails when a bare require of the server does not resolve", () => {
      const problems = check({
        lsFiles: {
          ...HEALTHY_LS,
          [`${LS}/dist/bin.cjs`]: 'require("left-pad")',
        },
      });
      expect(problems).toEqual([
        expect.stringContaining(
          'dist/bin.cjs requires "left-pad", which does not resolve from the shipped language server',
        ),
      ]);
    });

    it("passes when the server's require resolves from the shipped closure", () => {
      expect(
        check({
          lsFiles: {
            ...HEALTHY_LS,
            [`${LS}/dist/bin.cjs`]: 'require4("@marko/compiler")',
          },
        }),
      ).toEqual([]);
    });
  });

  describe("plugin entries come from the bundled build's one list", () => {
    it("fails when an entry the build declares is not shipped", () => {
      const problems = check({ entries: ["index", "ng-worker", "other"] });
      expect(problems).toEqual([
        '"@mxlang/typescript-plugin" is missing dist/other.cjs',
      ]);
    });

    it("defaults to the plugin build's own entries (index and the Angular worker)", () => {
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
  });

  describe("the entry tsserver loads", () => {
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
