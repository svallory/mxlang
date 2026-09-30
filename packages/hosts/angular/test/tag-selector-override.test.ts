/**
 * A tag's own `export const selector` wins at the call site in a `.ng.mx`
 * component too (a `.mx` page and an authored import are pinned in
 * `discovered-tag-call.test.ts` and `tag-module.test.ts`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";

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
        customTags: getCustomTags(filePath, { host: "angular" }),
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
