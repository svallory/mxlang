/**
 * A dedicated file so `vi.mock` of `@mxlang/html` cannot leak into other
 * suites. Babel's trailing `(L:C)` is dropped only when it repeats the
 * diagnostic's own parser position; these cases must keep their text.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

vi.mock("@mxlang/html", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mxlang/html")>();
  return {
    ...actual,
    compile: (source: string, ...rest: unknown[]) => {
      if (source.includes("PLAIN-ERROR")) {
        // Bun gives every Error numeric line/column (its construction site).
        throw Object.assign(new Error("only position (12:7)"), {
          line: 1,
          column: 3,
        });
      }
      return (actual.compile as (...a: unknown[]) => unknown)(source, ...rest);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function messageOf(files: Record<string, string>, page: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-babel-suffix-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", mx: { host: "html" } }),
  );
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const fileName = join(dir, page);
  const plugin = createMxLanguagePlugin(ts);
  plugin.createVirtualCode?.(
    fileName,
    MX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(files[page] ?? ""),
    { getAssociatedScript: () => undefined },
  );
  return plugin.getCompileDiagnostics(fileName)[0]?.message ?? "";
}

describe("Babel's (L:C) is kept unless it repeats the diagnostic's own position", () => {
  it("keeps a foreign parser's position inside a wrapped custom-tag error", () => {
    const babel = createRequire(import.meta.url).resolve("@babel/parser");
    const message = messageOf(
      {
        "page.mx": "<div>\n  <broken/>\n</div>\n",
        "tags/broken.tag.ts": `import { parse } from ${JSON.stringify(babel)};\nexport default { transform() { parse("\\n\\nconst value = ;", { sourceType: "module", sourceFilename: "/callee/data.ts" }); } };\n`,
      },
      "page.mx",
    );
    expect(message).toContain("custom tag threw");
    expect(message).toMatch(/Unexpected token \(3:14\)/);
  });

  it("keeps a plain Error's own (L:C) although it has numeric line/column", () => {
    const message = messageOf({ "page.mx": "<p>PLAIN-ERROR</p>\n" }, "page.mx");
    expect(message).toBe("only position (12:7)");
  });
});
