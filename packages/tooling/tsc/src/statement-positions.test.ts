// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { repoRoot } from "./test-support.ts";

/**
 * A type error inside a `server` or `client` statement is reported at the
 * token the author wrote. Before, a `server` statement's error was reported at
 * 1:1 as "an MX bug" (the html target hoists its text to module scope with no
 * mapping) and a `client` statement was not type-checked at all (the module
 * kept only `var <names>;`). Under `typeCheck` the target now maps `server`
 * code and projects each `client` statement's own code, mapped.
 *
 * One throwaway project per strictness; one page per case, so each case's
 * diagnostics are its own file's lines.
 */

const packages = join(repoRoot, "packages");
const SRC = (path: string) => [join(packages, path)];

interface Project {
  dir: string;
  /** The lines `mx-tsc` printed for each page, by file name. */
  linesOf: (file: string) => string[];
}

function runProject(
  files: Record<string, string>,
  strict: boolean,
): Project & { dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mx-statement-positions-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict,
        skipLibCheck: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "esnext",
        allowImportingTsExtensions: true,
        ignoreDeprecations: "6.0",
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
  // tsc prints the path relative to the cwd; keep from the file name.
  const output = stripVTControlCharacters(run.stdout + run.stderr)
    .split("\n")
    .map((line) => /[^/\\]+\.(?:mx|ts)\(\d+,\d+\): .*$/.exec(line)?.[0] ?? "")
    .filter(Boolean);
  return {
    dir,
    linesOf: (file) => output.filter((line) => line.startsWith(`${file}(`)),
    dispose: () => rmSync(dir, { recursive: true }),
  };
}

/** One page: its source and the diagnostics it must print, exactly. */
type Case = [source: string, expected: RegExp[]];

const TS2322 = (position: string, from: string, to: string) =>
  new RegExp(
    `^${position.replace(/[()]/g, "\\$&")}: error TS2322: Type '${from}' is not assignable to type '${to}'\\.$`,
  );

/** Shapes a `server` and a `client` statement both take, with the keyword. */
function shapes(keyword: "server" | "client"): Record<string, Case> {
  const at = (line: number, column: number, file: string) =>
    `${file}.mx(${line},${column})`;
  return {
    [`${keyword}-one-line`]: [
      `${keyword} const a: number = "x";\n<div/>\n`,
      [TS2322(at(1, 14, `${keyword}-one-line`), "string", "number")],
    ],
    [`${keyword}-block`]: [
      `${keyword} {\n  const a: number = "x";\n}\n<div/>\n`,
      [TS2322(at(2, 9, `${keyword}-block`), "string", "number")],
    ],
    [`${keyword}-block-second-line`]: [
      `<div/>\n${keyword} {\n  const ok = 1;\n  const bad: string = ok;\n}\n`,
      [TS2322(at(4, 9, `${keyword}-block-second-line`), "number", "string")],
    ],
    [`${keyword}-line-3`]: [
      `<div/>\n<span/>\n${keyword} const b: string = 1;\n`,
      [TS2322(at(3, 14, `${keyword}-line-3`), "number", "string")],
    ],
    [`${keyword}-undeclared`]: [
      `${keyword} const c = nope + 1;\n<div/>\n`,
      [
        new RegExp(
          `^${keyword}-undeclared\\.mx\\(1,18\\): error TS2304: Cannot find name 'nope'\\.$`,
        ),
      ],
    ],
    [`${keyword}-export`]: [
      `${keyword} export const e: number = "x";\n<div/>\n`,
      [TS2322(at(1, 21, `${keyword}-export`), "string", "number")],
    ],
    [`${keyword}-import`]: [
      `${keyword} import { nothing } from "./missing";\n<div/>\n`,
      [
        new RegExp(
          `^${keyword}-import\\.mx\\(1,32\\): error TS2307: Cannot find module './missing'`,
        ),
      ],
    ],
    [`${keyword}-after-static`]: [
      `${keyword} const a = 1;\nstatic const b = 2;\n${keyword} const c: string = a + b;\n<div/>\n`,
      [TS2322(at(3, 14, `${keyword}-after-static`), "number", "string")],
    ],
    [`${keyword}-crlf`]: [
      `${keyword} const a: number = "x";\r\n<div/>\r\n`,
      [TS2322(at(1, 14, `${keyword}-crlf`), "string", "number")],
    ],
    [`${keyword}-clean`]: [`${keyword} const a: number = 1;\n<div/>\n`, []],
  };
}

