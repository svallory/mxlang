import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
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
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Decision 151, ruling 1, in every tool: on a consumer's stock
 * `htmljs-parser`, `<input type="email" :email>` is one MX error positioned at
 * the `:` (1:20, 0-based column 20), in the language server, the TypeScript
 * plugin, the Vite transform and `mx-tsc` alike. The repo installs the patched
 * parser, so the stock one is rebuilt in a `mkdtemp` copy by reversing the
 * committed patch (plain JS: the gate PATH has no `patch`), and each tool's
 * built `dist` runs against it in a child process. This is why the error has no
 * `host-dispatch` row: the tools cannot reach it in-process.
 *
 * Decision 159: core's dist parses with its bundled Marko front end and MX's
 * own template parser, so a stock `htmljs-parser` in the install no longer
 * reaches any tool (the second `describe`). The decision 151 error is left for
 * a core that bypasses its bundle; `hook` simulates one by resolving core's
 * `./marko-frontend.cjs` to the npm compiler on the stock parser.
 */

const here = import.meta.dirname;
const repo = join(here, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const SOURCE = '<input type="email" :email/>\n';

const MESSAGE_PART =
  "`:email` after an attribute value needs the patched htmljs-parser";

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

function makeWritable(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    chmodSync(path, 0o755);
    if (statSync(path).isDirectory()) makeWritable(path);
  }
}

