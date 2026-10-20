import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AMX_LANGUAGE_ID, createAmxLanguagePlugin } from "./amx-language.ts";
import {
  createSolidMxLanguagePlugin,
  SOLID_MX_LANGUAGE_ID,
} from "./language.ts";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

/**
 * At the .mx, region and .astro.mx scan-warning sites, a `package.json`
 * that fails to parse is already reported by
 * the host policy as a positioned diagnostic (TS80003 in `mx-tsc`), so the
 * scan's `MX_IGNORED_CONFIG` twin is filtered through
 * `scanDiagnosticsNotSaidByPolicy` before it is logged. Reverting any of the
 * three filter call sites (`mx-language.ts`, `language.ts` region,
 * `amx-language.ts`) makes these tests fail: the twin mentions
 * `could not be parsed as JSON` in a `console.warn` call.
 */

const dirs: string[] = [];
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function brokenProject(fileName: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-manifest-warn-once-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "name": "a", mx: }');
  writeFileSync(join(dir, fileName), source);
  return join(dir, fileName);
}

/** Every `console.warn` line emitted while `createVirtualCode` runs. */
function warnsFor(create: () => void): string[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    create();
    return warn.mock.calls.map((call) => String(call[0]));
  } finally {
    warn.mockRestore();
  }
}

describe("a broken package.json warns once per language plugin", () => {
  it("the .mx plugin logs no scan twin of the policy diagnostic", () => {
    const fileName = brokenProject("page.mx", "<p>hi</p>\n");
    const plugin = createMxLanguagePlugin(ts);
    const warns = warnsFor(() => {
      plugin.createVirtualCode?.(
        fileName,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("<p>hi</p>\n"),
        { getAssociatedScript: () => undefined },
      );
    });
    expect(warns).toEqual([]);
  });

  it("the region plugin logs no scan twin of the policy diagnostic", () => {
    const fileName = brokenProject(
      "page.solid.mx",
      "const a = <div>x</div>;\n",
    );
    const plugin = createSolidMxLanguagePlugin(ts);
    const warns = warnsFor(() => {
      plugin.createVirtualCode?.(
        fileName,
        SOLID_MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("const a = <div>x</div>;\n"),
        { getAssociatedScript: () => undefined },
      );
    });
    expect(warns).toEqual([]);
  });

  it("the .astro.mx plugin logs no scan twin of the policy diagnostic", () => {
    const fileName = brokenProject(
      "page.astro.mx",
      "---\nconst a = 1;\n---\n<p>hi</p>\n",
    );
    const plugin = createAmxLanguagePlugin(ts);
    const warns = warnsFor(() => {
      plugin.createVirtualCode?.(
        fileName,
        AMX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("---\nconst a = 1;\n---\n<p>hi</p>\n"),
        { getAssociatedScript: () => undefined },
      );
    });
    expect(warns).toEqual([]);
  });
});
