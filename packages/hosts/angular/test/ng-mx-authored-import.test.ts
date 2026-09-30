/**
 * An authored `import X from "<path>.mx"` used as a tag in a `.ng.mx` region
 * (LiUNA gap G7). It must emit exactly what the discovered spelling of the
 * same callee emits: one named-class import, one `imports:` entry, the
 * callee's selector.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";

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

function run(dir: string, source: string) {
  const path = join(dir, "x.component.ng.mx");
  writeFileSync(path, source);
  return compileNgMx(source, path, {
    customTags: getCustomTags(path, { host: "angular" }),
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

  it("rejects a .marko default import used as a tag, at the import", () => {
    const dir = project({ "tags/x.marko": "<b>x</b>\n" });
    const err = thrown(() =>
      run(
        dir,
        ngMx(['import Foo from "./tags/x.marko";'], "<div><Foo/></div>"),
      ),
    );
    expect(err.message).toContain(
      "a `.marko` component cannot be used as a tag in an Angular `.ng.mx` module",
    );
    expect(at(err)).toBe("2:0");
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
        customTags: getCustomTags(path, { host: "angular" }) as never,
      }),
    ).toThrow(/an Angular template has no module scope/);
  });
});