let work = "";
let project = "";
let page = "";
let hook = "";
let stockOnlyHook = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mx-sugar-stock-"));
  const stock = join(work, "htmljs-parser");
  cpSync(dirname(dirname(require.resolve("htmljs-parser"))), stock, {
    recursive: true,
  });
  makeWritable(stock);
  reversePatch(
    stock,
    readFileSync(join(repo, "patches/htmljs-parser@5.18.0.patch"), "utf8"),
  );
  stockOnlyHook = join(work, "stock-only-hook.cjs");
  writeFileSync(
    stockOnlyHook,
    `const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "htmljs-parser") return ${JSON.stringify(join(stock, "dist/index.js"))};
  return resolve.call(this, request, ...rest);
};
`,
  );
  const shim = join(work, "stock-frontend.cjs");
  const compiler = require.resolve("@marko/compiler", {
    paths: [dist("core")],
  });
  writeFileSync(
    shim,
    `module.exports = {
  compiler: require(${JSON.stringify(compiler)}),
  babel: require(${JSON.stringify(require.resolve("@marko/compiler/internal/babel", { paths: [dist("core")] }))}),
  htmljsParser: require("node:module").createRequire(${JSON.stringify(compiler)})("htmljs-parser"),
};
`,
  );
  hook = join(work, "hook.cjs");
  writeFileSync(
    hook,
    `require(${JSON.stringify(stockOnlyHook)});
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "./marko-frontend.cjs") return ${JSON.stringify(shim)};
  return resolve.call(this, request, ...rest);
};
`,
  );
  project = join(work, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        types: [],
      },
      include: ["*.mx"],
    }),
  );
  page = join(project, "page.mx");
  writeFileSync(page, SOURCE);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function run(script: string, hookFile = hook): Record<string, unknown> {
  const file = join(work, `leg-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(file, `require(${JSON.stringify(hookFile)});\n${script}`);
  const result = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    cwd: project,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").pop() as string);
}

const dist = (...parts: string[]) => join(repo, "packages", ...parts);

describe("`:name` after an attribute value on a stock htmljs-parser, in every tool", () => {
  it("language server: one diagnostic at the `:`", () => {
    const out = run(`
const lsRequire = require("node:module").createRequire(${JSON.stringify(dist("tooling/language-server/package.json"))});
Promise.all([
  import(${JSON.stringify(`file://${dist("tooling/language-server/dist/index.js")}`)}),
  import("file://" + lsRequire.resolve("@mxlang/target-registry")),
]).then(([{ diagnoseDocument }, { resolveTargetPolicy }]) => {
  const policy = resolveTargetPolicy(${JSON.stringify(page)});
  const diagnostics = diagnoseDocument(${JSON.stringify(SOURCE)}, ${JSON.stringify(`file://${page}`)}, policy, () => {}, "mx");
  console.log(JSON.stringify({ diagnostics }));
});`) as {
      diagnostics: {
        message: string;
        range: { start: { line: number; character: number } };
      }[];
    };
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]?.message).toContain(MESSAGE_PART);
    expect(out.diagnostics[0]?.range.start).toEqual({ line: 0, character: 20 });
  });

  it("TypeScript plugin: one compile diagnostic at offset 20", () => {
    const out = run(`
const ts = require(${JSON.stringify(require.resolve("typescript"))});
const { createMxLanguagePlugin } = require(${JSON.stringify(dist("tooling/typescript-plugin/dist/index.cjs"))});
const plugin = createMxLanguagePlugin(ts);
const warn = console.warn; console.warn = () => {};
plugin.createVirtualCode(${JSON.stringify(page)}, "mx", ts.ScriptSnapshot.fromString(${JSON.stringify(SOURCE)}), { getAssociatedScript: () => undefined });
const diagnostics = plugin.getCompileDiagnostics(${JSON.stringify(page)}).map(({ source, ...rest }) => rest);
console.warn = warn;
console.log(JSON.stringify({ diagnostics }));`) as {
      diagnostics: { message: string; offset: number }[];
    };
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]?.message).toContain(MESSAGE_PART);
    expect(out.diagnostics[0]?.offset).toBe(20);
  });

  it("Vite transform: an error at 1:20", () => {
    const out = run(`
const mxVite = require(${JSON.stringify(dist("tooling/vite-plugin/dist/index.cjs"))});
const plugin = (mxVite.default ?? mxVite)();
plugin.transform.call({ warn() {}, error(e) { throw e; } }, ${JSON.stringify(SOURCE)}, ${JSON.stringify(page)} + mxVite.MX_SUFFIX).then(
  () => console.log(JSON.stringify({ ok: true })),
  (e) => console.log(JSON.stringify({ message: e.message, loc: e.loc })),
);`) as { ok?: true; message?: string; loc?: { line: number; column: number } };
    expect(out.ok).toBeUndefined();
    expect(out.message).toContain(MESSAGE_PART);
    expect(out.loc).toMatchObject({ line: 1, column: 20 });
  });

  it("mx-tsc: TS80001 at (1,21)", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        hook,
        dist("tooling/tsc/dist/bin.cjs"),
        "--noEmit",
        "--pretty",
        "false",
        "-p",
        join(project, "tsconfig.json"),
      ],
      { encoding: "utf8", cwd: project },
    );
    const output = stripVTControlCharacters(
      `${result.stdout}\n${result.stderr}`,
    );
    expect(result.status).not.toBe(0);
    expect(output).toContain("page.mx(1,21): error TS80001:");
    expect(output).toContain(MESSAGE_PART);
  });
});

describe("with core's bundled front end, a stock htmljs-parser in the install changes nothing", () => {
  it("language server: no diagnostic", () => {
    const out = run(
      `
const lsRequire = require("node:module").createRequire(${JSON.stringify(dist("tooling/language-server/package.json"))});
Promise.all([
  import(${JSON.stringify(`file://${dist("tooling/language-server/dist/index.js")}`)}),
  import("file://" + lsRequire.resolve("@mxlang/target-registry")),
]).then(([{ diagnoseDocument }, { resolveTargetPolicy }]) => {
  const policy = resolveTargetPolicy(${JSON.stringify(page)});
  const diagnostics = diagnoseDocument(${JSON.stringify(SOURCE)}, ${JSON.stringify(`file://${page}`)}, policy, () => {}, "mx");
  console.log(JSON.stringify({ diagnostics }));
});`,
      stockOnlyHook,
    ) as { diagnostics: unknown[] };
    expect(out.diagnostics).toEqual([]);
  });

  it("mx-tsc: no TS80001", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        stockOnlyHook,
        dist("tooling/tsc/dist/bin.cjs"),
        "--noEmit",
        "--pretty",
        "false",
        "-p",
        join(project, "tsconfig.json"),
      ],
      { encoding: "utf8", cwd: project },
    );
    const output = stripVTControlCharacters(
      `${result.stdout}\n${result.stderr}`,
    );
    expect(output).not.toContain("TS80001");
    expect(output).not.toContain(MESSAGE_PART);
  });
});
