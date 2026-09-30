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
    expect(result.code).toContain("imports: [Badge]");
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

  it("reports a positioned error for an unresolvable import, never a fallback", () => {
    const dir = project({ "tags/badge.mx": "<b>!</b>\n" });
    let error: unknown;
    try {
      run(
        dir,
        ngMx(['import Nope from "./tags/missing.mx";'], "<div><Nope/></div>"),
      );
    } catch (e) {
      error = e;
    }
    const err = error as Error & { loc?: { line: number }; line?: number };
    expect(err.message).toContain("cannot resolve `./tags/missing.mx`");
    // Positioned: the message carries `(line:column)` like every other error.
    expect(err.message).toMatch(/\(\d+:\d+\)$/);
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
