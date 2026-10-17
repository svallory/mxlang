/**
 * Dialect discovery and routing: a
 * dialect package's `package.json#mx.dialect`, discovery among the project's
 * direct dependencies only, routing by the longest claimed extension, the
 * clash between two dialects and `mx.extensions`, which settles it. Loading
 * a dialect's module is pinned in `triggers.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslateError } from "./core.ts";
import {
  type DialectManifest,
  discoverDialects,
  routeDialect,
} from "./dialect-discovery.ts";
import { findMxConfig } from "./mx-config.ts";
import { resolveSyntaxOf } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-discovery-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof TranslateError)) throw error;
    return error;
  }
  throw new Error("expected a TranslateError");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const ids = (dialects: readonly DialectManifest[]) =>
  dialects.map((dialect) => dialect.id);

/** The message for a manifest `module` that leaves its package. */
const outside = (why: string) =>
  `\`mx.dialect.module\` must stay inside the dialect's package, so the manifest works wherever the package is installed: ${why}; write a path relative to this \`package.json\` (\`./dialect.js\`)`;

describe("`package.json#mx.dialect`", () => {
  it("declares the dialect's id, name, extensions and module", () => {
    const { projectFile, packageFile } = dialectProject(dir, {
      manifest: { id: "mesh", name: "Mesh", extensions: [".mesh.mx"] },
    });
    expect(discoverDialects(projectFile)).toEqual([
      {
        id: "mesh",
        name: "Mesh",
        extensions: [".mesh.mx"],
        module: "./index.mjs",
        packageName: "test-dialect",
        packageFile,
      },
    ]);
  });

  it("reads `tagDirs: []` as no directories, and an absent `tagDirs` as undefined", () => {
    const { projectFile } = dialectProject(dir, {
      manifest: { id: "closed", name: "Closed", tagDirs: [] },
    });
    const [closed] = discoverDialects(projectFile);
    expect(closed?.tagDirs).toEqual([]);
    expect(Object.isFrozen(closed?.tagDirs)).toBe(true);
    const other = dialectProject(dir, {
      packageName: "open-dialect",
      manifest: { id: "open", name: "Open", extensions: [".open.mx"] },
    });
    const open = discoverDialects(other.projectFile).find(
      (dialect) => dialect.id === "open",
    );
    expect(open).toBeDefined();
    expect(open?.tagDirs).toBeUndefined();
  });

  it("declares the tag-discovery fields, each optional", () => {
    const { projectFile, packageFile } = dialectProject(dir, {
      manifest: {
        id: "mesh",
        name: "Mesh",
        extensions: [".mesh.mx"],
        tagDirs: ["components", "atoms"],
        tagExtensions: [".component.mesh.mx"],
        sidecars: false,
        reservedTags: ["entity"],
      },
    });
    expect(discoverDialects(projectFile)).toEqual([
      {
        id: "mesh",
        name: "Mesh",
        extensions: [".mesh.mx"],
        module: "./index.mjs",
        tagDirs: ["components", "atoms"],
        tagExtensions: [".component.mesh.mx"],
        sidecars: false,
        reservedTags: ["entity"],
        packageName: "test-dialect",
        packageFile,
      },
    ]);
  });

  // A manifest's `module` stays inside its package (it must work wherever
  // the package is installed); within it, `./` is optional and `..` is fine
  // while the path stays in. Each module here throws, which proves the
  // loader reached it.
  it.each(["./index.mjs", "dist/dialect.mjs", "./dist/../lib/dialect.mjs"])(
    "`module: %j` stays inside the package and loads",
    (module) => {
      dialectProject(dir, {
        manifest: { module },
        module: 'throw new Error("reached");',
      });
      expect(() => resolveSyntaxOf(join(dir, "page.tst"))).toThrow("reached");
    },
  );

  // The dialect package's `package.json`, as `dialectProject` writes it:
  // `mx` on line 3, `dialect` on line 4, then `id`, `name`, `extensions` (lines 7 to 9)
  // and `module` on line 10.
  it.each([
    [
      "not an object",
      "mesh",
      [4, 4],
      '`mx.dialect` must be an object declaring the dialect: `{ "id", "name", "extensions", "module" }`',
    ],
    [
      "an unknown field",
      { targets: ["web"] },
      [11, 6],
      "`mx.dialect.targets` is not a dialect manifest field (id, name, extensions, module, tagDirs, tagExtensions, sidecars, reservedTags, mxConfigTags)",
    ],
    [
      "an id that is not one",
      { id: "Mesh" },
      [5, 6],
      "`mx.dialect.id` must be a dialect id: lower-case words joined by `-` (`mydsl`)",
    ],
    [
      "MX's own id",
      { id: "mx" },
      [5, 6],
      "`mx.dialect.id` cannot be `mx`: that is MX's own dialect",
    ],
    [
      "no id",
      { id: null },
      [4, 4],
      "`mx.dialect.id` must be a dialect id: lower-case words joined by `-` (`mydsl`)",
    ],
    [
      "no name",
      { name: null },
      [4, 4],
      "`mx.dialect.name` must be a non-empty string: the name tooling shows the dialect's users",
    ],
    [
      "a blank name",
      { name: " " },
      [6, 6],
      "`mx.dialect.name` must be a non-empty string: the name tooling shows the dialect's users",
    ],
    [
      "no extensions",
      { extensions: [] },
      [7, 6],
      '`mx.dialect.extensions` must be a non-empty array of the file extensions the dialect claims (`[".mydsl.mx"]`)',
    ],
    [
      "`.mx`",
      { extensions: [".mx"] },
      [7, 6],
      "`mx.dialect.extensions` cannot claim `.mx`: it is MX's own; a dialect claims its own extensions (`.mydsl.mx`)",
    ],
    [
      "an extension without its dot",
      { extensions: ["mydsl"] },
      [7, 6],
      '`mx.dialect.extensions`: "mydsl" is not a file extension; write it with its leading dot (`.mydsl.mx`)',
    ],
    [
      "an extension with a path in it",
      { extensions: [".a/b"] },
      [7, 6],
      '`mx.dialect.extensions`: ".a/b" is not a file extension; write it with its leading dot (`.mydsl.mx`)',
    ],
    [
      "an extension twice",
      { extensions: [".tst", ".tst"] },
      [7, 6],
      "`mx.dialect.extensions` lists `.tst` twice",
    ],
    [
      "no module",
      { module: "" },
      [10, 6],
      "`mx.dialect.module` must be a path, relative to this `package.json`, to the module whose default export is the dialect",
    ],
    [
      "an absolute module",
      { module: "/opt/dialects/mesh.js" },
      [10, 6],
      outside('"/opt/dialects/mesh.js" is an absolute path'),
    ],
    [
      "a Windows absolute module",
      { module: "C:\\dialects\\mesh.js" },
      [10, 6],
      outside('"C:\\\\dialects\\\\mesh.js" is an absolute path'),
    ],
    [
      "a module outside the package",
      { module: "../other/index.js" },
      [10, 6],
      outside('"../other/index.js" is outside the package'),
    ],
    [
      "a module that climbs out through a subdirectory",
      { module: "dist/../../index.js" },
      [10, 6],
      outside('"dist/../../index.js" is outside the package'),
    ],
    // The tag-discovery fields follow `module`, so each key is on line 11.
    [
      "`tagDirs` not an array",
      { tagDirs: "components" },
      [11, 6],
      '`mx.dialect.tagDirs` must be an array of the directory names the dialect\'s files discover tags in (`["components"]`), or `[]` for none',
    ],
    [
      "a `tagDirs` entry that is not a string",
      { tagDirs: [7] },
      [11, 6],
      "`mx.dialect.tagDirs`: 7 is not a directory name",
    ],
    [
      "an empty `tagDirs` entry",
      { tagDirs: [""] },
      [11, 6],
      '`mx.dialect.tagDirs`: "" is not a directory name',
    ],
    [
      "a `tagDirs` path",
      { tagDirs: ["src/components"] },
      [11, 6],
      '`mx.dialect.tagDirs`: "src/components" is a path; write a directory name (`components`)',
    ],
    [
      "a `tagDirs` Windows path",
      { tagDirs: ["src\\components"] },
      [11, 6],
      '`mx.dialect.tagDirs`: "src\\\\components" is a path; write a directory name (`components`)',
    ],
    [
      "a `tagDirs` of `..`",
      { tagDirs: [".."] },
      [11, 6],
      '`mx.dialect.tagDirs`: ".." is not a directory name',
    ],
    [
      "a dot `tagDirs` entry",
      { tagDirs: [".components"] },
      [11, 6],
      '`mx.dialect.tagDirs`: ".components" starts with a dot, and the scan never reads a dot directory',
    ],
    [
      "a `tagDirs` entry twice",
      { tagDirs: ["components", "components"] },
      [11, 6],
      "`mx.dialect.tagDirs` lists `components` twice",
    ],
    [
      "`tagExtensions` not an array",
      { tagExtensions: ".component.tst" },
      [11, 6],
      '`mx.dialect.tagExtensions` must be an array of the extra file extensions the dialect\'s tag files use (`[".component.mydsl.mx"]`)',
    ],
    [
      "a `tagExtensions` entry without its dot",
      { tagExtensions: ["component"] },
      [11, 6],
      '`mx.dialect.tagExtensions`: "component" is not a file extension; write it with its leading dot (`.component.mydsl.mx`)',
    ],
    [
      "a `tagExtensions` claim on `.mx`",
      { tagExtensions: [".mx"] },
      [11, 6],
      "`mx.dialect.tagExtensions` cannot claim `.mx`: it is MX's own; a dialect claims its own extensions (`.mydsl.mx`)",
    ],
    [
      "a `tagExtensions` claim on a foreign extension",
      { tagExtensions: [".tag.ts"] },
      [11, 6],
      "`mx.dialect.tagExtensions` cannot claim `.tag.ts`: `.ts` files belong to TypeScript, JavaScript or Marko, whose tools read them; a dialect claims its own extensions (`.mydsl.mx`)",
    ],
    [
      "a `tagExtensions` entry `extensions` already claims",
      { tagExtensions: [".tst"] },
      [11, 6],
      "`mx.dialect.tagExtensions` lists `.tst`, which `mx.dialect.extensions` already claims",
    ],
    [
      "a `tagExtensions` entry twice",
      { tagExtensions: [".c.tst", ".c.tst"] },
      [11, 6],
      "`mx.dialect.tagExtensions` lists `.c.tst` twice",
    ],
    [
      "`sidecars` not a boolean",
      { sidecars: "no" },
      [11, 6],
      "`mx.dialect.sidecars` must be a boolean: whether `<name>.tag.ts` sidecars index in the dialect's `tagDirs`",
    ],
    [
      "`reservedTags` not an array",
      { reservedTags: "entity" },
      [11, 6],
      '`mx.dialect.reservedTags` must be an array of the tag names only the dialect may define (`["entity"]`)',
    ],
  ])(
    "%s is an error at the field, in the dialect's `package.json`",
    (_, manifest, at, message) => {
      const { projectFile, packageFile } = dialectProject(dir, { manifest });
      const error = caught(() => discoverDialects(projectFile));
      expect(error.file).toBe(packageFile);
      expect([error.line, error.column]).toEqual(at);
      expect(error.message).toBe(message);
    },
  );
});

