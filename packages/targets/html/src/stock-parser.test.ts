import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Decision 151, ruling 1, end to end: on a consumer's stock `htmljs-parser`,
 * `<input type="email" :email>` is a positioned MX error that names the rule,
 * not Marko's "exactly one expression" failure. The stock parser is rebuilt in
 * a `mkdtemp` copy by reversing the committed patch, and `@mxlang/html`'s built
 * `dist` runs against it in a child process (the repo's own install is
 * patched, so it cannot show the failure in-process).
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const patchFile = join(here, "../../../../patches/htmljs-parser@5.15.0.patch");
const distEntry = join(here, "../dist/index.js");

let work = "";
let stockDir = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mx-html-stock-parser-"));
  stockDir = join(work, "htmljs-parser");
  cpSync(dirname(dirname(require.resolve("htmljs-parser"))), stockDir, {
    recursive: true,
  });
  const reversed = spawnSync("patch", ["-R", "-p1", "-i", patchFile], {
    cwd: stockDir,
    encoding: "utf8",
  });
  if (reversed.status !== 0) throw new Error(reversed.stderr);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function compileWith(source: string, stock: boolean) {
  const script = join(work, `run-${stock ? "stock" : "patched"}.cjs`);
  writeFileSync(
    script,
    `${
      stock
        ? `const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "htmljs-parser") return ${JSON.stringify(join(stockDir, "dist/index.js"))};
  return resolve.call(this, request, ...rest);
};`
        : ""
    }
import(${JSON.stringify(`file://${distEntry}`)}).then(({ compile }) => {
  try {
    compile(${JSON.stringify(source)}, ${JSON.stringify(join(work, "t.mx"))});
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    console.log(JSON.stringify({ message: e.message, line: e.line, column: e.column, name: e.constructor.name }));
  }
});
`,
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as {
    ok?: true;
    message?: string;
    line?: number;
    column?: number;
    name?: string;
  };
}

describe("`:name` after an attribute value on a stock htmljs-parser", () => {
  it("is a positioned MX error naming the rule", () => {
    const result = compileWith('<input type="email" :email/>', true);
    expect(result.ok).toBeUndefined();
    expect(result.name).toBe("TranslateError");
    expect(result.message).toContain("`:email` after an attribute value");
    expect(result.message).toContain("patched htmljs-parser");
    expect(result.message).toContain('<input:email type="email">');
    expect(result.line).toBe(1);
    expect(result.column).toBe(20);
  });

  it("compiles on the patched parser", () => {
    expect(compileWith('<input type="email" :email/>', false).ok).toBe(true);
  });

  it("keeps the tag-adjacent form working on a stock parser", () => {
    expect(compileWith('<input:email type="email"/>', true).ok).toBe(true);
    expect(compileWith("<input.big:email/>", true).ok).toBe(true);
    expect(compileWith("<input :email/>", true).ok).toBe(true);
  });
});
