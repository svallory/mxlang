/**
 * Dialect discovery and routing (decision 212 items 1 to 3 and 5): a
 * dialect package's `package.json#mxDialect`, discovery among the project's
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

describe("`package.json#mxDialect`", () => {
  it("declares the dialect's id, name, extensions and module", () => {
    const { projectFile, packageFile } = dialectProject(dir, {
      manifest: { id: "mesh", name: "Mesh", extensions: [".mesh", ".mesh.mx"] },
    });
    expect(discoverDialects(projectFile)).toEqual([
      {
        id: "mesh",
        name: "Mesh",
        extensions: [".mesh", ".mesh.mx"],
        module: "./index.mjs",
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
  // `mxDialect` on line 3, then `id`, `name`, `extensions` (lines 6 to 8)
  // and `module` on line 9.
  it.each([
    [
      "not an object",
      "mesh",
      [3, 2],
      "`mxDialect` must be an object declaring the dialect",
    ],
    [
      "an unknown field",
      { targets: ["web"] },
      [10, 4],
      "`mxDialect.targets` is not a dialect manifest field (id, name, extensions, module)",
    ],
    [
      "an id that is not one",
      { id: "Mesh" },
      [4, 4],
      "`mxDialect.id` must be a dialect id: lower-case words joined by `-` (`mesh`)",
    ],
    [
      "MX's own id",
      { id: "mx" },
      [4, 4],
      "`mxDialect.id` cannot be `mx`: that is MX's own dialect",
    ],
    ["no id", { id: null }, [3, 2], "`mxDialect.id` must be a dialect id"],
    [
      "no name",
      { name: null },
      [3, 2],
      "`mxDialect.name` must be a non-empty string: the name tooling shows the dialect's users",
    ],
    [
      "a blank name",
      { name: " " },
      [5, 4],
      "`mxDialect.name` must be a non-empty string",
    ],
    [
      "no extensions",
      { extensions: [] },
      [6, 4],
      "`mxDialect.extensions` must be a non-empty array of the file extensions the dialect claims",
    ],
    [
      "`.mx`",
      { extensions: [".mx"] },
      [6, 4],
      "`mxDialect.extensions` cannot claim `.mx`: it is MX's own",
    ],
    [
      "an extension without its dot",
      { extensions: ["mesh"] },
      [6, 4],
      '`mxDialect.extensions`: "mesh" is not a file extension; write it with its leading dot (`.mesh`)',
    ],
    [
      "an extension with a path in it",
      { extensions: [".a/b"] },
      [6, 4],
      '`mxDialect.extensions`: ".a/b" is not a file extension',
    ],
    [
      "an extension twice",
      { extensions: [".tst", ".tst"] },
      [6, 4],
      "`mxDialect.extensions` lists `.tst` twice",
    ],
    [
      "no module",
      { module: "" },
      [9, 4],
      "`mxDialect.module` must be a path, relative to this `package.json`, to the module whose default export is the dialect",
    ],
    [
      "an absolute module",
      { module: "/opt/dialects/mesh.js" },
      [9, 4],
      '`mxDialect.module` must stay inside the dialect\'s package, so the manifest works wherever the package is installed: "/opt/dialects/mesh.js" is an absolute path; write a path relative to this `package.json` (`./dialect.js`)',
    ],
    [
      "a Windows absolute module",
      { module: "C:\\dialects\\mesh.js" },
      [9, 4],
      "is an absolute path",
    ],
    [
      "a module outside the package",
      { module: "../other/index.js" },
      [9, 4],
      '"../other/index.js" is outside the package',
    ],
    [
      "a module that climbs out through a subdirectory",
      { module: "dist/../../index.js" },
      [9, 4],
      "is outside the package",
    ],
  ])(
    "%s is an error at the field, in the dialect's `package.json`",
    (_, manifest, at, message) => {
      const { projectFile, packageFile } = dialectProject(dir, { manifest });
      const error = caught(() => discoverDialects(projectFile));
      expect(error.file).toBe(packageFile);
      expect([error.line, error.column]).toEqual(at);
      expect(error.message).toContain(message);
    },
  );
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
      mxDialect: {
        id: "other",
        name: "Other",
        extensions: [".oth"],
        module: "./index.mjs",
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
      mxDialect: {
        id: "mesh",
        name: "Mesh",
        extensions: [".mesh"],
        module: "./index.mjs",
      },
    });
    expect(routeDialect(join(dir, "test/a.mesh"))?.id).toBe("mesh");
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
      'two dialects claim `.tst`: `a` (a-dialect) and `b` (b-dialect). Choose one in MX\'s config: `"extensions": { ".tst": "a" }`',
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

  // The project's `package.json`: `devDependencies` on lines 3 to 5, then
  // `mx` on line 6 with `extensions` on line 7.
  it.each([
    [
      "not an object",
      [".tst"],
      "`mx.extensions` must be an object mapping a file extension to the id of the dialect that handles it",
    ],
    [
      "`.mx`",
      { ".mx": "test" },
      "`mx.extensions` cannot route `.mx`: it is MX's own",
    ],
    [
      "a key that is not an extension",
      { tst: "test" },
      '`mx.extensions`: "tst" is not a file extension',
    ],
    [
      "an id no dependency declares",
      { ".tst": "mesh" },
      '`mx.extensions` routes `.tst` to "mesh", which is not a dialect this project uses (it uses `test`)',
    ],
  ])("`mx.extensions` %s is an error at its key", (_, extensions, message) => {
    const { projectFile } = dialectProject(dir, { mx: { extensions } });
    const error = caught(() => routeDialect(join(dir, "page.mx")));
    expect(error.file).toBe(projectFile);
    expect([error.line, error.column]).toEqual([7, 4]);
    expect(error.message).toContain(message);
  });
});
