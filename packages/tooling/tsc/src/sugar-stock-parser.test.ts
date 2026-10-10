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
 * Decision 159: core's dist parses with its bundled front end and MX's own
 * template parser, so a stock `htmljs-parser` in the install reaches no tool:
 * `<input type="email" :email>` compiles with no diagnostic in the language
 * server and `mx-tsc`. The stock parser is rebuilt in a `mkdtemp` copy by
 * reversing the committed patch (plain JS: the gate PATH has no `patch`), and
 * each tool's built `dist` runs against it in a child process. (Decision 151's
 * stock-parser error is gone: core never parses MX with a stock parser.)
 */

const here = import.meta.dirname;
const repo = join(here, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const SOURCE = '<input type="email" :email/>\n';

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

function run(script: string, hookFile: string): Record<string, unknown> {
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

describe("with core's bundled front end, a stock htmljs-parser in the install changes nothing", () => {
  it("language server: no diagnostic", () => {
    const out = run(
      `
const lsRequire = require("node:module").createRequire(${JSON.stringify(dist("tooling/language-server/package.json"))});
Promise.all([
  import(${JSON.stringify(`file://${dist("tooling/language-server/dist/index.js")}`)}),
  import("file://" + lsRequire.resolve("@mxlang/targets")),
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
  });
});
