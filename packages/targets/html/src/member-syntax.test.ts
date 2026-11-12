/**
 * A dialect on an emitting target: a lowered trigger's replacement is spliced
 * into the expression's code, so the html target emits
 * `self.status`, never the authored `&status`. The module is core's member
 * fixture dialect, re-exported by the module of a dialect package the temp
 * project depends on, which claims `.member.mx`.
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

const MODULE = join(
  import.meta.dirname,
  "../../../core/src/fixtures/syntax/member-fixture.ts",
);

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-html-member-")));
  const dialect = join(dir, "node_modules", "member-dialect");
  mkdirSync(dialect, { recursive: true });
  writeFileSync(
    join(dialect, "package.json"),
    JSON.stringify({
      name: "member-dialect",
      mx: {
        dialect: {
          id: "member",
          name: "Fixture",
          extensions: [".member.mx"],
          module: "./index.cjs",
        },
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
    ['<p title=(&a === "sent" ? "y" : "n")/>\n', 'self.a === "sent"'],
  ])("%j emits valid TypeScript with %j", (source, expected) => {
    const { code } = compile(source, join(dir, "page.member.mx"));
    expect(code).toContain(expected);
    expect(code).not.toMatch(/&(status|a)\b/);
    expect(syntaxErrors(code)).toEqual([]);
  });
});

describe("a dialect's message vocabulary on the html target's own messages", () => {
  // Its own project: two dialects with one id cannot share a dependency list.
  let voiced: string;
  beforeAll(() => {
    voiced = realpathSync(mkdtempSync(join(tmpdir(), "mx-html-voiced-")));
    const pkg = join(voiced, "node_modules", "voiced-dialect");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "voiced-dialect",
        mx: {
          dialect: {
            id: "member",
            name: "Fixture",
            extensions: [".voiced.mx"],
            module: "./index.cjs",
          },
        },
      }),
    );
    // The member dialect, speaking of "options" and spelling tags `[[name]]`.
    writeFileSync(
      join(pkg, "index.cjs"),
      `const member = require(${JSON.stringify(MODULE)});
module.exports = {
  ...member,
  default: {
    ...member.default,
    messageVocabulary: {
      attribute: { one: "option", many: "options" },
      formatTag: (t) => "[[" + t.name + "]]",
    },
  },
};\n`,
    );
    writeFileSync(
      join(voiced, "package.json"),
      JSON.stringify({
        name: "app",
        devDependencies: { "voiced-dialect": "0.0.0" },
      }),
    );
  });
  afterAll(() => {
    rmSync(voiced, { recursive: true, force: true });
  });

  const messageOf = (source: string): string => {
    try {
      compile(source, join(voiced, "page.voiced.mx"));
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the compile to fail");
  };

  it("an unresolved tag is spelled by formatTag", () => {
    expect(messageOf("<Foo/>\n")).toContain("custom tag `[[Foo]]`.");
  });

  it("an attribute tag on an element uses the dialect's nouns and spelling", () => {
    expect(messageOf("<div><@foo/></div>\n")).toContain(
      "option tag `@foo` on `[[div]]`; option tags are props",
    );
  });
});
