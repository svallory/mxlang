import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

it.each([
  ["<p>ok</p>\n\n<div>\n", 3, 0, 'Missing ending "div" tag'],
  ["<div a=(x +)/>\n<span>", 1, 11, "Unexpected token"],
] as const)(
  "routes a real child template syntax error to the child and leaves an exact pointer on the caller",
  (source, line, column, message) => {
    const dir = mkdtempSync(join(tmpdir(), "mx-plugin-callee-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"x","mx":{"host":"html"}}',
      );
      mkdirSync(join(dir, "tags"));
      const child = join(dir, "tags/broken.mx");
      writeFileSync(child, source);
      const caller = join(dir, "page.mx");
      const page = "<main>\n  <broken/>\n</main>\n";
      const plugin = createMxLanguagePlugin(ts);
      plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(page),
        { getAssociatedScript: () => undefined },
      );
      const [own] = plugin.getCompileDiagnostics(child);
      expect(own?.fileName).toBe(child);
      expect(own?.source).toBe(source);
      expect(own?.offset).toBe(11);
      expect(own?.message).toContain(message);
      expect(own?.message).not.toContain(child);
      const [pointer] = plugin.getCompileDiagnostics(caller);
      expect(pointer?.offset).toBe(0);
      expect(pointer?.message).toContain(`(in ${child}:${line}:${column + 1})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