describe("a `reservedTags` entry's error is at the entry", () => {
  it.each([
    [
      "an entry that is no tag name",
      { reservedTags: ["entity", "-x"] },
      [13, 8],
      '`mx.dialect.reservedTags`: "-x" is not a tag name; a tag name starts with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots',
    ],
    [
      "an entry core reserves",
      { reservedTags: ["entity", "for"] },
      [13, 8],
      "`mx.dialect.reservedTags` cannot list `for`: MX reserves it for every dialect (if, else, else-if, for, const, define, return, import, export, static, try)",
    ],
    [
      "the second of two equal entries",
      { reservedTags: ["entity", "entity"] },
      [13, 8],
      "`mx.dialect.reservedTags` lists `entity` twice",
    ],
    [
      "the first entry, when it is the one core reserves",
      { reservedTags: ["try", "entity"] },
      [12, 8],
      "`mx.dialect.reservedTags` cannot list `try`: MX reserves it for every dialect (if, else, else-if, for, const, define, return, import, export, static, try)",
    ],
  ])("%s", (_, manifest, at, message) => {
    const { projectFile, packageFile } = dialectProject(dir, { manifest });
    const error = caught(() => discoverDialects(projectFile));
    expect(error.file).toBe(packageFile);
    expect([error.line, error.column]).toEqual(at);
    expect(error.message).toBe(message);
  });
});

