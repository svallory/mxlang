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

describe("a server-only name in client code", { timeout: 60_000 }, () => {
  it.each([
    [
      "a server let",
      "server let s = 1;\nclient const n = s.toFixed(1);\n<div/>\n",
      "s.toFixed",
    ],
    [
      "a server const",
      "server const s = 1;\nclient const n = s.toFixed(1);\n<div/>\n",
      "s.toFixed",
    ],
    [
      "a server import",
      'server import { one as s } from "./one.ts";\nclient const n = s.toFixed(1);\n<div/>\n',
      "s.toFixed",
    ],
  ])(
    "%s is undefined in client code, reported at the read",
    (_name, source, needle) => {
      const found = errorsOf(
        { [FILE]: source, "/project/one.ts": "export const one = 1;\n" },
        FILE,
      );
      expect(found.map((diagnostic) => diagnostic.code)).toEqual([18048]);
      expect(found[0]?.start).toBe(source.indexOf(needle));
    },
  );

  it.each([
    ["two vars", "server var s = 1;\nclient var s = 2;\n<div/>\n"],
    [
      "two namespaces",
      "server namespace N { export const a = 1 }\nclient namespace N { export const b = 2 }\nclient const t = N.b;\n<div>${N.a}</div>\n",
    ],
  ])(
    "%s merged across server and client exist on both sides",
    (_name, source) => {
      expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
    },
  );

  it.each([
    [
      "a static and a client namespace",
      "static namespace N { export const a = 1 }\nclient namespace N { export const b = 2 }\n<div>${N.a}</div>\n",
    ],
    [
      "a static and a client var",
      "static var s = 1;\nclient var s = 2;\n<div>${s}</div>\n",
    ],
    [
      "a server var and a client for-loop var",
      "server var i = 0;\nclient for (var i = 0; i < 3; i++) {}\n<div/>\n",
    ],
  ])("%s merge: the name exists on both sides", (_name, source) => {
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("a client label spelled like a server var checks clean, and a client read is undefined", () => {
    const label = "server var x = 1;\nclient x: for (;;) { break x }\n<div/>\n";
    expect(errorsOf({ [FILE]: label }, FILE)).toEqual([]);
    const read = `${label}client const t = x.toFixed(1);\n`;
    const found = errorsOf({ [FILE]: read }, FILE);
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([18048]);
    expect(found[0]?.start).toBe(read.indexOf("x.toFixed"));
  });

  it("a nested client var is unknown in the template, as the runtime declares none", () => {
    const source =
      "client for (var i = 0; i < 3; i++) {}\n<div>${i.toFixed(1)}</div>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([2304]);
    expect(found[0]?.start).toBe(source.indexOf("i.toFixed"));
  });

  it("a client for-of head is undefined in the template, as the runtime declares it", () => {
    const source =
      "client for (const x of [1]) {}\n<div>${x.toFixed(1)}</div>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([18048]);
    expect(found[0]?.start).toBe(source.indexOf("x.toFixed"));
  });

  it("a merged name does not strand a type that mentions it", () => {
    const source =
      "server var s = 1;\nclient var s = 2;\nclient type T = typeof s;\nexport interface Input { t: T }\n<div/>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("a template binding of a refinement's name checks against the binding", () => {
    const source =
      "client declare function fmt(x: string): string;\n<const/fmt=(v: number) => v/>\n<let/q=1/>\n<input value:fmt:=q/>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("rename at a refinement's name reaches the client import", () => {
    const source =
      'client import { clamp } from "./fn.ts";\n<let/q=1/>\n<input value:clamp:=q/>\n';
    const svc = service({
      [FILE]: source,
      "/project/fn.ts": "export const clamp = (n: number) => n;\n",
    });
    svc.getSemanticDiagnostics(CONSUMER);
    const found = svc.findRenameLocations(
      FILE,
      source.indexOf("clamp:=q"),
      false,
      false,
    );
    expect(
      found?.some(
        (location) =>
          location.fileName === FILE &&
          location.textSpan.start === source.indexOf("clamp }"),
      ),
    ).toBe(true);
  });

  it("KNOWN LIMIT: the body of a client namespace reads a server name typed", () => {
    // A namespace is hoisted to module level, outside the client arrow that
    // shadows server names, so its body is not checked against them.
    const source =
      "server const secret = 1;\nclient namespace Api { export const k = secret.toFixed(1) }\n<div/>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });

  it("KNOWN LIMIT: a type query of a server name reads the undefined shadow", () => {
    const source =
      'server import { f } from "./fn.ts";\nclient let r: ReturnType<typeof f> | null = null;\n<div/>\n';
    const found = errorsOf(
      { [FILE]: source, "/project/fn.ts": "export const f = () => 1;\n" },
      FILE,
    );
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([2344]);
  });

  it("a server name read by server code stays typed", () => {
    const source =
      "server const s = 1;\nserver const n: number = s;\n<div>${s.toFixed(1)}</div>\n";
    expect(errorsOf({ [FILE]: source }, FILE)).toEqual([]);
  });
});

describe("a client import, namespace or declare in the server view", {
  timeout: 60_000,
}, () => {
  it.each([
    [
      "a client import",
      'client import { one as y } from "./one.ts";\n<div>${y.toFixed(1)}</div>\n',
      "y.toFixed",
    ],
    [
      "a client namespace",
      "client namespace N { export const a = 1 }\n<div>${N.a.toFixed(1)}</div>\n",
      "N.a.toFixed",
    ],
    [
      "a client declare",
      "client declare const d: number;\n<div>${d.toFixed(1)}</div>\n",
      "d.toFixed",
    ],
  ])(
    "%s is undefined in a template read, at the read",
    (_name, source, needle) => {
      const found = errorsOf(
        { [FILE]: source, "/project/one.ts": "export const one = 1;\n" },
        FILE,
      );
      expect(found.map((diagnostic) => diagnostic.code)).toEqual([18048]);
      expect(found[0]?.start).toBe(source.indexOf(needle));
    },
  );

  it("a qualified client namespace is undefined at its leftmost name", () => {
    const source =
      "client namespace A.B { export const x = 1 }\n<div>${A.B.x.toFixed(1)}</div>\n";
    const found = errorsOf({ [FILE]: source }, FILE);
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([18048]);
    expect(found[0]?.start).toBe(source.indexOf("A.B.x"));
  });

  it("a refinement from a client import checks against the client binding", () => {
    const source =
      'client import { clamp } from "./fn.ts";\n<let/q=1/>\n<input value:clamp:=q/>\n';
    expect(
      errorsOf(
        {
          [FILE]: source,
          "/project/fn.ts": "export const clamp = (n: number) => n;\n",
        },
        FILE,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a declare const",
      "client declare const count: number;\n<let/count=0/>\n<div>${count}</div>\n",
    ],
    [
      "a declare function",
      "client declare function f(): number;\n<const/f=1/>\n<div>${f}</div>\n",
    ],
    [
      "an import spelled input",
      'client import { input } from "./x.ts";\nexport interface Input { a: number }\n<div>${input.a}</div>\n',
    ],
  ])(
    "%s that a template variable or the render parameter shares checks clean",
    (_name, source) => {
      expect(
        errorsOf(
          { [FILE]: source, "/project/x.ts": "export const input = 1;\n" },
          FILE,
        ),
      ).toEqual([]);
    },
  );

  it("a refinement from a client import does not type the template's own read", () => {
    const source =
      'client import { clamp } from "./fn.ts";\n<let/q=1/>\n<input value:clamp:=q/>\n<div>${clamp(5)}</div>\n';
    const found = errorsOf(
      {
        [FILE]: source,
        "/project/fn.ts": "export const clamp = (n: number) => n;\n",
      },
      FILE,
    );
    expect(found.map((diagnostic) => diagnostic.code)).toEqual([2722]);
    expect(found[0]?.start).toBe(source.indexOf("clamp(5)"));
  });

  it("KNOWN LIMIT: a server statement still reads a client import typed", () => {
    // The import is one module-level binding; the server statement is module
    // level too, so the shadow the render function uses is not available there.
    const source =
      'client import { one as y } from "./one.ts";\nserver const z = y.toFixed(1);\n<div/>\n';
    expect(
      errorsOf(
        { [FILE]: source, "/project/one.ts": "export const one = 1;\n" },
        FILE,
      ),
    ).toEqual([]);
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
