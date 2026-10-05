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
  installedParserLexesAtoms,
  installedParserSplits,
  parseErrorToSugarError,
  parserLexesAtoms,
  parserSplitsAfterValue,
  resetInstalledParserProbe,
  STOCK_ATOM_MESSAGE,
  STOCK_PARSER_MESSAGE,
  SUGAR_AFTER_DEFAULT_MESSAGE,
  stockAtomError,
  stockParserError,
  sugarAfterDefaultError,
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
const patchFile = join(here, "../../../patches/htmljs-parser@5.18.0.patch");
const hook = (stockDir: string) => `
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "htmljs-parser") return ${JSON.stringify(join(stockDir, "dist/index.js"))};
  return resolve.call(this, request, ...rest);
};
`;

/**
 * Reverses `patches/htmljs-parser@5.18.0.patch` in `dir`, in plain JS: the gate
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
function markoFailure(
  source: string,
  stock = true,
): {
  message: string;
  label: string;
  loc: { line: number; column: number; index: number };
} {
  const script = join(work, stock ? "run.cjs" : "run-patched.cjs");
  writeFileSync(
    script,
    `${stock ? hook(stockDir) : ""}
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
    // htmljs-parser 5.15 said "first expression is followed by the unexpected
    // character `:`"; 5.18 says "Expected a single expression, but found `:`".
    expect(failure.message).toMatch(
      /unexpected character `:`|Expected a single expression, but found `:`/,
    );
    const error = stockParserError(failureError(failure), source, false);
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
      stockParserError(failureError(failure), '<a x="1" :b/>', true),
    ).toBeUndefined();
  });

  it("does nothing when the probe could not run", () => {
    const failure = markoFailure('<a x="1" :b/>');
    expect(
      stockParserError(failureError(failure), '<a x="1" :b/>', undefined),
    ).toBeUndefined();
  });

  it("leaves other parse errors alone", () => {
    const source = "<a x=1 ? y :/>";
    const failure = markoFailure(source);
    expect(
      stockParserError(failureError(failure), source, false),
    ).toBeUndefined();
    expect(stockParserError(new Error("boom"), "<a/>", false)).toBeUndefined();
    expect(stockParserError("not an error", "<a/>", false)).toBeUndefined();
  });

  it("only rewrites a `:` that follows whitespace", () => {
    const error = failureError({
      message: "first expression is followed by the unexpected character `:`",
      label: "first expression is followed by the unexpected character `:`",
      loc: { line: 1, column: 6, index: 6 },
    });
    expect(stockParserError(error, "<a x=1:b/>", false)).toBeUndefined();
  });

  it("finds it inside an aggregate", () => {
    const inner = failureError(markoFailure('<a x="1" :b/>'));
    const aggregate = Object.assign(new Error("2 errors"), {
      errors: [new Error("other"), inner],
    });
    expect(stockParserError(aggregate, '<a x="1" :b/>', false)?.column).toBe(9);
  });
});

function failureError(failure: {
  message: string;
  label?: string;
  loc?: { line: number; column: number; index?: number };
}): Error {
  return Object.assign(new Error(failure.message), {
    label: failure.label,
    loc: failure.loc ? { start: failure.loc } : undefined,
  });
}

// Decision 151, ruling 2: the default attribute is exempt from the after-value
// rule on BOTH parsers, so sugar right after its value is one MX error, not
// the patched-parser advice (which would be wrong: the patch exempts it too).
describe("sugar right after a default value", () => {
  const CASES: [string, number, number, string][] = [
    ["<if=x :b>y</if>", 1, 6, ":b"],
    ["<let/x=1 :b/>", 1, 9, ":b"],
    ["if=x :b", 1, 5, ":b"],
    ["<const/x=a ? b : c :d/>", 1, 19, ":d"],
  ];

  describe.each([
    ["the patched parser", false],
    ["a stock parser", true],
  ])("%s", (_name, stock) => {
    it.each(CASES)("%j", (source, line, column, token) => {
      const failure = markoFailure(source, stock);
      const error = sugarAfterDefaultError(failureError(failure), source);
      expect(error).toBeInstanceOf(TranslateError);
      expect(error?.message).toBe(SUGAR_AFTER_DEFAULT_MESSAGE(token));
      expect(error?.line).toBe(line);
      expect(error?.column).toBe(column);
    });

    it("`<const/x=a .b/>` stays member access, with no error", () => {
      expect(markoFailure("<const/x=a .b/>", stock)).toEqual({ parsed: true });
    });
  });

  it("names the rule and the way out, not the parser", () => {
    const message = SUGAR_AFTER_DEFAULT_MESSAGE(":b");
    expect(message).toContain("`:b` right after a default value");
    expect(message).toContain("decision 151, ruling 2");
    expect(message).toContain("before the value or on the tag");
    expect(message).not.toContain("patched");
  });

  it("the stock-parser advice does not fire for a default attribute", () => {
    for (const [source] of CASES) {
      const failure = markoFailure(source, true);
      expect(
        stockParserError(failureError(failure), source, false),
      ).toBeUndefined();
    }
  });

  it("still gives the stock advice for a named attribute", () => {
    const source = '<a x="1" :b/>';
    expect(
      sugarAfterDefaultError(failureError(markoFailure(source)), source),
    ).toBeUndefined();
    expect(
      stockParserError(failureError(markoFailure(source)), source, false),
    ).toBeInstanceOf(TranslateError);
    // A default attribute first, a named one carrying the sugar: stock advice.
    const mixed = "<if=x y=1 :b>z</if>";
    expect(
      sugarAfterDefaultError(failureError(markoFailure(mixed)), mixed),
    ).toBeUndefined();
    expect(
      stockParserError(failureError(markoFailure(mixed)), mixed, false),
    ).toBeInstanceOf(TranslateError);
  });
});

// `parseFragment` (a `.solid.mx` region) asks Marko for an AST, and Marko then
// keeps a failing attribute value in the tree as a `MarkoParseError` node
// instead of throwing, so the error reaches the lowerer in `exprOf`. The node's
// position is shifted by baseLine/baseColumn like every other; the sugar error
// is built from it and so lands at the shifted `:`. Core's built `dist` runs
// under the stock parser in a child process.
/**
 * Core's dist loads its bundled Marko front end (decision 159), whose parser
 * is MX's own: a stock `htmljs-parser` in the install never reaches it. The
 * decision 151 diagnostic is for a caller that bypasses that bundle and hands
 * core a stock compiler; `bypass` simulates one by resolving the dist's
 * `./marko-frontend.cjs` to the npm compiler, which then gets the stock parser
 * through `hook`.
 */
