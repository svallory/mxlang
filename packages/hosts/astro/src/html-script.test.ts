// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * `<html-script>` on Astro, by RENDERING through Astro's own compiler and
 * container. Stock Marko 6.4.4 writes a real `<script>` that keeps every
 * attribute, with a body that is script text: placeholders stringified as in
 * any text, the whole body then escaped for script context (`<script`,
 * `</script`, `<!--` become `\u003C…`), never HTML-escaped. This host used to
 * emit a literal `<html-script>` element. It now writes
 * `<script is:inline … set:html={…}>`: `is:inline` so Astro keeps the element
 * where it is instead of bundling it, `set:html` so the body is not
 * entity-escaped.
 */
const dir = mkdtempSync(join(tmpdir(), "mx-astro-html-script-"));
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

/** See `astro-template-render.test.ts`: drop the metadata export the container cannot resolve. */
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

/** Renders `template` with `declarations` in the `---` fence. */
async function render(template: string, declarations = ""): Promise<string> {
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

describe("<html-script> on Astro emits a real <script>", () => {
  it("writes an inline script element, not a literal <html-script>", () => {
    const { code } = lowerAstroMx(
      '---\n---\n<html-script async src="/a.js"/>',
      join(dir, "emit.astro.mx"),
    );
    expect(code).toContain('<script is:inline async src="/a.js" />');
    expect(code).not.toContain("html-script");
  });

  it("carries the body through set:html with the script escape", () => {
    const { code } = lowerAstroMx(
      "---\n---\n<html-script>const v = ${1};</html-script>",
      join(dir, "emit2.astro.mx"),
    );
    expect(code).toContain(
      '<script is:inline set:html={__mxScriptText("const v = ", 1, ";")} />',
    );
    expect(code).toContain("const __mxScriptText =");
  });

  it("emits no helper when no script has a body", () => {
    const { code } = lowerAstroMx(
      '---\n---\n<html-script src="/a.js"/>',
      join(dir, "emit3.astro.mx"),
    );
    expect(code).not.toContain("__mxScriptText");
  });
});

describe("<html-script> on Astro keeps its attributes and escapes its body as script text", () => {
  it("static, dynamic and boolean attributes", async () => {
    expect(
      await render(
        '<html-script type="module" data-x=y async>go();</html-script>',
        'const y = "a b";',
      ),
    ).toBe('<script type="module" data-x="a b" async>go();</script>');
  });

  it("a self-closing script with src", async () => {
    expect(await render('<html-script async src="/a.js"/>')).toBe(
      '<script async src="/a.js"></script>',
    );
  });

  it("a nonce the author gives is kept, none is invented", async () => {
    expect(
      await render(
        "<html-script nonce=n>go();</html-script>",
        'const n = "k1";',
      ),
    ).toBe('<script nonce="k1">go();</script>');
    expect(await render("<html-script>go();</html-script>")).toBe(
      "<script>go();</script>",
    );
  });

  it("a spread contributes its attributes", async () => {
    expect(
      await render(
        "<html-script ...a>go();</html-script>",
        'const a = { type: "module", "data-k": "v" };',
      ),
    ).toBe('<script type="module" data-k="v">go();</script>');
  });

  it("a placeholder is stringified, not HTML-escaped", async () => {
    expect(
      await render(
        "<html-script>if (a && b) { v = ${x}; }</html-script>",
        "const x = `a<b&c\"d'e>`;",
      ),
    ).toBe(`<script>if (a && b) { v = a<b&c"d'e>; }</script>`);
  });

  it("a `</script>` in a placeholder cannot close the element", async () => {
    const html = await render(
      "<html-script>${s}</html-script>",
      'const s = "</SCRIPT> <!-- <script>";',
    );
    expect(html).toBe(
      "<script>\\u003C/SCRIPT> \\u003C!-- \\u003Cscript></script>",
    );
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it.each([
    ["false", ""],
    ["null", ""],
    ["0", "0"],
    ["true", "true"],
  ])("a placeholder of %s prints as Marko's text does", async (v, text) => {
    expect(
      await render("<html-script>[${v}]</html-script>", `const v = ${v};`),
    ).toBe(`<script>[${text}]</script>`);
  });

  it("static text keeps its entities and markup characters", async () => {
    expect(
      await render(
        "<html-script>if (a < b && c > d) go('&amp;');</html-script>",
      ),
    ).toBe("<script>if (a < b && c > d) go('&amp;');</script>");
  });
});