describe("discovery reads the project's direct dependencies only", () => {
  it.each([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])("a dialect listed in `%s` is found", (field) => {
    const { projectFile } = dialectProject(dir, { field });
    expect(ids(discoverDialects(projectFile))).toEqual(["test"]);
  });

  it("a dialect installed but not listed (a transitive dependency) is not found", () => {
    const { projectFile } = dialectProject(dir);
    writeJson(join(dir, "node_modules/other-dialect/package.json"), {
      name: "other-dialect",
      mx: {
        dialect: {
          id: "other",
          name: "Other",
          extensions: [".oth"],
          module: "./index.mjs",
        },
      },
    });
    expect(ids(discoverDialects(projectFile))).toEqual(["test"]);
    expect(routeDialect(join(dir, "page.oth"))).toBeUndefined();
  });

  it("a listed package that is not installed, or declares no dialect, is skipped", () => {
    writeJson(join(dir, "node_modules/plain/package.json"), { name: "plain" });
    const projectFile = join(dir, "package.json");
    writeJson(projectFile, {
      name: "app",
      dependencies: { plain: "1.0.0", missing: "1.0.0" },
    });
    expect(discoverDialects(projectFile)).toEqual([]);
  });

  it("a dependency is found where Node would find it: a `node_modules` above the project", () => {
    dialectProject(dir);
    const app = join(dir, "apps/web");
    writeJson(join(app, "package.json"), {
      name: "web",
      devDependencies: { "test-dialect": "0.0.0" },
    });
    expect(routeDialect(join(app, "src/page.tst"))?.id).toBe("test");
  });

  it("a dialect package routes its own files", () => {
    writeJson(join(dir, "package.json"), {
      name: "mesh",
      mx: {
        dialect: {
          id: "mesh",
          name: "Mesh",
          extensions: [".mesh.mx"],
          module: "./index.mjs",
        },
      },
    });
    expect(routeDialect(join(dir, "test/a.mesh.mx"))?.id).toBe("mesh");
  });

  it("the project is the file's nearest `package.json`: a nested package without the dialect gets none", () => {
    dialectProject(dir);
    writeJson(join(dir, "lib/package.json"), { name: "lib" });
    expect(routeDialect(join(dir, "page.tst"))?.id).toBe("test");
    expect(routeDialect(join(dir, "lib/page.tst"))).toBeUndefined();
  });

  it("no dialect code runs for a file no dialect claims", () => {
    dialectProject(dir, { module: 'throw new Error("loaded");' });
    expect(resolveSyntaxOf(join(dir, "page.mx")).isDefault).toBe(true);
    expect(() => resolveSyntaxOf(join(dir, "page.tst"))).toThrow("loaded");
  });
});