const bypass = (shim: string) => `
const BypassModule = require("node:module");
const bypassResolve = BypassModule._resolveFilename;
BypassModule._resolveFilename = function (request, ...rest) {
  if (request === "./marko-frontend.cjs") return ${JSON.stringify(shim)};
  return bypassResolve.call(this, request, ...rest);
};
`;

describe("parseFragment on a stock parser", () => {
  const distEntry = join(here, "../dist/index.js");

  function recovered(
    source: string,
    base: object,
    stock = true,
    viaBundle = false,
  ) {
    const script = join(
      work,
      `${stock ? "fragment" : "fragment-patched"}${viaBundle ? "-bundle" : ""}.cjs`,
    );
    const shim = join(work, "stock-frontend.cjs");
    writeFileSync(
      shim,
      `module.exports = {
  compiler: require(${JSON.stringify(require.resolve("@marko/compiler"))}),
  babel: require(${JSON.stringify(require.resolve("@marko/compiler/internal/babel"))}),
  htmljsParser: require("node:module").createRequire(${JSON.stringify(require.resolve("@marko/compiler"))})("htmljs-parser"),
};
`,
    );
    writeFileSync(
      script,
      `${stock ? hook(stockDir) : ""}${viaBundle ? "" : bypass(shim)}
import(${JSON.stringify(`file://${distEntry}`)}).then(({ parseFragment }) => {
  const { body } = parseFragment(${JSON.stringify(source)}, ${JSON.stringify(base)});
  const bad = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "MarkoParseError") bad.push({ label: n.label, errorLoc: n.errorLoc, loc: n.loc });
    for (const key of ["attributes", "value", "body"]) walk(Array.isArray(n[key]) ? null : n[key]);
    for (const a of n.attributes ?? []) walk(a);
    for (const c of n.body?.body ?? []) walk(c);
  };
  for (const n of body) walk(n);
  console.log(JSON.stringify(bad));
});
`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout) as Parameters<
      typeof parseErrorToSugarError
    >[0][];
  }

  it("the failing value is a recovered node, not a throw", () => {
    expect(recovered('<a x="1" :b/>', {})).toHaveLength(1);
  });

  it("core's own bundle parses with MX's parser, a stock one installed or not", () => {
    expect(recovered('<a x="1" :b/>', {}, true, true)).toEqual([]);
  });

  it.each([
    [{}, 1, 9],
    // The first line shifts by baseColumn as well as baseLine.
    [{ baseLine: 10, baseColumn: 4, baseOffset: 14 }, 11, 13],
  ])(
    "positions the stock error at the shifted `:` (%j)",
    (base, line, column) => {
      const source = '<a x="1" :b/>';
      const [node] = recovered(source, base);
      // The node's positions are shifted, so the offset is re-derived against a
      // source that has the base in front of it.
      const padded = `${"\n".repeat((base as { baseLine?: number }).baseLine ?? 0)}${" ".repeat(
        (base as { baseColumn?: number }).baseColumn ?? 0,
      )}${source}`;
      const error = parseErrorToSugarError(node as never, padded, false);
      expect(error?.message).toBe(STOCK_PARSER_MESSAGE(":b"));
      expect([error?.line, error?.column]).toEqual([line, column]);
    },
  );

  it("a later line shifts by baseLine only", () => {
    const source = '<a\n  x="1" :b/>';
    const [node] = recovered(source, {
      baseLine: 10,
      baseColumn: 4,
      baseOffset: 14,
    });
    const padded = `${"\n".repeat(10)}${" ".repeat(4)}${source}`;
    const error = parseErrorToSugarError(node as never, padded, false);
    expect([error?.line, error?.column]).toEqual([12, 8]);
  });

  it("sugar after a default value is the default-attribute error, on either parser", () => {
    for (const stock of [true, false]) {
      const [node] = recovered(
        "<if=x :b>y</if>",
        { baseLine: 3, baseColumn: 2, baseOffset: 5 },
        stock,
      );
      const padded = `${"\n".repeat(3)}${" ".repeat(2)}<if=x :b>y</if>`;
      const error = parseErrorToSugarError(node as never, padded);
      expect(error?.message).toBe(SUGAR_AFTER_DEFAULT_MESSAGE(":b"));
      expect([error?.line, error?.column]).toEqual([4, 8]);
    }
  });
});

// Decision 156 (atoms; decisions 151 §1 and 158 §2): published consumers get a
// stock htmljs-parser through `@marko/compiler`, which does not lex atoms, so
// an atom is a positioned "atoms need the MX parser" error there.
describe("atoms on a stock parser", () => {
  it("the probe sees the patched parser lex atoms and a stock one not", async () => {
    resetInstalledParserProbe();
    expect(installedParserLexesAtoms()).toBe(true);
    const cjs = createRequire(join(stockDir, "package.json"))(
      "./dist/index.js",
    );
    expect(parserLexesAtoms(cjs)).toBe(false);
    const esm = await import(
      pathToFileURL(join(stockDir, "dist/index.mjs")).href
    );
    expect(parserLexesAtoms(esm)).toBe(false);
  });

  const SOURCES: [string, number, number, string][] = [
    ["<div x=:b/>", 1, 7, ":b"],
    ["<div x=[:a, :rename-all]/>", 1, 8, ":a"],
    ["<div x= :b/>", 1, 8, ":b"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an MX placeholder
    ["<p>${:a}</p>", 1, 5, ":a"],
    ["div x=f(:a)", 1, 8, ":a"],
    ["<div\n  x=:b/>", 2, 4, ":b"],
  ];

  it.each(SOURCES)("%j", (source, line, column, token) => {
    const failure = markoFailure(source);
    const error = stockAtomError(failureError(failure), source, false);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error?.message).toBe(STOCK_ATOM_MESSAGE(token));
    expect([error?.line, error?.column]).toEqual([line, column]);
  });

  it("names the requirement and the way out", () => {
    const message = STOCK_ATOM_MESSAGE(":rename-all");
    expect(message).toContain("`:rename-all` is an atom (decision 156)");
    expect(message).toContain("atoms need the MX parser");
    expect(message).toContain('`"rename-all"`');
    expect(message).toContain("divergences.md");
  });

  it("does nothing on the MX parser, or when the probe could not run", () => {
    const failure = markoFailure("<div x=:b/>");
    const error = failureError(failure);
    expect(stockAtomError(error, "<div x=:b/>", true)).toBeUndefined();
    expect(stockAtomError(error, "<div x=:b/>", undefined)).toBeUndefined();
  });

  it("a ternary or type colon is not taken for an atom", () => {
    const source = "<div x=a ? b :/>";
    const failure = markoFailure(source);
    expect(
      stockAtomError(failureError(failure), source, false),
    ).toBeUndefined();
  });
});
