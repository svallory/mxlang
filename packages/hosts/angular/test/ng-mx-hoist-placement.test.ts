/**
 * Where `compileNgMx` writes the imports it hoists for a discovered `tags/`
 * component. The parser splices the imports it synthesizes into the AST as
 * nodes parsed from a separate snippet; their snippet-relative offsets once
 * leaked into the insertion point and cut the `@Component` decorator in two
 * (`@Comp` / `import …;onent({`, TS1206 + TS2304). The parser now removes
 * those locations, so the host's "after the last import" is correct again.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const TAGS: Record<string, string> = {
  "tags/user-card.mx":
    "export interface Input { title: string }\n<span>$" +
    "{input.title}</span>\n",
  "tags/badge.mx":
    "export interface Input { label: string }\n<b>$" + "{input.label}</b>\n",
};

function compile(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-hoist-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
  for (const [name, content] of Object.entries(TAGS)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  mkdirSync(join(dir, "src"));
  const file = join(dir, "src", "x.component.ng.mx");
  writeFileSync(file, source);
  const customTags = getCustomTags(file, {
    host: "angular",
    targets: angularOwnTargets,
  });
  return compileNgMx(source, file, { customTags });
}

/** Parse diagnostics of `code` as a TS module (decorators on). */
function syntaxErrors(code: string): string[] {
  const sf = ts.createSourceFile("m.ts", code, ts.ScriptTarget.ES2022, true);
  return (
    (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ??
    []
  ).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const CARD_IMPORT = 'import { UserCard } from "../tags/user-card";';

function cls(name: string, template: string, extra = ""): string {
  return [
    "@Component({",
    `  selector: "app-${name.toLowerCase()}",`,
    `  template: ${template},`,
    "})",
    `${extra}class ${name} { title = 'hi'; }`,
  ].join("\n");
}

const NG_CORE = 'import { Component } from "@angular/core";';

/** Asserts: parses, decorator text intact, hoisted imports at top level. */
function expectSound(code: string, imports: string[]) {
  expect(syntaxErrors(code)).toEqual([]);
  expect(code).toContain("@Component({");
  const sf = ts.createSourceFile("m.ts", code, ts.ScriptTarget.ES2022, true);
  const topLevel = sf.statements
    .filter(ts.isImportDeclaration)
    .map((s) => s.getText(sf));
  for (const line of imports) expect(topLevel).toContain(line);
}

describe("hoisted tag import placement", () => {
  it("puts the import after the last authored import, not inside the decorator", () => {
    const source = [
      NG_CORE,
      "",
      cls("X", "<div><user-card title=title/></div>", "export "),
    ].join("\n");
    const { code } = compile(source);
    expectSound(code, [CARD_IMPORT]);
    expect(code.startsWith(`${NG_CORE}\n${CARD_IMPORT}\n`)).toBe(true);
  });

  it("handles several tags at once", () => {
    const source = [
      NG_CORE,
      "",
      cls("X", "<div><user-card title=title/><badge label=title/></div>"),
    ].join("\n");
    expectSound(compile(source).code, [
      CARD_IMPORT,
      'import { Badge } from "../tags/badge";',
    ]);
  });

  it("handles a module with no imports at all", () => {
    const { code } = compile(cls("X", "<div><user-card title=title/></div>"));
    expect(code.startsWith(`${CARD_IMPORT}\n`)).toBe(true);
    expect(syntaxErrors(code)).toEqual([]);
    expect(code).toContain("@Component({");
  });

  it("leaves a comment attached to the class attached", () => {
    const source = `/** the card */\n${cls("X", "<div><user-card title=title/></div>")}`;
    const { code } = compile(source);
    expect(code.startsWith(`${CARD_IMPORT}\n/** the card */\n@Component`)).toBe(
      true,
    );
  });

  it.each([
    [
      "a named import of the tag module (F1)",
      'import { I } from "../tags/user-card.mx";',
    ],
    [
      "a side-effect import of the tag module (F2)",
      'import "../tags/user-card.mx";',
    ],
    [
      "a multi-line import of the tag module (I3)",
      'import {\n  A,\n} from "../tags/user-card.mx";',
    ],
  ])("puts the import after %s that opens the file", (_name, authored) => {
    const source = `${authored}\n${cls("X", "<div><user-card title=title/></div>")}`;
    const { code } = compile(source);
    expectSound(code, [CARD_IMPORT]);
    expect(code.startsWith(`${authored}\n${CARD_IMPORT}\n`)).toBe(true);
  });

  it("handles an `export default` class", () => {
    const source = [
      NG_CORE,
      "",
      cls("X", "<div><user-card title=title/></div>", "export default "),
    ].join("\n");
    expectSound(compile(source).code, [CARD_IMPORT]);
  });

  it("handles two decorated classes in one file, one import per tag", () => {
    const source = [
      NG_CORE,
      "",
      cls("A", "<div><user-card title=title/></div>"),
      "",
      cls("B", "<p><user-card title=title/><badge label=title/></p>"),
    ].join("\n");
    const { code } = compile(source);
    expectSound(code, [CARD_IMPORT, 'import { Badge } from "../tags/badge";']);
    expect(code.split(CARD_IMPORT).length - 1).toBe(1);
  });

  it("ignores an import that follows other statements", () => {
    const source = [
      NG_CORE,
      "const n = 1;",
      'import { z } from "zod";',
      "",
      cls("X", "<div><user-card title=title/></div>"),
    ].join("\n");
    const { code } = compile(source);
    expectSound(code, [CARD_IMPORT]);
    expect(code.indexOf(CARD_IMPORT)).toBeGreaterThan(code.indexOf('"zod"'));
  });

  it("keeps anchors and mappings slicing the authored source after the insertion", () => {
    const source = [
      NG_CORE,
      "",
      cls("X", "<div><user-card title=title/></div>"),
    ].join("\n");
    const result = compile(source);
    expect(result.anchors.length).toBeGreaterThan(0);
    const sliced = result.anchors.map((a) => [
      result.code.slice(a.generatedStart, a.generatedEnd),
      source.slice(a.sourceStart, a.sourceEnd),
    ]);
    expect(sliced).toContainEqual(["<div>", "div"]);
    expect(sliced).toContainEqual(['[title]="title"', "title=title"]);
    for (const m of result.mappings) {
      expect(result.code.slice(m.generatedStart, m.generatedEnd).length).toBe(
        m.generatedEnd - m.generatedStart,
      );
    }
  });
});
