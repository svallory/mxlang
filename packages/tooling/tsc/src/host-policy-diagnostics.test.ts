import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

/** `@mxlang/html` is not installed in a temp dir; the generated import resolves to the workspace source. */
const HTML_SOURCE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "targets",
  "html",
  "src",
  "index.ts",
);

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
    paths: { "@mxlang/html": [HTML_SOURCE] },
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

/** Normalise a printed manifest location after verifying its path identity. */
function normalizePolicyOutput(text: string, dir: string, cwd: string): string {
  return text.replace(
    /^([^\r\n]+?)(\(\d+,\d+\): (?:warning|error) TS80003:)/gm,
    (_match, filename: string, location: string) => {
      // Formatting is relative to the actual run cwd, not necessarily dir.
      // Validate before replacing: a missing ../ must not disappear in a
      // basename-only normalisation and falsely make a wrong location pass.
      expect(resolve(cwd, filename)).toBe(join(dir, "package.json"));
      const shown =
        resolve(cwd) === dir ? "package.json" : "<dir>/package.json";
      return `${shown}${location}`;
    },
  );
}

describe("host-policy filename normalization", () => {
  const cwd = "/private/tmp/review";
  const dir = "/private/var/folders/example/T/mx-hp-diag-ABC123";
  const suffix = '(5,13): warning TS80003: unknown mx.host "vue"';
  const good = `${relative(cwd, join(dir, "package.json"))}${suffix}`;

  it("accepts the exact cwd-relative manifest location", () => {
    expect(normalizePolicyOutput(good, dir, cwd)).toBe(
      `<dir>/package.json${suffix}`,
    );
  });

  it("accepts a spawned run's filename relative to dir", () => {
    const printed = `package.json${suffix}`;
    expect(normalizePolicyOutput(printed, dir, dir)).toBe(printed);
  });

  it("accepts an absolute manifest location with spaces and parentheses", () => {
    const spaced = `${dir} (project)`;
    const printed = `${join(spaced, "package.json")}${suffix}`;
    expect(normalizePolicyOutput(printed, spaced, cwd)).toBe(
      `<dir>/package.json${suffix}`,
    );
  });

  it("rejects a filename missing one parent traversal", () => {
    const wrong = good.replace("../", "");
    expect(() => normalizePolicyOutput(wrong, dir, cwd)).toThrow();
  });
});

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
    text: normalizePolicyOutput(
      stripVTControlCharacters(run.stdout + run.stderr),
      dir,
      spawn ? dir : process.cwd(),
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
      /(?:^|\n)package\.json\(1,\d+\): warning TS80003: could not be parsed as JSON: /,
    );
    expect(text).toContain('using the default "html" host');
    // The path is the location; the message does not repeat it.
    const line = text.split("\n").find((l) => l.includes("TS80003")) ?? "";
    expect(line).not.toContain("<dir>/package.json");
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
        'declare function Component(options: object): ClassDecorator;\n@Component({ template: <div><p>hi</p></div> })\nexport class XComponent {\n  title = "hi";\n}\n',
    });

    const { status, text } = check(dir);

    expect(text).toContain(
      '<dir>/package.json(4,13): warning TS80003: unknown mx.host "angualr"',
    );
    expect(text).toContain('Did you mean "angular"?');
    expect(status, text).toBe(0);
  });

  it("prints it for a .solid.mx file too", () => {
    const dir = project({
      "package.json": UNKNOWN_HOST,
      "src/widget.solid.mx": "export const widget = 1;\n",
      "src/main.ts":
        'import { widget } from "./widget.solid.mx";\nconsole.log(widget);\n',
    });

    const { text } = check(dir);

    expect(text).toContain(
      '<dir>/package.json(5,13): warning TS80003: unknown mx.host "vue"',
    );
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