const clientOnly: Record<string, Case> = {
  "client-class": [
    'client class K { x: number = "s"; }\n<div/>\n',
    [TS2322("client-class.mx(1,18)", "string", "number")],
  ],
  "client-enum": [
    'client enum E { A, B }\nclient const e: E = "x";\n<div/>\n',
    [TS2322("client-enum.mx(2,14)", '"x"', "E")],
  ],
  "client-destructuring": [
    "client const { a } = { a: 1 };\nclient const n: string = a;\n<div/>\n",
    [TS2322("client-destructuring.mx(2,14)", "number", "string")],
  ],
  "client-function": [
    "client function f(): number { return 1; }\n<div>${f()}</div>\n",
    [],
  ],
};

function expectCases(project: Project, cases: Record<string, Case>) {
  for (const [name, [, expected]] of Object.entries(cases)) {
    const lines = project.linesOf(`${name}.mx`);
    expect(lines, name).toHaveLength(expected.length);
    expected.forEach((pattern, index) => {
      expect(lines[index], name).toMatch(pattern);
    });
    // Reported at the authored token: never the 1:1 fallback.
    for (const line of lines) {
      expect(line, name).not.toContain("an MX bug");
      expect(line, name).not.toContain("position approximate");
    }
  }
}

const sourcesOf = (cases: Record<string, Case>) =>
  Object.fromEntries(
    Object.entries(cases).map(([name, [source]]) => [`${name}.mx`, source]),
  );

describe("mx-tsc reports a server or client statement's error at the authored token", () => {
  const cases = { ...shapes("server"), ...shapes("client"), ...clientOnly };
  let project: (Project & { dispose: () => void }) | undefined;
  beforeAll(() => {
    project = runProject(sourcesOf(cases), false);
  }, 120_000);
  afterAll(() => project?.dispose());

  for (const name of Object.keys(cases)) {
    it(name, () => {
      if (!project) throw new Error("project did not run");
      expectCases(project, { [name]: cases[name] as Case });
    });
  }
});

describe("mx-tsc under strict: a client declaration keeps its type", () => {
  const cases: Record<string, Case> = {
    // The template reads each name; `let`/`function` have their declared types.
    "client-let-function-read": [
      "client let q = 1;\nclient function f() {}\n<div>${q}${f}</div>\n",
      [],
    ],
    "client-const-read": [
      'client const a: number = "x";\n<div>${a}</div>\n',
      [TS2322("client-const-read.mx(1,14)", "string", "number")],
    ],
    "server-const-read": ["server const s: number = 1;\n<div>${s}</div>\n", []],
    "client-unread": [
      "client let q = 1;\nclient function f() {}\n<div/>\n",
      [],
    ],
  };
  // `client var q;` has no type in plain TypeScript either: what `tsc` says
  // about the same declaration in a `.ts` file is what `mx-tsc` says here,
  // at the declared name.
  const plain = "var q;\nexport const read = () => q;\n";
  const varPage = "client var q;\n<div>${q}</div>\n";
  let project: (Project & { dispose: () => void }) | undefined;
  beforeAll(() => {
    project = runProject(
      {
        ...sourcesOf(cases),
        "client-var-read.mx": varPage,
        "plain.ts": plain,
      },
      true,
    );
  }, 120_000);
  afterAll(() => project?.dispose());

  for (const name of Object.keys(cases)) {
    it(name, () => {
      if (!project) throw new Error("project did not run");
      expectCases(project, { [name]: cases[name] as Case });
    });
  }

  it("client var with no initializer: the same code at the same name as in a .ts file", () => {
    if (!project) throw new Error("project did not run");
    const codes = (lines: string[]) =>
      lines.map((line) => /error (TS\d+):/.exec(line)?.[1]).sort();
    const plainLines = project.linesOf("plain.ts");
    const mxLines = project.linesOf("client-var-read.mx");
    expect(plainLines.length).toBeGreaterThan(0);
    expect(codes(mxLines)).toEqual(codes(plainLines));
    // TS7034 is reported at the declared name: `q` in `var q;` and in
    // `client var q;`.
    const declared = (lines: string[], file: string) =>
      lines.find((line) => line.includes("TS7034"))?.slice(file.length);
    expect(declared(plainLines, "plain.ts")).toMatch(/^\(1,5\): /);
    expect(declared(mxLines, "client-var-read.mx")).toMatch(/^\(1,12\): /);
    for (const line of mxLines) {
      expect(line).not.toContain("an MX bug");
      expect(line).not.toContain("position approximate");
    }
  });
});
