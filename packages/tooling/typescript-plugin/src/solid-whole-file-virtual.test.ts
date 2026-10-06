// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { SourceMap } from "@volar/language-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

/**
 * A whole-file `.mx` resolved to Solid is projected for the type-check like a
 * region: the host's `completeTypecheckModule` imports the built-ins its
 * compiler stage would, and every authored name that survives a rewrite maps
 * to its exact authored offset. Resolved with Volar's own `SourceMap`.
 */
const here = new URL("./fixtures/", import.meta.url).pathname;

function virtual(source: string) {
  const code = createMxLanguagePlugin(ts).createVirtualCode?.(
    `${here}solid-policy/page.mx`,
    MX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!code) throw new Error("Expected MX virtual code");
  const generated = code.snapshot.getText(0, code.snapshot.getLength());
  const map = new SourceMap(code.mappings as never);
  const toSource = (generatedOffset: number) =>
    [...map.toSourceLocation(generatedOffset)][0]?.[0];
  return { generated, toSource };
}

/** The authored offset of the generated `needle`'s first character. */
function offsetOf(source: string, needle: string) {
  const { generated, toSource } = virtual(source);
  const at = generated.indexOf(needle);
  expect(at).toBeGreaterThan(0);
  return { authored: toSource(at), expected: source.indexOf(needle) };
}

describe("a whole-file Solid unit's virtual code", () => {
  it("imports the built-ins the printed JSX uses, appended after every mapped offset", () => {
    const source =
      'static const list = [{ name: "a" }];\n<for|row| of=list><p>${row.name}</p></for>\n';
    const { generated } = virtual(source);
    expect(generated).toContain('import { For } from "solid-js";');
    expect(generated.indexOf("<For")).toBeLessThan(
      generated.indexOf('import { For } from "solid-js";'),
    );
  });

  it.each([
    [
      "an index read (`i` to `i()`)",
      "<for|row, i| of=xs><p>${i + miss}</p></for>",
    ],
    [
      "a keyed row read (`row` to `row()`)",
      '<for|row| of=xs by="id"><p>${row.a + miss}</p></for>',
    ],
    [
      "a for-in key and value",
      "<for|k, v| in=obj><p>${k + v + miss}</p></for>",
    ],
  ])("maps the name after %s to its authored offset", (_name, source) => {
    const { authored, expected } = offsetOf(source, "miss");
    expect(authored).toBe(expected);
  });

  it("maps the dynamic tag's expression", () => {
    const { authored, expected } = offsetOf("<${missingDyn}/>", "missingDyn");
    expect(authored).toBe(expected);
  });

  it("does not add `?? {}` after an object literal in `<for in>`", () => {
    const { generated } = virtual("<for|k, v| in={ a: 1 }><p>${k}</p></for>");
    expect(generated).toContain("Object.entries({ a: 1 })");
    expect(generated).not.toContain("?? {}");
  });
});
