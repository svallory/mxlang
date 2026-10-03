/**
 * A tag's own `export const selector` wins at the call site in a `.ng.mx`
 * component too (a `.mx` page and an authored import are pinned in
 * `discovered-tag-call.test.ts` and `tag-module.test.ts`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags, type MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile, compileTagModuleFile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";

describe("discovered tags called from a `.ng.mx`", () => {
  it("emits the callee's exported selector, and prefix + kebab without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-sel-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
      mkdirSync(join(dir, "tags"));
      writeFileSync(
        join(dir, "tags", "badge.mx"),
        'export const selector = "liuna-badge";\n<b>!</b>\n',
      );
      writeFileSync(join(dir, "tags", "icon.mx"), "<i>*</i>\n");
      const filePath = join(dir, "x.component.ng.mx");
      const source = [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        '  selector: "app-x",',
        "  template: <div><badge/><icon/></div>,",
        "})",
        "export class XComponent {}",
      ].join("\n");
      writeFileSync(filePath, source);

      const result = compileNgMx(source, filePath, {
        customTags: getCustomTags(filePath, {
          host: "angular",
          targets: angularOwnTargets,
        }),
      });

      expect(result.code).toContain(
        "<div><liuna-badge></liuna-badge><mx-icon></mx-icon></div>",
      );
      expect(result.code).not.toContain("mx-badge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Compiles `page` (or a tag) in a project whose `tags/` holds `tags`. */
function project(tags: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mx-selector-r2-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  mkdirSync(join(dir, "tags"));
  for (const [name, content] of Object.entries(tags)) {
    writeFileSync(join(dir, "tags", name), content);
  }
  return dir;
}

function callSite(dir: string, page = "<badge/>\n") {
  const path = join(dir, "page.mx");
  writeFileSync(path, page);
  const warnings: MxWarning[] = [];
  const result = compile(page, path, {
    customTags: getCustomTags(path, {
      host: "angular",
      targets: angularOwnTargets,
    }) as never,
    warnings,
  });
  return { code: result.code, warnings };
}

function tagModule(dir: string, name = "badge.mx") {
  const path = join(dir, "tags", name);
  const warnings: MxWarning[] = [];
  const result = compileTagModuleFile(path, {
    customTags: getCustomTags(path, {
      host: "angular",
      targets: angularOwnTargets,
    }) as never,
    warnings,
  });
  return { selector: result.selector, warnings };
}

describe("one extraction path for the exported selector (MED-1)", () => {
  // Each body carries an `export const selector` that is NOT a statement.
  const notStatements: Record<string, string> = {
    "block comment":
      '/*\nexport const selector = "in-comment";\n*/\n<b>!</b>\n',
    "html comment":
      '<!--\nexport const selector = "in-comment";\n-->\n<b>!</b>\n',
    "text body": 'export const selector = "in-text" is prose\n<b>!</b>\n',
    "template string":
      'static const doc = `\nexport const selector = "in-string";\n`\n<b>!</b>\n',
  };
  for (const [label, body] of Object.entries(notStatements)) {
    it(`the call site and the tag module agree on mx-badge for a ${label}`, () => {
      const dir = project({ "badge.mx": body });
      try {
        expect(callSite(dir).code).toBe("<mx-badge></mx-badge>");
        expect(tagModule(dir).selector).toBe("mx-badge");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("literal-only overrides (LOW-1)", () => {
  const readable: Record<string, string> = {
    "as const": 'export const selector = "liuna-badge" as const;\n<b/>\n',
    "template literal": "export const selector = `liuna-badge`;\n<b/>\n",
    "single quotes": "export const selector = 'liuna-badge'\n<b/>\n",
  };
  for (const [label, body] of Object.entries(readable)) {
    it(`reads ${label} on both sides`, () => {
      const dir = project({ "badge.mx": body });
      try {
        expect(callSite(dir).code).toBe("<liuna-badge></liuna-badge>");
        expect(tagModule(dir).selector).toBe("liuna-badge");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  const unreadable: Record<string, string> = {
    "typed declaration":
      'export const selector: string = "liuna-badge";\n<b/>\n',
    identifier: 'static const s = "x-y"\nexport const selector = s;\n<b/>\n',
    substitution: 'export const selector = `liuna-${"badge"}`;\n<b/>\n',
  };
  for (const [label, body] of Object.entries(unreadable)) {
    it(`warns identically on both sides for a ${label}, keeping prefix + kebab`, () => {
      const dir = project({ "badge.mx": body });
      try {
        const call = callSite(dir);
        const module = tagModule(dir);
        expect(call.code).toBe("<mx-badge></mx-badge>");
        expect(module.selector).toBe("mx-badge");
        const text = (ws: MxWarning[]) =>
          ws
            .map((w) => w.message)
            .filter((m) => /export const selector/.test(m));
        expect(text(call.warnings)).toHaveLength(1);
        expect(text(module.warnings)).toEqual(text(call.warnings));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("authored `.mx` imports inside a tag module (LOW-4)", () => {
  it("reads the override through a non-relative specifier", () => {
    const dir = project({
      "card.mx":
        'import Badge from "shared-tags/badge.mx";\n<div><Badge/></div>\n',
    });
    try {
      const pkg = join(dir, "node_modules", "shared-tags");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"shared-tags"}');
      writeFileSync(
        join(pkg, "badge.mx"),
        'export const selector = "liuna-badge";\n<b/>\n',
      );
      const { code } = compileTagModuleFile(join(dir, "tags", "card.mx"), {
        customTags: getCustomTags(join(dir, "tags", "card.mx"), {
          host: "angular",
          targets: angularOwnTargets,
        }) as never,
      });
      expect(code).toContain("<liuna-badge></liuna-badge>");
      expect(code).not.toContain("<mx-badge>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors, rather than falling back, when an authored import's file is missing", () => {
    const dir = project({
      "card.mx": 'import Badge from "./gone.mx";\n<div><Badge/></div>\n',
    });
    try {
      expect(() =>
        compileTagModuleFile(join(dir, "tags", "card.mx"), {
          customTags: getCustomTags(join(dir, "tags", "card.mx"), {
            host: "angular",
            targets: angularOwnTargets,
          }) as never,
        }),
      ).toThrow(/cannot resolve .*gone\.mx/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
