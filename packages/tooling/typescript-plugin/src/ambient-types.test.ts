import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProjects,
  fakeProject,
  fakeWorkspace,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import {
  ambientTypeDiagnostics,
  ambientTypeFiles,
  withAmbientTypes,
} from "./ambient-types.ts";

// `packages/hosts/astro` has `astro` installed, as an Astro project does.
const astroProject = join(import.meta.dirname, "../../../hosts/astro");
const tail = (file: string) => file.split("/").slice(-2).join("/");

afterEach(cleanupProjects);

describe("ambientTypeFiles", () => {
  it("adds a host's ambient types to a program holding one of its files", () => {
    const errors: string[] = [];
    const files = ambientTypeFiles(
      ["/p/src/page.astro.mx"],
      astroProject,
      errors,
    );

    expect(files.map(tail)).toEqual(["astro/env.d.ts", "astro/astro-jsx.d.ts"]);
    for (const file of files) expect(existsSync(file)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("adds them for a plain .astro page with no .astro.mx in the program", () => {
    expect(
      ambientTypeFiles(["/p/src/pages/index.astro"], astroProject, []).map(
        tail,
      ),
    ).toEqual(["astro/env.d.ts", "astro/astro-jsx.d.ts"]);
  });

  it("adds nothing to a program holding none of a host's files", () => {
    expect(
      ambientTypeFiles(["/p/src/page.mx", "/p/src/a.ts"], astroProject, []),
    ).toEqual([]);
  });

  it("never adds a file that is already a root file", () => {
    const [env, jsx] = ambientTypeFiles(["/p/a.astro.mx"], astroProject, []);

    expect(
      ambientTypeFiles(["/p/a.astro.mx", env as string], astroProject, []),
    ).toEqual([jsx]);
  });

  it("asks a third-party host the project loads, as for its other host operations", () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types") },
      install: ["ambient-types"],
    });

    expect(
      ambientTypeFiles([project.path("page.amb.mx")], project.root, []),
    ).toEqual([
      join(project.root, "node_modules/@fake/mx-ambient-types/ambient.d.ts"),
    ]);
    expect(
      ambientTypeFiles([project.path("page.mx")], project.root, []),
    ).toEqual([]);
  });

  it("drops a throwing host's files and reports it once, naming its package", () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types-throws") },
      install: ["ambient-types-throws"],
    });
    const errors: string[] = [];

    expect(
      ambientTypeFiles(
        [project.path("page.ambthrow.mx")],
        project.root,
        errors,
      ),
    ).toEqual([]);
    expect(errors).toEqual([
      "host @fake/mx-ambient-types-throws: ambientTypes threw: cannot find astro install",
    ]);
  });

  it("keeps the other hosts' files when one host throws", () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types-throws") },
      install: ["ambient-types-throws"],
    });
    const errors: string[] = [];

    const files = ambientTypeFiles(
      [project.path("page.astro.mx")],
      project.root,
      errors,
    );

    // No astro install here: the built-in astro host answers with the
    // language server's fallback copies.
    expect(files.map(tail)).toEqual([
      "types/env.d.ts",
      "types/astro-jsx.d.ts",
      "types/jsx-runtime-fallback.d.ts",
    ]);
    expect(errors).toEqual([
      "host @fake/mx-ambient-types-throws: ambientTypes threw: cannot find astro install",
    ]);
  });
});

describe("ambientTypeFiles, a host resolved from the file, not the tsconfig", () => {
  it("asks a host only the file's own package loads, and resolves its files from there", () => {
    // A monorepo: the tsconfig sits at the workspace root, which has no
    // package.json; the host is a dependency of `pkg` alone.
    const workspace = fakeWorkspace();
    const pkg = fakeProject({
      root: join(workspace, "pkg"),
      mx: { target: specifier("ambient-types") },
      install: ["ambient-types"],
    });

    expect(ambientTypeFiles([pkg.path("page.amb.mx")], workspace, [])).toEqual([
      join(pkg.root, "node_modules/@fake/mx-ambient-types/ambient.d.ts"),
    ]);
  });

  it("still asks the tsconfig directory's host for a file outside its package", () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types") },
      install: ["ambient-types"],
    });

    // `/elsewhere` has no package.json: the project's lookup answers.
    expect(
      ambientTypeFiles(["/elsewhere/page.amb.mx"], project.root, []),
    ).toEqual([
      join(project.root, "node_modules/@fake/mx-ambient-types/ambient.d.ts"),
    ]);
  });

  it("asks each package's host once, however many of its files the program holds", () => {
    const workspace = fakeWorkspace();
    const pkg = fakeProject({
      root: join(workspace, "pkg"),
      mx: { target: specifier("ambient-types-throws") },
      install: ["ambient-types-throws"],
    });
    const errors: string[] = [];

    ambientTypeFiles(
      [pkg.path("a.ambthrow.mx"), pkg.path("b.ambthrow.mx")],
      workspace,
      errors,
    );

    expect(errors).toEqual([
      "host @fake/mx-ambient-types-throws: ambientTypes threw: cannot find astro install",
    ]);
  });
});

