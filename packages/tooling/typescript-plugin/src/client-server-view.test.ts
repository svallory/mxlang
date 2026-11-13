// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createPluginService } from "./fixtures/plugin-service.ts";

/**
 * A `client` name is `undefined` in the server view: the module that renders
 * has `var q;` and no export. The editor path types it that way (the template
 * read, the importers of the page) and keeps the client scope typed by its
 * declarations. This suite owns the matching projection semantics;
 * `mx-tsc` smoke-tests the printed diagnostic door in
 * `packages/tooling/tsc/src/client-server-view.test.ts`, retaining source
 * shapes and CLI-specific checks with no equally strict home here.
 */

const FILE = "/project/page.mx";
const CA = "/project/ca.mx";
const CONSUMER = "/project/index.ts";

const CA_SOURCE =
  "client export const x = 1;\nserver export const sx = 2;\n<div/>\n";

function service(files: Record<string, string>) {
  return createPluginService(
    { [CONSUMER]: 'import "./page.mx";\n', ...files },
    [CONSUMER, ...Object.keys(files).filter((file) => file.endsWith(".ts"))],
  );
}

function errorsOf(
  files: Record<string, string>,
  file: string,
  ignore: number[] = [2307],
) {
  const svc = service(files);
  svc.getSemanticDiagnostics(CONSUMER);
  return svc
    .getSemanticDiagnostics(file)
    .filter((diagnostic) => !ignore.includes(diagnostic.code));
}

// ts-plugin-tsserver-test-timeouts: each test builds the plugin's language
// service (1.2-2.0 s per test in a full gate); see statement-positions.test.ts.
describe("a client name in the server view", { timeout: 60_000 }, () => {
  it("a template read of a client let is undefined, at the read", () => {
    const source = "client let q = 1;\n<div>${q.toFixed(2)}</div>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(18048);
    expect(found[0]?.start).toBe(source.indexOf("q.toFixed"));
    expect(found[0]?.length).toBe(1);
  });

  it("a client function and class cannot be used in the template", () => {
    const source =
      "client function f() { return 1 }\nclient class C {}\n<div>${f()}${new C()}</div>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found.map((diagnostic) => diagnostic.start)).toEqual([
      source.indexOf("f()}"),
      source.indexOf("C()}"),
    ]);
  });

  it("a client read in a handler or block stays clean", () => {
    const source =
      "client let q = 1;\nclient const g = () => q.toFixed(1);\nclient { function h() { return q + 1 } }\n<div/>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("server and static names stay typed", () => {
    const source =
      "server const s = 5;\nstatic const t = 6;\n<div>${s.toFixed(1)}${t.toFixed(1)}</div>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("a top-level return in a client block is still reported, at the return", () => {
    const source = "client { return; }\n<div/>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(1108);
    expect(found[0]?.start).toBe(source.indexOf("return"));
  });

  it("hover on a client name in the client scope is its declared type", () => {
    const source = "client let q = 1;\nclient const r = q + 1;\n<div/>\n";
    const svc = service({ [FILE]: source });
    svc.getSemanticDiagnostics(CONSUMER);
    const hover = svc.getQuickInfoAtPosition(FILE, source.indexOf("q + 1"));
    const text = ts.displayPartsToString(hover?.displayParts);
    expect(text).toContain("let q: number");
  });

  it("completions after a client name in the client scope are the declared type's", () => {
    const source =
      "client let q = 1;\nclient const r = q.toFixed(1);\n<div/>\n";
    const svc = service({ [FILE]: source });
    svc.getSemanticDiagnostics(CONSUMER);
    const completions = svc.getCompletionsAtPosition(
      FILE,
      source.indexOf("toFixed"),
      {},
    );
    const names = completions?.entries.map((entry) => entry.name) ?? [];
    expect(names).toContain("toFixed");
  });
});