describe("routing a file to its dialect", () => {
  function twoDialects(a: unknown, b: unknown, mx?: unknown) {
    dialectProject(dir, { packageName: "a-dialect", manifest: a });
    return dialectProject(dir, {
      packageName: "b-dialect",
      manifest: b,
      ...(mx === undefined ? {} : { mx }),
    });
  }

  it("the longest extension the name ends with wins", () => {
    twoDialects(
      { id: "a", name: "A", extensions: [".x"] },
      { id: "b", name: "B", extensions: [".y.x"] },
    );
    expect(routeDialect(join(dir, "page.x"))?.id).toBe("a");
    expect(routeDialect(join(dir, "page.y.x"))?.id).toBe("b");
    expect(routeDialect(join(dir, "page.z.x"))?.id).toBe("a");
  });

  describe("`tagExtensions` route like `extensions`", () => {
    it("a `tagExtensions` name routes to the dialect", () => {
      dialectProject(dir, {
        manifest: { tagExtensions: [".component.tst"] },
      });
      expect(routeDialect(join(dir, "money.component.tst"))?.id).toBe("test");
      expect(routeDialect(join(dir, "page.tst"))?.id).toBe("test");
    });

    it("the longest suffix wins across both fields and dialects", () => {
      twoDialects(
        { id: "a", name: "A", extensions: [".x"], tagExtensions: [".c.y.x"] },
        { id: "b", name: "B", extensions: [".y.x"] },
      );
      expect(routeDialect(join(dir, "q.x"))?.id).toBe("a");
      expect(routeDialect(join(dir, "q.y.x"))?.id).toBe("b");
      expect(routeDialect(join(dir, "q.c.y.x"))?.id).toBe("a");
      expect(routeDialect(join(dir, "q.d.y.x"))?.id).toBe("b");
    });

    // The project's `package.json`: the second dependency entry on line 5.
    it("one's `tagExtensions` against another's `extensions` is the clash error", () => {
      const { projectFile } = twoDialects(
        { id: "a", name: "A", extensions: [".a"], tagExtensions: [".tst"] },
        { id: "b", name: "B", extensions: [".tst"] },
      );
      const error = caught(() => routeDialect(join(dir, "page.tst")));
      expect(error.file).toBe(projectFile);
      expect([error.line, error.column]).toEqual([5, 4]);
      expect(error.message).toBe(
        'two dialects claim `.tst`: `a` (a-dialect) and `b` (b-dialect). Choose one in `mx.extensions` in MX\'s config: `"extensions": { ".tst": "a" }`',
      );
    });

    it("`mx.extensions` settles a `tagExtensions` clash", () => {
      twoDialects(
        { id: "a", name: "A", extensions: [".a"], tagExtensions: [".tst"] },
        { id: "b", name: "B", extensions: [".tst"] },
        { extensions: { ".tst": "a" } },
      );
      expect(routeDialect(join(dir, "page.tst"))?.id).toBe("a");
    });

    // The dialect's `package.json`: `tagExtensions` on line 11.
    it("a `tagExtensions` claim on a host's file kind is an error at its key when routing", () => {
      const { packageFile } = dialectProject(dir, {
        manifest: { tagExtensions: [".solid.mx"] },
      });
      const error = caught(() =>
        routeDialect(join(dir, "page.tst"), { hostSegments: ["solid"] }),
      );
      expect(error.file).toBe(packageFile);
      expect([error.line, error.column]).toEqual([11, 6]);
      expect(error.message).toBe(
        "`mx.dialect.tagExtensions` cannot claim `.solid.mx`: `.solid.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mydsl.mx`)",
      );
    });
  });

  it.each(["page.mx", "page.solid.mx", "page.tsx", ".tst"])(
    "`%s` is not the dialect's",
    (name) => {
      dialectProject(dir);
      expect(routeDialect(join(dir, name))).toBeUndefined();
    },
  );

  it("an extension two dialects claim is an error naming both, at the second's dependency entry", () => {
    const { projectFile } = twoDialects(
      { id: "a", name: "A", extensions: [".tst"] },
      { id: "b", name: "B", extensions: [".tst"] },
    );
    const error = caught(() => routeDialect(join(dir, "page.tst")));
    expect(error.file).toBe(projectFile);
    expect([error.line, error.column]).toEqual([5, 4]);
    expect(error.message).toBe(
      'two dialects claim `.tst`: `a` (a-dialect) and `b` (b-dialect). Choose one in `mx.extensions` in MX\'s config: `"extensions": { ".tst": "a" }`',
    );
  });

  it("the clash is only an error for a file with that extension", () => {
    twoDialects(
      { id: "a", name: "A", extensions: [".tst", ".a"] },
      { id: "b", name: "B", extensions: [".tst"] },
    );
    expect(routeDialect(join(dir, "page.a"))?.id).toBe("a");
    expect(routeDialect(join(dir, "page.mx"))).toBeUndefined();
  });

  it("`mx.extensions` settles a clash", () => {
    twoDialects(
      { id: "a", name: "A", extensions: [".tst"] },
      { id: "b", name: "B", extensions: [".tst"] },
      { extensions: { ".tst": "b" } },
    );
    expect(routeDialect(join(dir, "page.tst"))?.id).toBe("b");
  });

  it("`mx.extensions` may route an extension the dialect does not claim", () => {
    dialectProject(dir, { mx: { extensions: { ".page": "test" } } });
    expect(routeDialect(join(dir, "home.page"))?.id).toBe("test");
  });

  describe("`mx.extensions` is read from MX's config, in any format", () => {
    it("an `mx.config.json` routes an extension", () => {
      dialectProject(dir);
      writeJson(join(dir, "mx.config.json"), {
        extensions: { ".page": "test" },
      });
      expect(routeDialect(join(dir, "home.page"))?.id).toBe("test");
    });

    it("an `.mxrc.yaml` settles a clash", () => {
      twoDialects(
        { id: "a", name: "A", extensions: [".tst"] },
        { id: "b", name: "B", extensions: [".tst"] },
      );
      writeFileSync(join(dir, ".mxrc.yaml"), 'extensions:\n  ".tst": b\n');
      expect(routeDialect(join(dir, "page.tst"))?.id).toBe("b");
    });

    it("`package.json#mx` wins over an `mx.config.json` beside it", () => {
      dialectProject(dir, { mx: { extensions: { ".one": "test" } } });
      writeJson(join(dir, "mx.config.json"), {
        extensions: { ".two": "test" },
      });
      expect(routeDialect(join(dir, "home.one"))?.id).toBe("test");
      expect(routeDialect(join(dir, "home.two"))).toBeUndefined();
    });

    it("an edit to the config is seen at the next routing", () => {
      dialectProject(dir);
      const config = join(dir, "mx.config.json");
      writeJson(config, { extensions: { ".one": "test" } });
      expect(routeDialect(join(dir, "home.one"))?.id).toBe("test");
      writeJson(config, { extensions: { ".two": "test" } });
      expect(routeDialect(join(dir, "home.one"))).toBeUndefined();
      expect(routeDialect(join(dir, "home.two"))?.id).toBe("test");
    });

    // `{`, `"extensions": {` on line 2, `".tst"` on line 3, `".mx"` on line 4.
    it("a bad entry is an error in the config file, at the entry's key", () => {
      dialectProject(dir);
      const config = join(dir, "mx.config.json");
      writeJson(config, { extensions: { ".tst": "test", ".mx": "test" } });
      const error = caught(() => routeDialect(join(dir, "page.mx")));
      expect(error.file).toBe(config);
      expect([error.line, error.column]).toEqual([4, 4]);
      expect(error.message).toBe(
        "`mx.extensions` cannot route `.mx`: it is MX's own",
      );
    });
  });

  // The project's `package.json`: `devDependencies` on lines 3 to 5, then
  // `mx` on line 6 with `extensions` on line 7. A bad value is an error at
  // `mx.extensions`; a bad entry, at the entry's key: the second one, on
  // line 9, after a good entry on line 8.
  it.each([
    [
      "not an object",
      [".tst"],
      [7, 4],
      '`mx.extensions` must be an object mapping a file extension to the id of the dialect that handles it (`{ ".mydsl.mx": "mydsl" }`)',
    ],
    [
      "`.mx`",
      { ".tst": "test", ".mx": "test" },
      [9, 6],
      "`mx.extensions` cannot route `.mx`: it is MX's own",
    ],
    [
      "a key that is not an extension",
      { ".tst": "test", tst: "test" },
      [9, 6],
      '`mx.extensions`: "tst" is not a file extension; write it with its leading dot (`.mydsl.mx`)',
    ],
    [
      "an id no dependency declares",
      { ".tst": "test", ".p": "mesh" },
      [9, 6],
      '`mx.extensions` routes `.p` to "mesh", which is not a dialect this project uses (it uses `test`); a dialect is found among the project\'s direct dependencies',
    ],
  ])("`mx.extensions` %s is an error", (_, extensions, at, message) => {
    const { projectFile } = dialectProject(dir, { mx: { extensions } });
    const error = caught(() => routeDialect(join(dir, "page.mx")));
    expect(error.file).toBe(projectFile);
    expect([error.line, error.column]).toEqual(at);
    expect(error.message).toBe(message);
  });
});

