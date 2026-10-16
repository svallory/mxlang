// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { repoRoot } from "./test-support.ts";

/**
 * A `client` name is `undefined` on the server: the module that renders has
 * `var q;` and no export. `mx-tsc` types the server view of a page that way
 * (the template read, the importers of the page), and keeps the client scope
 * typed by its declarations.
 *
 * Before: `${q.toFixed(2)}` of `client let q = 1` checked clean and threw on
 * the server render, and `import { x }` of a `client export const x` reported
 * nothing (TS2614 before the client statements were projected).
 */

const packages = join(repoRoot, "packages");
const SRC = (path: string) => [join(packages, path)];

function runProject(
  files: Record<string, string>,
  extraOptions: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "mx-client-server-view-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "esnext",
        jsx: "preserve",
        allowArbitraryExtensions: true,
        allowImportingTsExtensions: true,
        ignoreDeprecations: "6.0",
        ...extraOptions,
        baseUrl: ".",
        paths: {
          "@mxlang/target-html": SRC("targets/html/src/index.ts"),
          "@mxlang/core": SRC("core/src/index.ts"),
          "@mxlang/tsx-bridge": SRC("tsx-bridge/src/public.d.ts"),
        },
      },
      files: Object.keys(files),
    }),
  );
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
    dir,
  );
  const output = stripVTControlCharacters(run.stdout + run.stderr)
    .split("\n")
    .map((line) => /[^/\\]+\.(?:mx|ts)\(\d+,\d+\): .*$/.exec(line)?.[0] ?? "")
    .filter(Boolean);
  return {
    linesOf: (file: string) => output.filter((l) => l.startsWith(`${file}(`)),
    dispose: () => rmSync(dir, { recursive: true }),
  };
}

const at = (file: string, position: string) =>
  `^${(file + position).replace(/[.()]/g, "\\$&")}`;

const noise = (lines: string[]) => {
  for (const line of lines) {
    expect(line).not.toContain("an MX bug");
    expect(line).not.toContain("position approximate");
  }
};

/** The page whose client names the importers read. */
const CA = [
  "client export const x = 1;",
  "client export function fx() { return 1 }",
  "server export const sx = 2;",
  "static export const stx = 3;",
  "<div/>",
  "",
].join("\n");