describe("client code keeps its own scope and order", {
  timeout: 60_000,
}, () => {
  it("a type that names a client class stays usable in client code", () => {
    const source =
      "client class C {}\nclient interface P { c: C }\nclient const p: P = { c: new C() };\n<div/>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("a type that names no client value is importable from a .ts file", () => {
    const types =
      "client export interface P { n: number }\nclient export type K = keyof P;\n<div/>\n";
    const source =
      'import type { P, K } from "./ct.mx";\nexport const v: [P?, K?] = [];\n';
    expect(
      errorsOf(
        { "/project/ct.mx": types, "/project/other.ts": source },
        "/project/other.ts",
      ),
    ).toEqual([]);
  });

  it("a client statement reading a later static is used before its declaration, at the read", () => {
    const source = "client const z = st + 1;\nstatic const st = 1;\n<div/>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found.map((diagnostic) => diagnostic.code)).toContain(2448);
    expect(found[0]?.code).toBe(2448);
    expect(found[0]?.start).toBe(source.indexOf("st +"));
  });

  it("a top-level this in client code is not an error", () => {
    expect(
      errorsOf({ [FILE]: "client console.log(this);\n<div/>\n" }, FILE),
    ).toEqual([]);
  });

  it("client export … from still reports an unknown name, at the name", () => {
    const source = 'client export { nope } from "./one.ts";\n<div/>\n';
    const found = errorsOf(
      { [FILE]: source, "/project/one.ts": "export const one = 1;\n" },
      FILE,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(2305);
    expect(found[0]?.start).toBe(source.indexOf("nope"));
  });
});

describe("importing a client export", { timeout: 60_000 }, () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "a plain import",
      "page.mx",
      'import { x } from "./ca.mx";\n<div/>\n',
      "x }",
    ],
    [
      "a static import",
      "page.mx",
      'static import { x } from "./ca.mx";\n<div/>\n',
      "x }",
    ],
    [
      "a server import",
      "page.mx",
      'server import { x } from "./ca.mx";\n<div/>\n',
      "x }",
    ],
    [
      "a .ts importer",
      "other.ts",
      'import { x } from "./ca.mx";\nexport { x };\n',
      "x }",
    ],
  ];

  it.each(cases)(
    "%s: TS2614 at the specifier",
    (_name, file, source, needle) => {
      const path = `/project/${file}`;
      const found = errorsOf({ [path]: source, [CA]: CA_SOURCE }, path);
      expect(found).toHaveLength(1);
      expect(found[0]?.code).toBe(2614);
      expect(found[0]?.start).toBe(source.indexOf(needle));
    },
  );

  it("a server export stays importable", () => {
    const source =
      'import { sx } from "./ca.mx";\n<div>${sx.toFixed(1)}</div>\n';
    expect(errorsOf({ [FILE]: source, [CA]: CA_SOURCE }, FILE)).toEqual([]);
  });

  // Known limit: a `client import` of another page's client export is
  // reported, because the page's one projection is its server module; the
  // client view's alias reports it as an unknown member of the module
  // (TS2694), at the specifier. This test flips when a client import of
  // a client export is supported: the import is then clean.
  it("KNOWN LIMIT: a client import of a client export is TS2694", () => {
    const source = 'client import { x } from "./ca.mx";\n<div/>\n';
    const found = errorsOf({ [FILE]: source, [CA]: CA_SOURCE }, FILE);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(2694);
    expect(found[0]?.start).toBe(source.indexOf("x }"));
  });
});

/**
 * The two views of a page's module statements through the editor path: each
 * diagnostic at the authored token, and navigation from client code to the
 * `client import` that binds a name. The full source matrix is the html
 * target's `client-server-scope.test.ts`; the rows here are the mapping paths
 * it cannot see (the target's own mappings, and a verbatim `static` statement
 * or `Input` interface the tools map from the IR). One service holds every
 * page, built once for the file.
 */