describe("a dialect's id is its identity", () => {
  const sameId = (packages: string) =>
    `two dialects have the id \`mesh\`: ${packages}. A dialect's id is its identity; keep one of these dependencies`;

  it("two dependencies with one id is an error naming both, at the second's dependency entry", () => {
    dialectProject(dir, {
      packageName: "a-dialect",
      manifest: { id: "mesh", extensions: [".a"] },
    });
    const { projectFile } = dialectProject(dir, {
      packageName: "b-dialect",
      manifest: { id: "mesh", extensions: [".b"] },
    });
    for (const run of [
      () => discoverDialects(projectFile),
      () => routeDialect(join(dir, "page.b")),
      // `mx.extensions` could not tell them apart: no override settles it.
      () => routeDialect(join(dir, "page.mx")),
    ]) {
      const error = caught(run);
      expect([error.message, error.file, error.line, error.column]).toEqual([
        sameId("a-dialect and b-dialect"),
        projectFile,
        5,
        4,
      ]);
    }
  });

  it("the project's own dialect and a dependency with its id is an error at the dependency", () => {
    // `mx` spans lines 3 to 12; `devDependencies` opens on line 13.
    const { projectFile } = dialectProject(dir, {
      manifest: { id: "mesh" },
      project: {
        mx: {
          dialect: {
            id: "mesh",
            name: "Own",
            extensions: [".own"],
            module: "./index.mjs",
          },
        },
      },
    });
    const error = caught(() => discoverDialects(projectFile));
    expect([error.message, error.file, error.line, error.column]).toEqual([
      sameId("app and test-dialect"),
      projectFile,
      14,
      4,
    ]);
  });
});

