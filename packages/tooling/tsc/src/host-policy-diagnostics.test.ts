import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { mxTsc } from "./test-support.ts";

/**
 * Host-policy diagnostics (an unknown `mx.host`, a malformed `package.json`)
 * reach `mx-tsc`'s output, positioned in the `package.json`, as warnings:
 * nothing that exited 0 before starts failing, and a malformed manifest is no
 * longer a silent pass. Shapes follow audit cases h23, h24 and a24. Trees are
 * built in a temp dir (a committed malformed `package.json` would trip every
 * tool that globs the repo).
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    jsx: "preserve",
    types: [],
    allowImportingTsExtensions: true,
    experimentalDecorators: true,
  },
  include: ["src"],
});

function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-hp-diag-")));
  created.push(dir);
  for (const [path, text] of Object.entries({
    "tsconfig.json": TSCONFIG,
    ...files,
  })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/**
 * `mx-tsc --noEmit -p tsconfig.json` in `dir`: ANSI-stripped output and exit.
 * `spawn` runs the built binary with `dir` as its cwd. An exit code that
 * depends on how `package.json` is read must be asserted that way: the
 * in-process helper keeps the test runner's cwd, and Babel (under Marko's
 * compiler) reads a malformed `package.json` differently depending on it.
 */
function check(dir: string, spawn = false): { status: number; text: string } {
  const run = spawn
    ? (() => {
        const child = spawnSync(
          process.execPath,
          [mxTsc, "--noEmit", "-p", "tsconfig.json"],
          { cwd: dir, encoding: "utf8" },
        );
        return {
          status: child.status ?? -1,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      })()
    : runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
  return {
    status: run.status,
    // tsc prints paths relative to the cwd (`../../..<dir>/…` from a temp dir).
    text: stripVTControlCharacters(run.stdout + run.stderr).replace(
      new RegExp(`(?:\\.\\./)*${dir.replaceAll("/", "\\/")}`, "g"),
      "<dir>",
    ),
  };
}

const HTML_FILES = {
  "src/pages/page.mx": "<div><p>hi</p></div>\n",
  "src/main.ts":
    'import render from "./pages/page.mx";\nconsole.log(render({}));\n',
};

const UNKNOWN_HOST = [
  "{",
  '  "name": "afa",',
  '  "type": "module",',
  '  "mx": {',
  '    "host": "vue"',
  "  }",
  "}",
  "",
].join("\n");

// Each case runs `mx-tsc` in this process; under a loaded machine (the whole
// package's files in parallel) one can pass vitest's 5 s default.
describe("mx-tsc prints host-policy diagnostics", { timeout: 60_000 }, () => {
  it("h23: an unknown mx.host is a warning at the value, and the exit code stays 0", () => {
    const dir = project({ ...HTML_FILES, "package.json": UNKNOWN_HOST });

    const { status, text } = check(dir);

    expect(text).toContain(
      '<dir>/package.json(5,13): warning TS80003: unknown mx.host "vue"; valid hosts:',
    );
    expect(text).toContain("Ignoring it; the host is taken from");
    expect(status).toBe(0);
  });

  it("h24: a malformed package.json is a warning at the parse error, and the exit code is not changed", () => {
    const control = check(
      project({
        ...HTML_FILES,
        "package.json": '{ "name": "afa", "mx": { "host": "html" } }',
      }),
      true,
    );
    const dir = project({
      ...HTML_FILES,
      "package.json":
        '{ "name": "afa", "type": "module", "mx": { "host": "preact", }',
    });

    const { status, text } = check(dir, true);

    expect(text).toMatch(
      /(?:^|\n)package\.json\(1,\d+\): warning TS80003: <dir>\/package\.json could not be parsed as JSON: /,
    );
    expect(text).toContain('using the default "html" host');
    expect(status, text).toBe(control.status);
    expect(control.status).toBe(0);
  });

  it("a24: an unknown mx.host beside a .ng.mx is printed too", () => {
    const dir = project({
      "package.json": JSON.stringify(
        {
          name: "afa",
          mx: { host: "angualr", angular: { diagnostics: "off" } },
        },
        null,
        2,
      ),
      "src/app/x.component.ng.mx":
        'export class XComponent {\n  title = "hi";\n  template = <div><p>hi</p></div>;\n}\n',
    });

    const { text } = check(dir);

    expect(text).toContain(
      '<dir>/package.json(4,13): warning TS80003: unknown mx.host "angualr"',
    );
    expect(text).toContain('Did you mean "angular"?');
  });

  it("prints a diagnostic once however many files share the package.json", () => {
    const dir = project({
      "package.json": UNKNOWN_HOST,
      "src/pages/page.mx": "<div></div>\n",
      "src/pages/other.mx": "<div></div>\n",
      "src/main.ts":
        'import a from "./pages/page.mx";\nimport b from "./pages/other.mx";\nconsole.log(a({}), b({}));\n',
    });

    const { text } = check(dir);

    expect(text.split("unknown mx.host").length - 1).toBe(1);
  });

  it("prints nothing for a valid host", () => {
    const dir = project({
      ...HTML_FILES,
      "package.json": '{ "name": "afa", "mx": { "host": "html" } }',
    });

    const { status, text } = check(dir);

    expect(text).not.toContain("TS80003");
    expect(status).toBe(0);
  });
});
