// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A shorthand `id` or `class` whose placeholder holds a string literal alone
 * (`<div#${"lit"}/>`) compiles, and renders the attribute the author wrote.
 * Stock Marko 6.4.4 folds it into a static one (`<div id=lit></div>`); this
 * host always quotes an attribute value, so the markup is the same
 * attribute with the quotes every other attribute here carries.
 */

let serial = 0;

async function render(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `mx-shorthand-literal-${serial++}-`));
  try {
    writeFileSync(
      join(dir, "runtime.ts"),
      [
        `export { escape } from ${JSON.stringify(fileURLToPath(new URL("../../../core/src/escape.ts", import.meta.url)))};`,
        `export { createBufferedOut, createOut } from ${JSON.stringify(fileURLToPath(new URL("./runtime.ts", import.meta.url)))};`,
      ].join("\n"),
    );
    const path = join(dir, "App.mx");
    const code = compile(`${source}\n`, path).code.replaceAll(
      'from "@mxlang/target-html"',
      'from "./runtime.ts"',
    );
    writeFileSync(join(dir, "App.ts"), code);
    const module = (await import(
      `${pathToFileURL(join(dir, "App.ts")).href}?t=${Date.now()}`
    )) as { default: (input: unknown) => string };
    return module.default({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a shorthand whose placeholder is a string literal alone (html)", () => {
  it.each([
    ["<div> id, string literal", '<div#${"lit"}/>', '<div id="lit"></div>'],
    [
      "<div> class, string literal",
      '<div.${"lit"}/>',
      '<div class="lit"></div>',
    ],
    ["concise id", 'div#${"lit"}', '<div id="lit"></div>'],
    [
      "a word before the placeholder",
      '<div.a${"lit"}/>',
      '<div class="alit"></div>',
    ],
    ["single quotes", "<div#${'lit'}/>", '<div id="lit"></div>'],
    [
      "no substitutions in a template literal",
      "<div#${`lit`}/>",
      '<div id="lit"></div>',
    ],
    [
      "two class placeholders",
      '<div.${"a"}.${"b"}/>',
      '<div class="a b"></div>',
    ],
    [
      "a placeholder and a static class word",
      '<div.${"lit"}.b/>',
      '<div class="lit b"></div>',
    ],
    ["concise class", 'div.${"lit"}', '<div class="lit"></div>'],
    [
      "an identifier placeholder (unchanged)",
      "<div#${input.x}/>",
      "<div></div>",
    ],
  ])("%s: %s", async (_label, source, html) => {
    expect(await render(source)).toBe(html);
  });

  it("renders the same markup as the static shorthand it equals", async () => {
    expect(await render('<div#${"lit"}/>')).toBe(await render("<div#lit/>"));
    expect(await render('<div.${"lit"}/>')).toBe(await render("<div.lit/>"));
  });

  it("still refuses the shorthand id beside an authored id", () => {
    expect(() => compile('<div#${"lit"} id=x/>\n', "/f/t.mx")).toThrow(
      /shorthand id and id attribute/,
    );
  });
});