describe("a dependency listed under an alias", () => {
  // `"b": "npm:@real/b-dialect@1"` installs `@real/b-dialect` at
  // `node_modules/b`; the project's entry for it is on line 5.
  function aliased(manifest: unknown) {
    dialectProject(dir, {
      packageName: "a-dialect",
      manifest: { id: "a", name: "A", extensions: [".tst"] },
    });
    writeJson(join(dir, "node_modules/b/package.json"), {
      name: "@real/b-dialect",
      mx: { dialect: manifest },
    });
    const projectFile = join(dir, "package.json");
    writeJson(projectFile, {
      name: "app",
      devDependencies: {
        "a-dialect": "0.0.0",
        b: "npm:@real/b-dialect@1",
      },
    });
    return projectFile;
  }

  it("a clash is at the alias's entry, naming the package and its key", () => {
    const projectFile = aliased({
      id: "b",
      name: "B",
      extensions: [".tst"],
      module: "./index.mjs",
    });
    const error = caught(() => routeDialect(join(dir, "page.tst")));
    expect([error.message, error.file, error.line, error.column]).toEqual([
      'two dialects claim `.tst`: `a` (a-dialect) and `b` (@real/b-dialect, as `b`). Choose one in `mx.extensions` in MX\'s config: `"extensions": { ".tst": "a" }`',
      projectFile,
      5,
      4,
    ]);
  });

  it("an id clash is at the alias's entry too", () => {
    const projectFile = aliased({
      id: "a",
      name: "B",
      extensions: [".b"],
      module: "./index.mjs",
    });
    const error = caught(() => discoverDialects(projectFile));
    expect([error.message, error.file, error.line, error.column]).toEqual([
      "two dialects have the id `a`: a-dialect and @real/b-dialect, as `b`. A dialect's id is its identity; keep one of these dependencies",
      projectFile,
      5,
      4,
    ]);
  });
});

