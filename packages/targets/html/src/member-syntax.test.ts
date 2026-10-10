/**
 * A layer-2 dialect on an emitting target (decision 182 addendum 5;
 * review 451 r1 BLOCKING 2): a lowered trigger's replacement is spliced into
 * the expression's code as an atom is, so the html target emits
 * `self.status`, never the authored `&status`. The module is core's
 * test-only member dialect, re-exported by the module of a dialect package
 * the temp project depends on (decision 212), which claims `.mesh.mx`.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const MODULE = join(import.meta.dirname, "../../../core/src/syntax/member.ts");

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-html-member-")));
  const dialect = join(dir, "node_modules", "member-dialect");
  mkdirSync(dialect, { recursive: true });
  writeFileSync(
    join(dialect, "package.json"),
    JSON.stringify({
      name: "member-dialect",
      mxDialect: {
        id: "member",
        name: "Mesh",
        extensions: [".mesh.mx"],
        module: "./index.cjs",
      },
    }),
  );
  writeFileSync(
    join(dialect, "index.cjs"),
    `module.exports = require(${JSON.stringify(MODULE)});\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      devDependencies: { "member-dialect": "0.0.0" },
    }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** TypeScript's syntax errors in `code` (none for valid TypeScript). */
function syntaxErrors(code: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext },
  });
  return diagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

describe("a member trigger on the html target", () => {
  it.each([
    ["<div title=(&status)/>\n", "self.status"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an MX placeholder, not a template literal
    ["<p>${&a + 1}</p>\n", "self.a + 1"],
    ['<p title=(&a === :sent ? "y" : "n")/>\n', 'self.a === "sent"'],
  ])("%j emits valid TypeScript with %j", (source, expected) => {
    const { code } = compile(source, join(dir, "page.mesh.mx"));
    expect(code).toContain(expected);
    expect(code).not.toMatch(/&(status|a)\b/);
    expect(syntaxErrors(code)).toEqual([]);
  });
});