describe("the server and client views, at the authored token", {
  timeout: 60_000,
}, () => {
  const ONE = "/project/one.ts";
  const ONE_SOURCE =
    "export function clamp(v: number): number { return v }\nexport const one = 1;\nexport interface Row { a: number }\n";
  const PAGES = {
    serverName:
      "server const secret = 1;\nclient const n = secret.toFixed(1);\n<div/>\n",
    template:
      'client import { one } from "./one.ts";\n<div>${one.toFixed(1)}</div>\n',
    static:
      'client import { one } from "./one.ts";\nstatic const z = one.toFixed(1);\n<div/>\n',
    inputType:
      'client import { Row } from "./one.ts";\nexport interface Input { r?: Row }\n<div/>\n',
    refinement:
      "client function clamp(v: number) { return v }\n<let/q=1/>\n<input value:clamp:=q/>\n",
    refinementImport:
      'client import { clamp } from "./one.ts";\n<let/q=1/>\n<input value:clamp:=q/>\n',
    definition:
      'client import { one } from "./one.ts";\nclient const n = one + 1;\n<div/>\n',
  };
  type Page = keyof typeof PAGES;
  const path = (page: Page) => `/project/${page}.mx`;
  let built: ts.LanguageService | undefined;
  const svc = () => {
    if (!built) {
      const pages = Object.keys(PAGES) as Page[];
      const consumer = pages.map((page) => `import "./${page}.mx";\n`).join("");
      built = createPluginService(
        {
          [CONSUMER]: consumer,
          [ONE]: ONE_SOURCE,
          ...Object.fromEntries(pages.map((page) => [path(page), PAGES[page]])),
        },
        [CONSUMER, ONE],
      );
      built.getSemanticDiagnostics(CONSUMER);
    }
    return built;
  };
  const spans = (page: Page) =>
    svc()
      .getSemanticDiagnostics(path(page))
      .filter((d) => d.code !== 2307)
      .map((d) => [
        d.code,
        PAGES[page].slice(d.start ?? 0, (d.start ?? 0) + (d.length ?? 0)),
        d.start,
      ]);

  it("client code reading a server name is undefined, at the name", () => {
    expect(spans("serverName")).toEqual([
      [18048, "secret", PAGES.serverName.indexOf("secret.toFixed")],
    ]);
  });

  it("a template read of a client import is undefined, at the read", () => {
    expect(spans("template")).toEqual([
      [18048, "one", PAGES.template.indexOf("one.toFixed")],
    ]);
  });

  it("a static statement reading a client import is undefined, at the read", () => {
    expect(spans("static")).toEqual([
      [18048, "one", PAGES.static.indexOf("one.toFixed")],
    ]);
  });

  it("a module-level type naming a client value import is reported, at the name", () => {
    expect(spans("inputType")).toEqual([
      [2749, "Row", PAGES.inputType.lastIndexOf("Row }")],
    ]);
  });

  it("a refinement naming a client function checks clean", () => {
    expect(spans("refinement")).toEqual([]);
  });

  // TypeScript answers an imported name's definition with the declaration in
  // the imported module (it skips the import, as in a .ts file): the client
  // read resolves through the client view's alias to what the import names.
  it("definition at a client read of an import reaches the imported declaration", () => {
    const found = (
      svc().getDefinitionAtPosition(
        path("definition"),
        PAGES.definition.indexOf("one + 1"),
      ) ?? []
    ).map((d) => [d.fileName, d.textSpan.start]);
    expect(found).toEqual([[ONE, ONE_SOURCE.indexOf("one = 1")]]);
  });

  // The refinement token is read twice: by the probe (diagnostics and
  // navigation; the server view's `undefined` there is generated, so its
  // declaration is dropped) and in the client function (navigation and
  // hover), where TypeScript's scope finds the client binding.
  const TOKEN = PAGES.refinement.indexOf("clamp:=q");
  const DECLARATION = PAGES.refinement.indexOf("clamp(");

  it("definition at a refinement token reaches the client declaration", () => {
    const found = (
      svc().getDefinitionAtPosition(path("refinement"), TOKEN) ?? []
    ).map((d) => [d.fileName, d.textSpan.start, d.textSpan.length]);
    expect(found).toEqual([[path("refinement"), DECLARATION, 5]]);
  });

  it("rename from the client declaration includes the refinement token", () => {
    const found = (
      svc().findRenameLocations(path("refinement"), DECLARATION, false, false, {
        providePrefixAndSuffixTextForRename: false,
      }) ?? []
    )
      .map((d) => [d.fileName, d.textSpan.start, d.textSpan.length])
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    expect(found).toEqual([
      [path("refinement"), DECLARATION, 5],
      [path("refinement"), TOKEN, 5],
    ]);
  });

  it("hover at a refinement token shows the client binding's type", () => {
    const info = svc().getQuickInfoAtPosition(path("refinement"), TOKEN);
    expect(ts.displayPartsToString(info?.displayParts)).toBe(
      "(local function) clamp(v: number): number",
    );
  });

  it("definition at a refinement token naming a client import reaches the imported declaration", () => {
    const found = (
      svc().getDefinitionAtPosition(
        path("refinementImport"),
        PAGES.refinementImport.indexOf("clamp:=q"),
      ) ?? []
    ).map((d) => [d.fileName, d.textSpan.start]);
    expect(found).toEqual([[ONE, ONE_SOURCE.indexOf("clamp(")]]);
  });
});