describe("discovery follows the dependencies on disk", () => {
  it("a listed dependency installed after the first routing is found, with the project's `package.json` unchanged", () => {
    const projectFile = join(dir, "package.json");
    writeJson(projectFile, {
      name: "app",
      devDependencies: { "late-dialect": "0.0.0" },
    });
    expect(routeDialect(join(dir, "page.tst"))).toBeUndefined();
    expect(discoverDialects(projectFile)).toEqual([]);
    writeJson(join(dir, "node_modules/late-dialect/package.json"), {
      name: "late-dialect",
      mx: {
        dialect: {
          id: "late",
          name: "Late",
          extensions: [".tst"],
          module: "./index.mjs",
        },
      },
    });
    expect(routeDialect(join(dir, "page.tst"))?.id).toBe("late");
    expect(ids(discoverDialects(projectFile))).toEqual(["late"]);
  });

  it("an edited dependency manifest is seen at the next routing", () => {
    const { packageFile } = dialectProject(dir, {
      manifest: { extensions: [".e1"] },
    });
    expect(routeDialect(join(dir, "page.e1"))?.id).toBe("test");
    // Same size, so only the text tells the two revisions apart.
    writeJson(packageFile, {
      name: "test-dialect",
      mx: {
        dialect: {
          id: "test",
          name: "Test",
          extensions: [".e2"],
          module: "./index.mjs",
        },
      },
    });
    expect(routeDialect(join(dir, "page.e1"))).toBeUndefined();
    expect(routeDialect(join(dir, "page.e2"))?.id).toBe("test");
  });

  it("an unchanged dependency keeps one manifest object", () => {
    const { projectFile } = dialectProject(dir);
    const first = routeDialect(join(dir, "page.tst"));
    expect(routeDialect(join(dir, "page.tst"))).toBe(first);
    expect(discoverDialects(projectFile)[0]).toBe(first);
  });
});

describe("extensions a dialect cannot claim", () => {
  const claim = (extension: string, reason: string) =>
    `\`mx.dialect.extensions\` cannot claim \`${extension}\`: ${reason}; a dialect claims its own extensions (\`.mydsl.mx\`)`;
  const foreign = (segment: string) =>
    `\`.${segment}\` files belong to TypeScript, JavaScript or Marko, whose tools read them`;
  const otherCase = "it is `.mx` in another case, and `.mx` is MX's own";
  const host = (suffix: string) =>
    `\`${suffix}\` is a host's file kind, which MX owns`;

  // The dialect's `package.json`: `extensions` on line 7.
  it.each([
    [".ts", foreign("ts")],
    [".tsx", foreign("tsx")],
    [".mts", foreign("mts")],
    [".cts", foreign("cts")],
    [".js", foreign("js")],
    [".jsx", foreign("jsx")],
    [".mjs", foreign("mjs")],
    [".cjs", foreign("cjs")],
    [".d.ts", foreign("ts")],
    [".marko", foreign("marko")],
    [".TS", foreign("TS")],
    [".page.tsx", foreign("tsx")],
    [".MX", otherCase],
    [".Mx", otherCase],
    [".mX", otherCase],
    [".page.MX", otherCase],
  ])(
    "`%s` in the manifest is an error at `mx.dialect.extensions`",
    (extension, reason) => {
      const { projectFile, packageFile } = dialectProject(dir, {
        manifest: { extensions: [".tst", extension] },
      });
      const error = caught(() => discoverDialects(projectFile));
      expect(error.file).toBe(packageFile);
      expect([error.line, error.column]).toEqual([7, 6]);
      expect(error.message).toBe(claim(extension, reason));
    },
  );

  // Core holds no host list: the caller's targets name the host file kinds.
  describe("a host's file kind (`.<host>.mx`), named by the caller", () => {
    const hostSegments = ["solid", "ng"];

    it.each([".solid.mx", ".page.ng.mx"])(
      "a manifest claiming `%s` is an error at `mx.dialect.extensions` when routing",
      (extension) => {
        const { packageFile } = dialectProject(dir, {
          manifest: { extensions: [".tst", extension] },
        });
        const error = caught(() =>
          routeDialect(join(dir, "page.tst"), { hostSegments }),
        );
        expect(error.file).toBe(packageFile);
        expect([error.line, error.column]).toEqual([7, 6]);
        expect(error.message).toBe(
          claim(
            extension,
            host(extension === ".solid.mx" ? ".solid.mx" : ".ng.mx"),
          ),
        );
      },
    );

    it("without host segments, discovery accepts the claim: core has no host list", () => {
      const { projectFile } = dialectProject(dir, {
        manifest: { extensions: [".solid.mx"] },
      });
      expect(ids(discoverDialects(projectFile))).toEqual(["test"]);
    });

    it("`.mesh.mx` stays claimable: `mesh` is not a host", () => {
      dialectProject(dir, {
        manifest: { id: "mesh", name: "Mesh", extensions: [".mesh.mx"] },
      });
      expect(routeDialect(join(dir, "x.mesh.mx"), { hostSegments })?.id).toBe(
        "mesh",
      );
      expect(
        routeDialect(join(dir, "x.solid.mx"), { hostSegments }),
      ).toBeUndefined();
      expect(routeDialect(join(dir, "x.mx"), { hostSegments })).toBeUndefined();
    });

    // The project's `package.json`: `mx.extensions` on line 7, the second
    // entry's key on line 9.
    it("`mx.extensions` routing a host's file kind is an error at the entry", () => {
      const { projectFile } = dialectProject(dir, {
        mx: { extensions: { ".tst": "test", ".solid.mx": "test" } },
      });
      const error = caught(() =>
        routeDialect(join(dir, "page.tst"), { hostSegments }),
      );
      expect(error.file).toBe(projectFile);
      expect([error.line, error.column]).toEqual([9, 6]);
      expect(error.message).toBe(
        `\`mx.extensions\` cannot route \`.solid.mx\`: ${host(".solid.mx")}`,
      );
    });
  });

  it.each([
    [".ts", foreign("ts")],
    [".d.ts", foreign("ts")],
    [".marko", foreign("marko")],
    [".MX", otherCase],
  ])(
    "`mx.extensions` routing `%s` is an error at the entry",
    (extension, reason) => {
      const { projectFile } = dialectProject(dir, {
        mx: { extensions: { ".tst": "test", [extension]: "test" } },
      });
      const error = caught(() => routeDialect(join(dir, "page.tst")));
      expect(error.file).toBe(projectFile);
      expect([error.line, error.column]).toEqual([9, 6]);
      expect(error.message).toBe(
        `\`mx.extensions\` cannot route \`${extension}\`: ${reason}`,
      );
    },
  );
});

