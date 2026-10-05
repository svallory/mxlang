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
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Decision 151, ruling 1, end to end: on a consumer's stock `htmljs-parser`,
 * `<input type="email" :email>` is a positioned MX error that names the rule,
 * not Marko's "exactly one expression" failure. The stock parser is rebuilt in
 * a `mkdtemp` copy by reversing the committed patch, and `@mxlang/html`'s built
 * `dist` runs against it in a child process (the repo's own install is
 * patched, so it cannot show the failure in-process).
 *
 * Decision 159: core's dist parses with its bundled Marko front end and MX's
 * own template parser, so a stock `htmljs-parser` in the install no longer
 * reaches it (the last `describe`). The error is left for a core that
 * bypasses its bundle: `stock` runs simulate one by resolving core's
 * `./marko-frontend.cjs` to the npm compiler on the stock parser.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const patchFile = join(here, "../../../../patches/htmljs-parser@5.18.0.patch");
const distEntry = join(here, "../dist/index.js");

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
  work = mkdtempSync(join(tmpdir(), "mx-html-stock-parser-"));
  stockDir = join(work, "htmljs-parser");
  cpSync(dirname(dirname(require.resolve("htmljs-parser"))), stockDir, {
    recursive: true,
  });
  makeWritable(stockDir);
  reversePatch(stockDir, readFileSync(patchFile, "utf8"));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function compileWith(source: string, stock: boolean, viaBundle = false) {
  const script = join(
    work,
    `run-${stock ? "stock" : "patched"}${viaBundle ? "-bundle" : ""}.cjs`,
  );
  const compiler = require.resolve("@marko/compiler", {
    paths: [join(here, "../../../core")],
  });
  const shim = join(work, "stock-frontend.cjs");
  writeFileSync(
    shim,
    `module.exports = {
  compiler: require(${JSON.stringify(compiler)}),
  babel: require(${JSON.stringify(require.resolve("@marko/compiler/internal/babel", { paths: [join(here, "../../../core")] }))}),
  htmljsParser: require("node:module").createRequire(${JSON.stringify(compiler)})("htmljs-parser"),
};
`,
  );
  writeFileSync(
    script,
    `const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  ${stock ? `if (request === "htmljs-parser") return ${JSON.stringify(join(stockDir, "dist/index.js"))};` : ""}
  ${viaBundle ? "" : `if (request === "./marko-frontend.cjs") return ${JSON.stringify(shim)};`}
  return resolve.call(this, request, ...rest);
};
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

  it.each([
    ["the patched parser", false],
    ["a stock parser", true],
  ])("sugar after a default value is one MX error on %s", (_name, stock) => {
    const result = compileWith("<if=input.x :b>y</if>", stock);
    expect(result.ok).toBeUndefined();
    expect(result.name).toBe("TranslateError");
    expect(result.message).toContain("`:b` right after a default value");
    expect(result.message).not.toContain("patched htmljs-parser");
    expect(result.line).toBe(1);
    expect(result.column).toBe(12);
  });

  it("`<const/x=a .b/>` stays member access on both", () => {
    expect(compileWith("<const/x=input.a .b/>", true).ok).toBe(true);
    expect(compileWith("<const/x=input.a .b/>", false).ok).toBe(true);
  });
});

describe("core's bundled front end ignores a stock htmljs-parser in the install", () => {
  it("compiles `:name` after an attribute value", () => {
    expect(compileWith('<input type="email" :email/>', true, true).ok).toBe(
      true,
    );
  });
});