describe("ambientTypeFiles, a built-in host resolved from a package that uses it", () => {
  // A workspace (no root package.json) whose `docs` package has its own copy
  // of astro but compiles nothing under it, and whose `app` package compiles
  // under astro with another copy. Every lookup holds the built-in astro host,
  // so the root order must not pick which copy answers.
  const installAstro = (dir: string) => {
    const astro = join(dir, "node_modules/astro");
    mkdirSync(astro, { recursive: true });
    writeFileSync(join(astro, "package.json"), '{ "name": "astro" }');
    for (const file of ["env.d.ts", "astro-jsx.d.ts"]) {
      writeFileSync(join(astro, file), "export {};\n");
    }
  };

  it.each([
    ["docs first", true],
    ["app first", false],
  ])(
    "resolves astro's files from the package that selects it (%s)",
    (_, docsFirst) => {
      const workspace = fakeWorkspace();
      const docs = fakeProject({ root: join(workspace, "docs"), mx: {} });
      const app = fakeProject({
        root: join(workspace, "app"),
        mx: { target: "astro-html" },
      });
      installAstro(docs.root);
      installAstro(app.root);
      const roots = [docs.path("readme.ts"), app.path("page.astro.mx")];

      expect(
        ambientTypeFiles(docsFirst ? roots : roots.reverse(), workspace, []),
      ).toEqual([
        join(app.root, "node_modules/astro/env.d.ts"),
        join(app.root, "node_modules/astro/astro-jsx.d.ts"),
      ]);
    },
  );
});

describe("ambientTypeFiles, a host returning no iterable of files", () => {
  const misbehaving = () =>
    fakeProject({
      mx: { target: specifier("ambient-types-misbehaves") },
      install: ["ambient-types-misbehaves"],
    });
  const prefix = "host @fake/mx-ambient-types-misbehaves: ambientTypes";

  it.each([
    [
      "number",
      "a number",
      `${prefix} returned number, expected an iterable of files`,
    ],
    [
      "object",
      "an object without an iterator",
      `${prefix} returned object, expected an iterable of files`,
    ],
    [
      "undefined",
      "undefined",
      `${prefix} returned undefined, expected an iterable of files`,
    ],
    [
      "string",
      "a string (it iterates characters)",
      `${prefix} returned string, expected an iterable of files`,
    ],
    [
      "generator",
      "a generator that throws while read",
      `${prefix} threw: generator failed`,
    ],
    [
      "undefined-entry",
      "[resolve() of a file the package lacks]",
      `${prefix} returned a non-path entry (undefined), expected an iterable of files`,
    ],
    [
      "number-entry",
      "[42]",
      `${prefix} returned a non-path entry (number 42), expected an iterable of files`,
    ],
  ])(
    "reports %s (%s) as one error and adds nothing",
    (mode, _what, message) => {
      const project = misbehaving();
      const errors: string[] = [];

      expect(
        ambientTypeFiles([project.path(`${mode}.ts`)], project.root, errors),
      ).toEqual([]);
      expect(errors).toEqual([message]);
    },
  );

  it("keeps the other hosts' files", () => {
    const project = misbehaving();
    const errors: string[] = [];

    const files = ambientTypeFiles(
      [project.path("number.ts"), project.path("page.astro.mx")],
      project.root,
      errors,
    );

    expect(files.map(tail)).toEqual([
      "types/env.d.ts",
      "types/astro-jsx.d.ts",
      "types/jsx-runtime-fallback.d.ts",
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe("ambientTypeDiagnostics", () => {
  it("is a file-less error carrying the message", () => {
    const [diagnostic] = ambientTypeDiagnostics(ts, ["host x: threw: boom"]);

    expect(diagnostic).toMatchObject({
      file: undefined,
      category: ts.DiagnosticCategory.Error,
      code: 80004,
      messageText: "host x: threw: boom",
    });
    expect(ts.flattenDiagnosticMessageText(diagnostic?.messageText, "\n")).toBe(
      "host x: threw: boom",
    );
  });
});

describe("withAmbientTypes", () => {
  it("lists the ambient files after the project's own, recomputed only when they change", () => {
    let names = ["/p/a.astro.mx"];
    const host = { getScriptFileNames: () => names };
    withAmbientTypes(host, () => astroProject, []);

    const first = host.getScriptFileNames();
    expect(first.slice(0, 1)).toEqual(["/p/a.astro.mx"]);
    expect(first.slice(1).map(tail)).toEqual([
      "astro/env.d.ts",
      "astro/astro-jsx.d.ts",
    ]);
    expect(host.getScriptFileNames()).toBe(first);

    names = ["/p/a.mx"];
    expect(host.getScriptFileNames()).toEqual(["/p/a.mx"]);
  });

  it("still lists the program's own files when a host throws, and records the error", () => {
    const project = fakeProject({
      mx: { target: specifier("ambient-types-throws") },
      install: ["ambient-types-throws"],
    });
    const errors: string[] = [];
    const host = {
      getScriptFileNames: () => [project.path("page.ambthrow.mx")],
    };
    withAmbientTypes(host, () => project.root, errors);

    expect(host.getScriptFileNames()).toEqual([
      project.path("page.ambthrow.mx"),
    ]);
    expect(errors).toEqual([
      "host @fake/mx-ambient-types-throws: ambientTypes threw: cannot find astro install",
    ]);
  });
});
