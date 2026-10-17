import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

// Three independent errors: a scriptlet, an `<if>` without a condition, CDATA.
const SOURCE = [
  "<div>ok</div>",
  "$ const a = 1",
  "<p>fine</p>",
  "<if></if>",
  "<![CDATA[raw]]>",
  "<span>fine</span>",
].join("\n");

it("reports every error of a file as its own diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-plugin-recovery-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"x","mx":{"host":"html"}}',
    );
    const file = join(dir, "page.mx");
    const plugin = createMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      file,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(SOURCE),
      { getAssociatedScript: () => undefined },
    );
    const diagnostics = plugin.getCompileDiagnostics(file);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((d) => d.category === "error")).toBe(true);
    const lines = diagnostics.map(
      (d) => SOURCE.slice(0, d.offset).split("\n").length,
    );
    expect(lines).toEqual([2, 4, 5]);
    expect(diagnostics[0]?.message).toContain("scriptlets");
    expect(diagnostics[1]?.message).toContain("without a condition");
    expect(diagnostics[2]?.message).toContain("CDATA");
    // The plugin's one syntax error stays the first, as before.
    expect(plugin.getSyntaxError(file)?.message).toContain("scriptlets");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two parse errors reach the plugin as one `CompileErrors` aggregate, which has
// no position or code of its own: each of its errors is a diagnostic.
function compileDiagnosticsOf(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "mx-plugin-aggregate-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"x","mx":{"host":"html"}}',
    );
    const file = join(dir, "page.mx");
    const plugin = createMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      file,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    return {
      diagnostics: plugin.getCompileDiagnostics(file),
      syntaxError: plugin.getSyntaxError(file),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a file with several parse errors (a CompileErrors aggregate)", () => {
  it("reports each error at its own range with its own code", () => {
    const source = "<div x=(1+)/>\n<span x=(2+)/>\n";
    const { diagnostics, syntaxError } = compileDiagnosticsOf(source);
    expect(
      diagnostics.map((d) => [d.offset, d.length, d.diagnosticCode]),
    ).toEqual([
      [10, 1, "MX_PARSE_EXPRESSION"],
      [source.indexOf("2+") + 2, 1, "MX_PARSE_EXPRESSION"],
    ]);
    expect(diagnostics.every((d) => d.category === "error")).toBe(true);
    // Each message is its own error's reason, not the whole aggregate's text.
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message.match(/Unexpected token/g)).toHaveLength(1);
    }
    expect(syntaxError?.message.match(/Unexpected token/g)).toHaveLength(1);
  });

  it("reports an unclosed for with its cause first and the plugin's syntax error at the cause", () => {
    const { diagnostics, syntaxError } = compileDiagnosticsOf(
      "<for of=[1]|x|>\n</for>",
    );
    expect(
      diagnostics.map((d) => [d.offset, d.length, d.diagnosticCode]),
    ).toEqual([
      [13, 2, "MX_PARSE_EXPRESSION"],
      [0, 22, "MX_PARSE_MISSING_END_TAG"],
    ]);
    expect(syntaxError?.offset).toBe(13);
  });

  it("keeps the single-error case as it was", () => {
    const { diagnostics } = compileDiagnosticsOf("<div x=(1+)/>\n");
    expect(
      diagnostics.map((d) => [d.offset, d.length, d.diagnosticCode]),
    ).toEqual([[10, 1, "MX_PARSE_EXPRESSION"]]);
  });
});