describe("MX's config cannot set what a dialect owns", () => {
  const TOP =
    "`mx.tagRules` cannot be set: a file's tag rules belong to its dialect, or to its target for MX's own files. MX's config overrides only which dialect handles which extension (`mx.extensions`)";
  const owned = (key: string, what: string) =>
    `\`mx.test.${key}\` cannot be set: the dialect \`test\` (test-dialect) owns its ${what}. MX's config overrides only which dialect handles which extension (\`mx.extensions\`); \`mx.test\` holds the dialect's own settings`;

  // The project's `package.json`: `mx` on line 6, its first key on line 7,
  // a key inside `mx.test` on line 8.
  it.each([
    ["`tagRules` at the top level", { tagRules: "none" }, [7, 4], TOP],
    [
      "`tagRules` under the dialect's id",
      { test: { tagRules: "none" } },
      [8, 6],
      owned("tagRules", "tag rules"),
    ],
    [
      "`name` under the dialect's id",
      { test: { name: "Other" } },
      [8, 6],
      owned("name", "name"),
    ],
  ])("%s is an error at its key", (_, mx, at, message) => {
    const { projectFile } = dialectProject(dir, { mx });
    for (const name of ["page.tst", "page.mx"]) {
      const error = caught(() => routeDialect(join(dir, name)));
      expect(error.file).toBe(projectFile);
      expect([error.line, error.column]).toEqual(at);
      expect(error.message).toBe(message);
    }
  });

  it.each([
    [
      "mx.config.json",
      '{\n  "test": {\n    "tagRules": "none"\n  }\n}\n',
      [3, 4],
    ],
    ["mx.config.yaml", "test:\n  tagRules: none\n", [2, 2]],
  ])("is an error at its key in %s too", (name, text, at) => {
    dialectProject(dir);
    const file = join(dir, name);
    writeFileSync(file, text);
    const error = caught(() => routeDialect(join(dir, "page.tst")));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual(at);
    expect(error.message).toBe(owned("tagRules", "tag rules"));
  });

  it("top-level `tagRules` in an `mx.config.yaml` is an error at its key", () => {
    dialectProject(dir);
    const file = join(dir, "mx.config.yaml");
    writeFileSync(file, "strict: true\ntagRules: none\n");
    const error = caught(() => routeDialect(join(dir, "page.tst")));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual([2, 0]);
    expect(error.message).toBe(TOP);
  });

  it("the dialect's other settings pass through untouched", () => {
    const settings = { strictModels: true, target: "web", names: ["x"] };
    dialectProject(dir, { mx: { test: settings } });
    expect(routeDialect(join(dir, "page.tst"))?.id).toBe("test");
    const config = findMxConfig(dir)?.config as Record<string, unknown>;
    expect(config.test).toEqual(settings);
  });

  it("a section for a dialect the project does not use is not routing's to judge", () => {
    dialectProject(dir, { mx: { other: { name: "Other" } } });
    expect(routeDialect(join(dir, "page.tst"))?.id).toBe("test");
  });
});
