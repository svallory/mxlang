// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-astro-raw-html-spread-"));
const require = createRequire(import.meta.url);
const astroRequire = createRequire(
  realpathSync(require.resolve("astro/package.json")),
);
const compilerEntry = astroRequire.resolve("@astrojs/compiler-rs");

interface AstroCompiler {
  transform(
    source: string,
    options: { filename: string },
  ): Promise<{ code: string; diagnostics?: unknown[] }>;
}

let compiler: AstroCompiler;
let container: AstroContainer;

function containerModule(code: string): string {
  return code
    .replace(", createMetadata as $$createMetadata", "")
    .replace(
      /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
      "",
    );
}

beforeAll(async () => {
  compiler = (await import(pathToFileURL(compilerEntry).href)) as AstroCompiler;
  container = await AstroContainer.create();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let serial = 0;

async function render(template: string, declarations: string): Promise<string> {
  const name = `case${serial++}`;
  const source = `---\n${declarations}\n---\n${template}`;
  const lowered = lowerAstroMx(source, join(dir, `${name}.astro.mx`)).code;
  const result = await compiler.transform(lowered, {
    filename: join(dir, `${name}.astro`),
  });
  expect(result.diagnostics ?? []).toEqual([]);
  const moduleFile = join(dir, `${name}.mjs`);
  writeFileSync(moduleFile, containerModule(result.code));
  const component = (
    (await import(/* @vite-ignore */ pathToFileURL(moduleFile).href)) as {
      default: Parameters<AstroContainer["renderToString"]>[0];
    }
  ).default;
  return container.renderToString(component);
}

/**
 * Marko 6.4.4 prints a spread's `innerHTML` (and `outerHTML`, `textContent`)
 * as an ordinary attribute, never as the element's content (probed: `_attrs`
 * writes `innerHTML="<b>x</b>"`). Astro's spread renders attributes only, so
 * it matches: the value stays inside the quoted attribute and no element is
 * created. These tests pin that, because the JSX hosts once treated the same
 * keys as raw markup. Astro's `set:html` and `set:text` are compile-time
 * directives on a literal attribute; as spread keys Astro drops them, which is
 * safe (nothing reaches the markup) though Marko would print them.
 */
describe("a spread key that names raw HTML on Astro", () => {
  it.each([
    [
      "innerHTML",
      'const attrs = { innerHTML: "<b>x</b>" };',
      'innerHTML="<b>x</b>"',
    ],
    [
      "outerHTML",
      'const attrs = { outerHTML: "<b>x</b>" };',
      'outerHTML="<b>x</b>"',
    ],
    [
      "textContent",
      'const attrs = { textContent: "<b>x</b>" };',
      'textContent="<b>x</b>"',
    ],
    ["set:html", 'const attrs = { "set:html": "<b>x</b>" };', ""],
    ["set:text", 'const attrs = { "set:text": "<b>x</b>" };', ""],
  ])(
    "%s never becomes element content",
    async (_name, declarations, attribute) => {
      expect(await render("<div ...attrs/>", declarations)).toBe(
        `<div${attribute ? ` ${attribute}` : ""}></div>`,
      );
    },
  );

  it("a spread beside a body keeps the body", async () => {
    expect(
      await render(
        "<div ...attrs>body</div>",
        'const attrs = { innerHTML: "<b>x</b>" };',
      ),
    ).toBe('<div innerHTML="<b>x</b>">body</div>');
  });
});
