// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createPluginService } from "./fixtures/plugin-service.ts";

/**
 * A `client` name is `undefined` in the server view: the module that renders
 * has `var q;` and no export. The editor path types it that way (the template
 * read, the importers of the page) and keeps the client scope typed by its
 * declarations. `mx-tsc` pins the same rules in
 * `packages/tooling/tsc/src/client-server-view.test.ts`.
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
    const source = "client let q = 1;\nclient const r = q.toFixed(1);\n<div/>\n";
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

  // Known limit: a `client import` of another page's client export reports
  // TS2614, because the page's one projection is its server module. This test
  // flips when the follow-up bead `mx-tsc-client-import-reserved-export`
  // lands: the import is then clean.
  it("KNOWN LIMIT: a client import of a client export is TS2614", () => {
    const source = 'client import { x } from "./ca.mx";\n<div/>\n';
    const found = errorsOf({ [FILE]: source, [CA]: CA_SOURCE }, FILE);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe(2614);
    expect(found[0]?.start).toBe(source.indexOf("x }"));
  });
});