describe("mx-tsc types a client name as undefined for the server view", {
  timeout: 120_000,
}, () => {
  const pages: Record<string, string> = {
    // (d) the template read.
    "read-let.mx": "client let q = 1;\n<div>${q.toFixed(2)}</div>\n",
    "read-function.mx": "client function f() { return 1 }\n<div>${f()}</div>\n",
    "read-class.mx":
      "client class C { m() { return 1 } }\n<div>${new C().m()}</div>\n",
    "read-block.mx": "client { let q = 1 }\n<div>${q.toFixed(2)}</div>\n",
    // Pins: reads that stay clean.
    "pin-handler.mx":
      "client let q = 1;\nclient const g = () => q.toFixed(1);\nclient { function h() { return q + 1 } }\n<div/>\n",
    "pin-client-scope.mx":
      "client let q = 1;\nclient const n: string = q;\n<div/>\n",
    "pin-server-name.mx": "server const s = 5;\n<div>${s.toFixed(1)}</div>\n",
    "pin-server-name-error.mx":
      "server const s = 5;\nserver const t: string = s;\n<div/>\n",
    "pin-static-name.mx": "static const s = 5;\n<div>${s.toFixed(1)}</div>\n",
    "pin-typeof.mx": "client let q = 1;\n<div>${typeof q}</div>\n",
    // Client code that must keep checking clean in its own scope.
    "edge-await.mx":
      "client const d = await Promise.resolve(1);\nclient const n: number = d;\n<div/>\n",
    "edge-import.mx":
      'client import { one as y } from "./one.ts";\nclient const n: number = y;\n<div/>\n',
    "one.ts": "export const one = 1;\n",
    "edge-types.mx":
      "client interface P { a: number }\nclient type K = keyof P;\nexport interface Input { p: P; k?: K }\n<div/>\n",
    "edge-namespace.mx":
      "client namespace N { export const a = 1 }\nclient const n: number = N.a;\n<div/>\n",
    "edge-enum.mx":
      "client enum E { A, B }\nclient const e: E = E.A;\n<div/>\n",
    "edge-two-statements.mx":
      "client let q = 1;\n<div/>\nclient const g = () => q.toFixed(1);\n",
    // A client module cannot load with a top-level `return`.
    "edge-return.mx": "client { return; }\n<div/>\n",
    "edge-return-nested.mx":
      "client { const f = () => { return 1 }; const n: number = f(); }\n<div/>\n",
    // Known limit: a `client import` of another page's client export reports
    // TS2614, because the page's one projection is its server module. This
    // test flips when the follow-up bead `mx-tsc-client-import-reserved-export`
    // lands: then the import is clean and `n` is checked against `number`.
    "limit-client-import.mx":
      'client import { x } from "./ca.mx";\nclient const n: number = x;\n<div/>\n',
    // (e) the importers of `ca.mx`.
    "ca.mx": CA,
    "imp-plain.mx": 'import { x } from "./ca.mx";\n<div>${x}</div>\n',
    "imp-static.mx": 'static import { x } from "./ca.mx";\n<div>${x}</div>\n',
    "imp-server.mx": 'server import { x } from "./ca.mx";\n<div>${x}</div>\n',
    "imp-ts.ts":
      'import { x, fx, sx, stx } from "./ca.mx";\nexport const y = [x, fx, sx, stx];\n',
    // Server and static names of the same page stay importable.
    "imp-server-names.mx":
      'import { sx, stx } from "./ca.mx";\n<div>${sx.toFixed(1)}${stx.toFixed(1)}</div>\n',
  };
  let project: ReturnType<typeof runProject> | undefined;
  beforeAll(() => {
    project = runProject(pages);
  }, 120_000);
  afterAll(() => project?.dispose());
  const lines = (file: string) => {
    if (!project) throw new Error("project did not run");
    const found = project.linesOf(file);
    noise(found);
    return found;
  };

  it.each([
    ["read-let.mx", "(2,8)"],
    ["read-block.mx", "(2,8)"],
  ])("%s: a template read of a client let is undefined", (file, position) => {
    const found = lines(file);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      new RegExp(
        `${at(file, position)}: error TS18048: 'q' is possibly 'undefined'\\.$`,
      ),
    );
  });

  it("read-function.mx: a client function is not callable in the template", () => {
    const found = lines("read-function.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^read-function\.mx\(2,8\): error TS\d+/);
  });

  it("read-class.mx: a client class is not constructible in the template", () => {
    const found = lines("read-class.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^read-class\.mx\(2,12\): error TS\d+/);
  });

  it.each([
    "edge-await.mx",
    "edge-import.mx",
    "edge-types.mx",
    "edge-namespace.mx",
    "edge-enum.mx",
    "edge-two-statements.mx",
    "edge-return-nested.mx",
    "pin-handler.mx",
    "pin-server-name.mx",
    "pin-static-name.mx",
    "pin-typeof.mx",
    "imp-server-names.mx",
  ])("%s stays clean", (file) => {
    expect(lines(file)).toEqual([]);
  });

  it("pin-client-scope.mx: a client read in client code keeps its declared type", () => {
    const found = lines("pin-client-scope.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^pin-client-scope\.mx\(2,14\): error TS2322: Type 'number' is not assignable to type 'string'\.$/,
    );
  });

  it("pin-server-name-error.mx: server names stay typed", () => {
    const found = lines("pin-server-name-error.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^pin-server-name-error\.mx\(2,14\): error TS2322: Type 'number' is not assignable to type 'string'\.$/,
    );
  });

  it.each([
    ["imp-plain.mx", "(1,10)"],
    ["imp-static.mx", "(1,17)"],
    ["imp-server.mx", "(1,17)"],
  ])(
    "%s: importing a client export is TS2614 at the specifier",
    (file, position) => {
      const found = lines(file);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(
        new RegExp(
          `${at(file, position)}: error TS2614: Module '"\\./ca\\.mx"' has no exported member 'x'`,
        ),
      );
    },
  );

  it("imp-ts.ts: a .ts importer sees only the server names", () => {
    const found = lines("imp-ts.ts");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^imp-ts\.ts\(1,10\): error TS2614: .*'x'/);
    expect(found[1]).toMatch(/^imp-ts\.ts\(1,13\): error TS2614: .*'fx'/);
  });

  it("edge-return.mx: a top-level return in a client block is still TS1108, at the return", () => {
    const found = lines("edge-return.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^edge-return\.mx\(1,10\): error TS1108: A 'return' statement can only be used within a function body\.$/,
    );
  });

  it("limit-client-import.mx: KNOWN LIMIT, a client import of a client export is TS2614", () => {
    const found = lines("limit-client-import.mx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^limit-client-import\.mx\(1,17\): error TS2614: Module '"\.\/ca\.mx"' has no exported member 'x'/,
    );
  });
});

describe("mx-tsc: an exported client name is not an unused local", {
  timeout: 120_000,
}, () => {
  it("noUnusedLocals stays quiet about client exports", () => {
    const project = runProject(
      {
        "exports.mx":
          "client export const x = 1;\nclient export function f() {}\n<div/>\n",
      },
      { noUnusedLocals: true },
    );
    try {
      expect(project.linesOf("exports.mx")).toEqual([]);
    } finally {
      project.dispose();
    }
  });
});
