import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranslateError } from "./core.ts";
import {
  installedParserSplits,
  parserSplitsAfterValue,
  resetInstalledParserProbe,
  STOCK_PARSER_MESSAGE,
  stockParserError,
} from "./stock-parser.ts";

/**
 * Decision 151, ruling 1: a stock `htmljs-parser` cannot read `:name` after an
 * attribute value, and core says so instead of surfacing Marko's "exactly one
 * expression" failure.
 *
 * The repo installs the patched parser (a bun `patchedDependencies` entry), so
 * the stock parser is rebuilt in a `mkdtemp` copy by reversing the committed
 * patch; Marko is then run against that copy in a child process, which is how a
 * consumer's install behaves.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const patchFile = join(here, "../../../patches/htmljs-parser@5.15.0.patch");
const hook = (stockDir: string) => `
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "htmljs-parser") return ${JSON.stringify(join(stockDir, "dist/index.js"))};
  return resolve.call(this, request, ...rest);
};
`;

/**
 * Reverses `patches/htmljs-parser@5.15.0.patch` in `dir`, in plain JS: the gate
 * machine's PATH may have no `patch` binary. Every hunk is replaced by its
 * pre-image: the "new" block (context and `+` lines) is searched for in the
 * file and swapped for the "old" block (context and `-` lines).
 */
function reversePatch(dir: string, patchText: string): void {
  for (const section of patchText.split(/^diff --git /m).slice(1)) {
    const file = section.match(/^a\/(\S+) b\//)?.[1];
    if (!file) throw new Error("unreadable patch section");
    const path = join(dir, file);
    let text = readFileSync(path, "utf8");
    for (const hunk of section.split(/^@@ .* @@.*$/m).slice(1)) {
      const lines = hunk.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const kept = lines.filter((line) => !line.startsWith("\\"));
      const added = kept
        .filter((line) => line[0] === " " || line[0] === "+")
        .map((line) => line.slice(1))
        .join("\n");
      const removed = kept
        .filter((line) => line[0] === " " || line[0] === "-")
        .map((line) => line.slice(1))
        .join("\n");
      if (!text.includes(added)) throw new Error(`hunk not found in ${file}`);
      text = text.replace(added, () => removed);
    }
    writeFileSync(path, text);
  }
}

/** An installed package can be read-only; the copy must not be. */
function makeWritable(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    chmodSync(path, 0o755);
    if (statSync(path).isDirectory()) makeWritable(path);
  }
}

let work = "";
let stockDir = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mx-stock-parser-"));
  const installed = dirname(dirname(require.resolve("htmljs-parser")));
  stockDir = join(work, "htmljs-parser");
  cpSync(installed, stockDir, { recursive: true });
  makeWritable(stockDir);
  reversePatch(stockDir, readFileSync(patchFile, "utf8"));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("the probe", () => {
  it("sees the patched parser this repo installs split after a value", () => {
    expect(installedParserSplits()).toBe(true);
  });

  it("sees a stock parser, in both builds, not split", async () => {
    const cjs = createRequire(join(stockDir, "package.json"))(
      "./dist/index.js",
    );
    expect(parserSplitsAfterValue(cjs)).toBe(false);
    const esm = await import(
      pathToFileURL(join(stockDir, "dist/index.mjs")).href
    );
    expect(parserSplitsAfterValue(esm)).toBe(false);
  });

  it("is probed once", () => {
    resetInstalledParserProbe();
    const first = installedParserSplits();
    expect(installedParserSplits()).toBe(first);
  });
});

/** Marko's own failure on a stock parser, from a child process. */
function markoFailure(source: string): {
  message: string;
  label: string;
  loc: { line: number; column: number; index: number };
} {
  const script = join(work, "run.cjs");
  writeFileSync(
    script,
    `${hook(stockDir)}
const compiler = require(${JSON.stringify(require.resolve("@marko/compiler"))});
try {
  compiler.compileSync(${JSON.stringify(source)}, "/tmp/x.mx", {
    translator: { taglibs: [], tagDiscoveryDirs: [], translate: { Program: { exit(p) { p.node.body = []; } } } },
    output: "html",
    writeVersionComment: false,
  });
  console.log(JSON.stringify({ parsed: true }));
} catch (e) {
  console.log(JSON.stringify({ message: e.message, label: e.label, loc: e.loc && e.loc.start }));
}
`,
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}

describe("a stock parser's failure becomes a positioned MX error", () => {
  const SOURCES: [string, number, number, string][] = [
    ['<input type="email" :email/>', 1, 20, ":email"],
    ['<a x="1" :b/>', 1, 9, ":b"],
    ["<a x=1 ? y : z :b/>", 1, 15, ":b"],
    ['a x="1" :b', 1, 8, ":b"],
    ["<div\n  x=1\n  :b/>", 3, 2, ":b"],
  ];

  it.each(SOURCES)("%j", (source, line, column, token) => {
    const failure = markoFailure(source);
    expect(failure.message).toContain("unexpected character `:`");
    const error = stockParserError(failure_error(failure), source, false);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error?.message).toBe(STOCK_PARSER_MESSAGE(token));
    expect(error?.line).toBe(line);
    expect(error?.column).toBe(column);
  });

  it("names the rule, the requirement and the way out", () => {
    const message = STOCK_PARSER_MESSAGE(":email");
    expect(message).toContain("`:email` after an attribute value");
    expect(message).toContain("patched htmljs-parser");
    expect(message).toContain('<input:email type="email">');
    expect(message).toContain("divergences.md");
  });

  it("does nothing when the installed parser splits", () => {
    const failure = markoFailure('<a x="1" :b/>');
    expect(
      stockParserError(failure_error(failure), '<a x="1" :b/>', true),
    ).toBeUndefined();
  });

  it("does nothing when the probe could not run", () => {
    const failure = markoFailure('<a x="1" :b/>');
    expect(
      stockParserError(failure_error(failure), '<a x="1" :b/>', undefined),
    ).toBeUndefined();
  });

  it("leaves other parse errors alone", () => {
    const source = "<a x=1 ? y :/>";
    const failure = markoFailure(source);
    expect(
      stockParserError(failure_error(failure), source, false),
    ).toBeUndefined();
    expect(stockParserError(new Error("boom"), "<a/>", false)).toBeUndefined();
    expect(stockParserError("not an error", "<a/>", false)).toBeUndefined();
  });

  it("only rewrites a `:` that follows whitespace", () => {
    const error = failure_error({
      message: "first expression is followed by the unexpected character `:`",
      label: "first expression is followed by the unexpected character `:`",
      loc: { line: 1, column: 6, index: 6 },
    });
    expect(stockParserError(error, "<a x=1:b/>", false)).toBeUndefined();
  });

  it("finds it inside an aggregate", () => {
    const inner = failure_error(markoFailure('<a x="1" :b/>'));
    const aggregate = Object.assign(new Error("2 errors"), {
      errors: [new Error("other"), inner],
    });
    expect(stockParserError(aggregate, '<a x="1" :b/>', false)?.column).toBe(9);
  });
});

function failure_error(failure: {
  message: string;
  label?: string;
  loc?: { line: number; column: number; index?: number };
}): Error {
  return Object.assign(new Error(failure.message), {
    label: failure.label,
    loc: failure.loc ? { start: failure.loc } : undefined,
  });
}
