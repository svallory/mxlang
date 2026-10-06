import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AMX_LANGUAGE_ID, createAmxLanguagePlugin } from "./amx-language.ts";

/**
 * Astro's `convertToTSX` decides element-vs-component by the tag name's first
 * letter, so a `$`-led name is an HTML element, and a self-closing one is
 * rewritten to `<$mx_Badge1 /{`>`}`: syntactically invalid TSX. `@mxlang/astro`
 * therefore lowers a custom tag to an upper-case-led binding (`<Mx_Badge1 />`),
 * and the projection hands TypeScript text that parses with no help of its own.
 */
const page = join(
  import.meta.dirname,
  "../../tsc/src/fixtures/host-dispatch/astro-mx/page.astro.mx",
);

function virtualTsx(source: string): string {
  const plugin = createAmxLanguagePlugin(ts);
  const virtual = plugin.createVirtualCode?.(
    page,
    AMX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!virtual) throw new Error("expected AMX virtual code");
  return virtual.snapshot.getText(0, virtual.snapshot.getLength());
}

function parseDiagnostics(tsx: string): string[] {
  const file = ts.createSourceFile(
    "page.tsx",
    tsx,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return (
    file as unknown as { parseDiagnostics: ts.Diagnostic[] }
  ).parseDiagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

describe(".astro.mx custom tag: virtual TSX", () => {
  const original = readFileSync(page, "utf8");
  const sources: Record<string, string> = {
    "self-closing": original,
    "with attributes": original.replace("<badge/>", '<badge label="a"/>'),
    "twice, nested": original.replace(
      "<badge/>",
      "<div><badge/><badge/></div>",
    ),
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`parses without syntax errors: ${name}`, () => {
      const tsx = virtualTsx(source);
      expect(parseDiagnostics(tsx)).toEqual([]);
      expect(tsx).not.toContain("/{`>`}");
    });
  }

  it("projects the host's upper-case-led tag name unchanged", () => {
    const tsx = virtualTsx(original);
    expect(tsx).toContain("Mx_Badge1");
    expect(tsx).not.toContain("$mx_");
  });

  it("parses when the page itself mentions the old stand-in spelling", () => {
    const tsx = virtualTsx(
      original.replace("<badge/>", "<badge/><!-- Xmx_ -->"),
    );
    expect(parseDiagnostics(tsx)).toEqual([]);
  });
});
