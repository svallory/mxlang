import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createMxLanguagePlugin } from "./mx-language.ts";

/**
 * Host-policy diagnostics are per language-plugin instance (tsserver hosts
 * several projects per process, each with its own plugins): a bad `mx.host`
 * one plugin compiled under never reaches another plugin's answer, asked
 * without a file name (everything that plugin recorded).
 */

const dirs: string[] = [];
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function packageDir(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-host-policy-isolation-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), manifest);
  return dir;
}

function compiled(dir: string) {
  const plugin = createMxLanguagePlugin(ts);
  plugin.createVirtualCode?.(
    join(dir, "page.mx"),
    "mx",
    ts.ScriptSnapshot.fromString("<p>Hello</p>\n"),
    { getAssociatedScript: () => undefined },
  );
  return plugin;
}

describe("host-policy diagnostics of two plugin instances", () => {
  it("keeps them apart: A's unknown host never reaches B, before or after A is asked again", () => {
    const bad = packageDir('{\n  "mx": {\n    "host": "vue"\n  }\n}\n');
    const a = compiled(bad);
    const b = compiled(packageDir('{ "mx": { "host": "html" } }'));

    const unknownHost = [
      {
        code: "unknown-host",
        file: join(bad, "package.json"),
        message: expect.stringContaining('unknown mx.host "vue"'),
        line: 3,
        column: 12,
        offset: 24,
      },
    ];

    expect(b.getTargetPolicyDiagnostics()).toEqual([]);
    expect(a.getTargetPolicyDiagnostics()).toEqual(unknownHost);
    expect(b.getTargetPolicyDiagnostics()).toEqual([]);
    expect(a.getTargetPolicyDiagnostics()).toEqual(unknownHost);
    expect(b.getTargetPolicyDiagnostics()).toEqual([]);
  });
});
