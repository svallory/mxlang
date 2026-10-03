/**
 * A dedicated file so a compiler-load spy cannot leak into other
 * suites. Same cases as the TypeScript plugin's: Babel's trailing `(L:C)` is
 * kept unless it repeats the diagnostic's own parser position.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { TargetCompiler, TargetPolicy } from "@mxlang/core";
import { builtinLookup, defaultTarget, hostOf } from "@mxlang/target-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

// The built-in html target, as the registry resolves it.
const html = (): TargetPolicy => {
  const target = defaultTarget();
  return { target, host: hostOf(target) };
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  const [d] = diagnoseDocument(
    files[page] ?? "",
    pathToFileURL(join(dir, page)).href,
    html(),
  );
  return stripVTControlCharacters(String(d?.message ?? ""));
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

  it("keeps an (L:C) that differs from the error's own loc", () => {
    const descriptor = builtinLookup().target(defaultTarget());
    if (!descriptor?.load) throw new Error("missing default target compiler");
    // The registry now owns dispatch, so intercept its compile entry rather
    // than mocking a host index the server no longer imports.
    const wired = descriptor as typeof descriptor & {
      load: NonNullable<typeof descriptor.load>;
    };
    const compileModule: TargetCompiler["compileModule"] = () => {
      // Give loc a position that disagrees with the message's own (12:7).
      throw Object.assign(new Error("only position (12:7)"), {
        loc: { line: 1, column: 3 },
      });
    };
    vi.spyOn(wired, "load").mockReturnValue({ compileModule });
    expect(messageOf({ "page.mx": "<p>PLAIN-ERROR</p>\n" }, "page.mx")).toBe(
      "only position (12:7)",
    );
  });
});
