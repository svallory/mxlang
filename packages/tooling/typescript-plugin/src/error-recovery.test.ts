import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
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

it("reports every error of a file as its own diagnostic (decision 162)", () => {
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
