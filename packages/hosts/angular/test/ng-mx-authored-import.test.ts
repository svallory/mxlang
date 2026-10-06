/**
 * An authored `import X from "<path>.mx"` used as a tag in a `.ng.mx` region
 * (LiUNA gap G7). It must emit exactly what the discovered spelling of the
 * same callee emits: one named-class import, one `imports:` entry, the
 * callee's selector.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A project with `files` (relative path -> content) and a package boundary. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-import-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function ngMx(
  imports: string[],
  template: string,
  decoratorExtra = "",
): string {
  return [
    'import { Component } from "@angular/core";',
    ...imports,
    "",
    "@Component({",
    '  selector: "app-x",',
    decoratorExtra,
    `  template: ${template},`,
    "})",
    "export class XComponent {}",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const requireHere = createRequire(import.meta.url);

/**
 * Type-checks emitted module `code` in a real TypeScript program with
 * `noUnusedLocals` (TS6133 is a hard error in common tsconfigs) and returns
 * every diagnostic as text. `./tags/*` resolve to stubs beside the file, and
 * `@angular/core` to the copy this package tests against.
 */
function typeCheck(dir: string, code: string): string[] {
  const file = join(dir, "x.component.ts");
  writeFileSync(file, code);
  writeFileSync(
    join(dir, "tags", "badge.ts"),
    "export class Badge {}\nexport class Other {}\n",
  );
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    skipLibCheck: true,
    types: [],
    baseUrl: dir,
    paths: {
      "@angular/core": [
        join(
          requireHere.resolve("@angular/core/package.json"),
          "..",
          "types",
          "core.d.ts",
        ),
      ],
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) =>
        `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
}

function run(dir: string, source: string) {
  const path = join(dir, "x.component.ng.mx");
  writeFileSync(path, source);
  return compileNgMx(source, path, {
    customTags: getCustomTags(path, {
      host: "angular",
      targets: angularOwnTargets,
    }),
  });
}

/** `line:column` a `TranslateError` carries. */
function at(error: Error): string {
  const { line, column } = error as Error & { line: number; column: number };
  return `${line}:${column}`;
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("authored .mx import in a .ng.mx region", () => {
  it("compiles from tags/ and wires the class like the discovered spelling", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const authored = run(
      dir,
      ngMx(['import Badge from "./tags/badge.mx";'], "<div><Badge/></div>"),
    );
    const discovered = run(dir, ngMx([], "<div><badge/></div>"));

    expect(authored.code).toContain("<div><mx-badge></mx-badge></div>");
    expect(authored.code).toContain('import { Badge } from "./tags/badge";');
    expect(authored.code).toContain("imports: [Badge]");
    expect(authored.code).not.toContain("badge.mx");
    // Same wiring as the discovered spelling of the same callee.
    const wiring = (tags: typeof authored.usedTags) =>
      tags.map(({ className, specifier }) => ({ className, specifier }));
    expect(wiring(authored.usedTags)).toEqual(wiring(discovered.usedTags));
  });

  it("compiles a callee outside tags/", () => {
    const dir = project({ "widgets/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(['import Badge from "./widgets/badge.mx";'], "<div><Badge/></div>"),
    );
    expect(result.code).toContain("<div><mx-badge></mx-badge></div>");
    expect(result.code).toContain('import { Badge } from "./widgets/badge";');
    expect(result.code).toContain("imports: [Badge]");
  });

  it("takes the selector from the callee file, not the binding, when aliased", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(['import Chip from "./tags/badge.mx";'], "<div><Chip/></div>"),
    );
    expect(result.code).toContain("<div><mx-badge></mx-badge></div>");
    expect(result.code).toContain("imports: [Chip]");
    expect(result.code).toContain(
      'import { Badge as Chip } from "./tags/badge";',
    );
    expect(result.code).not.toContain("badge.mx");
  });

  it("adds no duplicate imports: entry when also discovered", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        ['import Badge from "./tags/badge.mx";'],
        "<div><Badge/><badge/></div>",
      ),
    );
    expect(result.code).toContain(
      "<div><mx-badge></mx-badge><mx-badge></mx-badge></div>",
    );
    expect(count(result.code, "imports: [Badge]")).toBe(1);
    expect(count(result.code, "import { Badge }")).toBe(1);
  });

  it("emits the callee's exported selector override", () => {
    const dir = project({
      "tags/badge.mx": 'export const selector = "liuna-badge";\n<b>!</b>\n',
    });
    const result = run(
      dir,
      ngMx(['import Chip from "./tags/badge.mx";'], "<div><Chip/></div>"),
    );
    expect(result.code).toContain("<div><liuna-badge></liuna-badge></div>");
    expect(result.code).not.toContain("mx-badge");
  });

  it("keeps a non-tag import in the same statement untouched", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        ['import Badge from "./tags/badge.mx";', 'import { x } from "./x";'],
        "<div><Badge/>${x}</div>",
      ),
    );
    expect(result.code).toContain('import { x } from "./x";');
  });

  it("reports an unresolvable import at the import line, never a fallback", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const err = thrown(() =>
      run(
        dir,
        ngMx(['import Nope from "./tags/missing.mx";'], "<div><Nope/></div>"),
      ),
    );
    expect(err.message).toContain("cannot resolve `./tags/missing.mx`");
    // Line 2 is the import, column 0 its start.
    expect(at(err)).toBe("2:0");
  });

  it("does not fail on an unresolvable .mx default import never used as a tag", () => {
    const dir = project({});
    const result = run(
      dir,
      ngMx(['import Nope from "./tags/missing.mx";'], "<div>hi</div>"),
    );
    expect(result.code).toContain('import Nope from "./tags/missing.mx";');
  });

  it("rejects a mixed default + named .mx import used as a tag, at the import", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const err = thrown(() =>
      run(
        dir,
        ngMx(
          ['import Badge, { b } from "./tags/badge.mx";'],
          "<div><Badge/></div>",
        ),
      ),
    );
    expect(err.message).toContain("must be a sole default import");
    expect(err.message).toContain("discovered `<kebab-name/>` spelling");
    expect(at(err)).toBe("2:0");
  });

  it("rejects a .marko default import used as a tag, at the tag", () => {
    const dir = project({ "tags/x.marko": "<b>x</b>\n" });
    const err = thrown(() =>
      run(
        dir,
        ngMx(['import Foo from "./tags/x.marko";'], "<div><Foo/></div>"),
      ),
    );
    expect(err.message).toContain(
      "`<Foo>` resolves to `tags/x.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/x.mx`).",
    );
    // At the tag (5:17 in the module), not at the import.
    expect(err).toMatchObject({ loc: { line: 5, column: 17 } });
  });

  it("rejects a .marko default import used as a direct dynamic tag, at the tag", () => {
    const dir = project({ "tags/x.marko": "<b>x</b>\n" });
    const err = thrown(() =>
      run(
        dir,
        ngMx(['import Foo from "./tags/x.marko";'], "<div><${Foo}/></div>"),
      ),
    );
    expect(err.message).toContain(
      "`<${Foo}>` resolves to `tags/x.marko`, a `.marko` file",
    );
    expect(err).toMatchObject({ loc: { line: 5, column: 17 } });
  });

  it("leaves an unused .marko import, and an indirect dynamic use, alone", () => {
    const dir = project({ "tags/x.marko": "<b>x</b>\n" });
    expect(() =>
      run(dir, ngMx(['import Foo from "./tags/x.marko";'], "<div>hi</div>")),
    ).not.toThrow();
    expect(() =>
      run(
        dir,
        ngMx(
          ['import Foo from "./tags/x.marko";', "const Bar = Foo;"],
          "<div><${Bar}/></div>",
        ),
      ),
    ).not.toThrow(/resolves to/);
  });

  it("emits one import and uses the alias in imports: when aliased", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(['import Chip from "./tags/badge.mx";'], "<div><Chip/></div>"),
    );
    expect(result.code).toContain("imports: [Chip]");
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(result.code).toContain(
      'import { Badge as Chip } from "./tags/badge";',
    );
    expect(result.code).not.toContain("import { Badge }");
  });

  it("lists an aliased class once when the same callee is also discovered", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        ['import Chip from "./tags/badge.mx";'],
        "<div><Chip/><badge/></div>",
      ),
    );
    expect(result.code).toContain("imports: [Chip]");
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(result.code).toContain(
      "<div><mx-badge></mx-badge><mx-badge></mx-badge></div>",
    );
  });

  it("type-checks under noUnusedLocals for a single alias", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(['import Chip from "./tags/badge.mx";'], "<div><Chip/></div>"),
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps every alias of one callee referenced (two aliases, one class)", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain("imports: [Chip]");
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(result.code).not.toContain("Pill");
    expect(result.code).toContain(
      "<div><mx-badge></mx-badge><mx-badge></mx-badge></div>",
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps a second alias the author's own TypeScript still reads", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export const same = Pill;",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain(
      'import { Badge as Pill } from "./tags/badge";',
    );
    expect(result.code).toContain("imports: [Chip]");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("dedupes a discovered <badge/> that comes first, then two authored aliases", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        ['import Chip from "./tags/badge.mx";'],
        "<div><badge/><Chip/></div>",
      ),
    );
    expect(result.code).toContain("imports: [Chip]");
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(result.code).not.toContain("import { Badge }");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("dedupes discovered-first with two aliases in one component", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
        ],
        "<div><badge/><Pill/><Chip/></div>",
      ),
    );
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(count(result.code, "imports: [")).toBe(1);
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("references each alias in its own component when two components split them", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const source = [
      'import { Component } from "@angular/core";',
      'import Chip from "./tags/badge.mx";',
      'import Pill from "./tags/badge.mx";',
      "",
      "@Component({",
      '  selector: "app-a",',
      "  template: <div><Chip/></div>,",
      "})",
      "export class AComponent {}",
      "",
      "@Component({",
      '  selector: "app-b",',
      "  template: <div><Pill/></div>,",
      "})",
      "export class BComponent {}",
    ].join("\n");
    const result = run(dir, source);
    expect(result.code).toContain("imports: [Chip]");
    expect(result.code).toContain("imports: [Pill]");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("drops the redundant alias in every component that uses the same callee", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const source = [
      'import { Component } from "@angular/core";',
      'import Chip from "./tags/badge.mx";',
      'import Pill from "./tags/badge.mx";',
      "",
      "@Component({",
      '  selector: "app-a",',
      "  template: <div><Chip/><Pill/></div>,",
      "})",
      "export class AComponent {}",
      "",
      "@Component({",
      '  selector: "app-b",',
      "  template: <div><Chip/></div>,",
      "})",
      "export class BComponent {}",
    ].join("\n");
    const result = run(dir, source);
    expect(count(result.code, "imports: [Chip]")).toBe(2);
    expect(count(result.code, "./tags/badge")).toBe(1);
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("drops the second alias when Pill is only a property key or member name", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export const o = { Pill: 1 }; export const p = o.Pill;",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).not.toContain("Badge as Pill");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("drops the second alias when Pill is only a shadowing local in a nested function", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export function f(Pill: number) { return Pill; }",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).not.toContain("import { Badge as Pill }");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps the second alias when Pill is read in a type position", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export declare const t: typeof Pill;",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain(
      'import { Badge as Pill } from "./tags/badge";',
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("drops the second alias when every other Pill is a shadowing binding or member name", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export function a() { try { return 1; } catch (Pill) { return Pill; } }",
          "export function b() { { const Pill = 2; return Pill; } }",
          "export function c() { var Pill = 3; return Pill; }",
          "export const d = ({ x: Pill }: { x: number }) => Pill;",
          "export const e = ([Pill]: number[]) => Pill;",
          "export class K { Pill = 1; m() { return this.Pill; } }",
          "export const f = function Pill() { return 1; };",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).not.toContain("Badge as Pill");
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps the second alias when Pill is read as an array element", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export const g = [Pill];",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain(
      'import { Badge as Pill } from "./tags/badge";',
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps the second alias when Pill is read as an object shorthand", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export const h = { Pill };",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain(
      'import { Badge as Pill } from "./tags/badge";',
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("keeps the second alias when Pill is read as a default parameter value", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const result = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
          "export const i = (x = Pill) => x;",
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(result.code).toContain(
      'import { Badge as Pill } from "./tags/badge";',
    );
    expect(typeCheck(dir, result.code)).toEqual([]);
  });

  it("removes a dropped import's whole line and never joins the next statement onto it", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const own = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx";',
          'import Pill from "./tags/badge.mx";',
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    const lines = own.code.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      'import { Component } from "@angular/core";',
      'import { Badge as Chip } from "./tags/badge";',
      "@Component({",
    ]);
    // Sharing a line with the next statement: only the import goes.
    const shared = run(
      dir,
      ngMx(
        [
          'import Chip from "./tags/badge.mx"; import Pill from "./tags/badge.mx"; export const k = 1;',
        ],
        "<div><Chip/><Pill/></div>",
      ),
    );
    expect(shared.code.split("\n")[1]).toBe(
      'import { Badge as Chip } from "./tags/badge"; export const k = 1;',
    );
    expect(typeCheck(dir, shared.code)).toEqual([]);
  });

  it("is byte-identical to the discovered spelling except the import line", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const authored = run(
      dir,
      ngMx(['import Badge from "./tags/badge.mx";'], "<div><Badge/></div>"),
    );
    const discovered = run(dir, ngMx([], "<div><badge/></div>"));
    const withoutImport = (code: string) =>
      code
        .split("\n")
        .filter((line) => line !== 'import { Badge } from "./tags/badge";')
        .join("\n")
        .replace(/\n{2,}/g, "\n\n");
    expect(withoutImport(authored.code)).toBe(
      withoutImport(discovered.code).replace("<badge/>", "<Badge/>"),
    );
    expect(authored.warnings).toEqual(discovered.warnings);
    // Mappings: every run the discovered spelling maps is mapped identically
    // (same emitted text, same derivation). The authored spelling additionally
    // maps the tag name, which the author wrote and a discovered tag has no
    // span for.
    const runs = (result: typeof authored) =>
      result.mappings.map(
        (m) =>
          `${result.code.slice(m.generatedStart, m.generatedEnd)}|${m.derive ?? ""}`,
      );
    const authoredRuns = runs(authored);
    for (const run of runs(discovered)) expect(authoredRuns).toContain(run);
    for (const m of authored.mappings) {
      const text = authored.code.slice(m.generatedStart, m.generatedEnd);
      if (!runs(discovered).includes(`${text}|${m.derive ?? ""}`)) {
        expect(m.derive).toBe("resolved-selector");
      }
    }
  });

  it("preserves a .mx default import never used as a tag byte-for-byte", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const source = ngMx(
      ['import Badge from "./tags/badge.mx";'],
      "<div>hi</div>",
    );
    const result = run(dir, source);
    expect(result.code).toBe(
      source.replace("<div>hi</div>", "`<div>hi</div>`"),
    );
  });

  it("lowers a module-scope const used as a tag to ngComponentOutlet (decision 116)", () => {
    const dir = project({});
    const result = run(dir, ngMx(["const Local = 1;"], "<div><Local/></div>"));
    expect(result.code).toContain("ngComponentOutlet");
  });
});

describe("plain Angular page .mx", () => {
  it("keeps its by-design authored-import error", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    const path = join(dir, "page.mx");
    const source = 'import Badge from "./tags/badge.mx";\n<Badge/>\n';
    writeFileSync(path, source);
    expect(() =>
      compile(source, path, {
        customTags: getCustomTags(path, {
          host: "angular",
          targets: angularOwnTargets,
        }) as never,
      }),
    ).toThrow(/an Angular template has no module scope/);
  });
});
