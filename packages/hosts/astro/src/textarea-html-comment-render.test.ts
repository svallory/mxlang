import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * `<textarea value>` and `<html-comment>` on Astro, by RENDERING through
 * Astro's own compiler and container. Every expectation is what Marko 6.3.51
 * renders (measured with a real `@marko/compiler` + `marko/translator` render;
 * `packages/oracle/src/textarea-value.test.ts` compares the textarea table
 * against a live Marko render too).
 */
const dir = mkdtempSync(join(tmpdir(), "mx-astro-textarea-comment-"));
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

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** The textarea as a parser reads it: its attributes and its text (first newline dropped). */
function textarea(html: string): { attrs: string; text: string } {
  const match = /<textarea([^>]*)>([\s\S]*?)<\/textarea>/.exec(html);
  if (!match) throw new Error(`no textarea in ${html}`);
  const text = decode(match[2] as string);
  return {
    attrs: (match[1] as string).trim(),
    text: text.startsWith("\n") ? text.slice(1) : text,
  };
}

// The Marko table for `value=input.v` (the cells of `textarea-value.test.ts`):
// `0` and a string render as content, nullish/boolean as nothing, a leading
// newline is doubled by Marko so the parser's dropped newline restores it.
const VALUES: Array<[string, string, string]> = [
  ["0", "0", "0"],
  ['""', '""', ""],
  ["null", "null", ""],
  ["undefined", "undefined", ""],
  ["false", "false", ""],
  ["true", "true", ""],
  ['"hello"', '"hello"', "hello"],
  ["special", String.raw`"a<b>&\"'c"`, "a<b>&\"'c"],
  ["newline", String.raw`"\nx"`, "\nx"],
  ["newlines", String.raw`"\n\nx"`, "\n\nx"],
];

describe("<textarea value> (astro, rendered)", () => {
  it.each(VALUES)(
    "value=v (%s) renders content %j",
    async (_label, literal, text) => {
      const html = await render("<textarea value=v/>", `const v = ${literal};`);
      expect(textarea(html)).toEqual({ attrs: "", text });
    },
  );

  it("keeps the other attributes and never emits a value attribute", async () => {
    const html = await render(
      '<textarea value=v class="c" name="n"/>',
      'const v = "hello";',
    );
    expect(textarea(html)).toEqual({
      attrs: 'class="c" name="n"',
      text: "hello",
    });
    expect(html).not.toContain("value=");
  });

  it("renders a static value as content", async () => {
    const html = await render('<textarea value="a &amp; b <c>"/>');
    expect(textarea(html).text).toBe("a &amp; b <c>"); // an attribute string is not entity-decoded
    expect(html).not.toContain("value=");
  });

  it("renders a spread's value as content", async () => {
    for (const [literal, text] of [
      ["0", "0"],
      ["null", ""],
      ['"hello"', "hello"],
      [String.raw`"\nx"`, "\nx"],
    ] as const) {
      const html = await render(
        "<textarea ...a/>",
        `const a = { value: ${literal}, title: "t" };`,
      );
      expect(textarea(html), literal).toEqual({ attrs: 'title="t"', text });
    }
  });

  it("the later of an explicit value and a spread's wins", async () => {
    const declarations = 'const v = "explicit"; const a = { value: "spread" };';
    expect(
      textarea(await render("<textarea ...a value=v/>", declarations)).text,
    ).toBe("explicit");
    expect(
      textarea(await render("<textarea value=v ...a/>", declarations)).text,
    ).toBe("spread");
    expect(
      textarea(
        await render(
          '<textarea ...{value:"a"} value=v ...{title:"t"}/>',
          declarations,
        ),
      ),
    ).toEqual({ attrs: 'title="t"', text: "explicit" });
  });

  it("a spread's value yields to the body", async () => {
    const html = await render(
      "<textarea ...a>body</textarea>",
      'const a = { value: "spread", title: "t" };',
    );
    expect(textarea(html)).toEqual({ attrs: 'title="t"', text: "body" });
  });

  it("renders a body as raw text, `<` included", async () => {
    const html = await render("<textarea>hi &amp; <b></textarea>");
    expect(textarea(html).text).toBe("hi & <b>");
  });

  it("refuses a value together with a body, as Marko does", () => {
    expect(() =>
      lowerAstroMx(
        "---\nconst v = 1;\n---\n<textarea value=v>body</textarea>",
        join(dir, "both.astro.mx"),
      ),
    ).toThrow(
      "A textarea cannot have both a value attribute and body content.",
    );
  });
});

describe("<html-comment> (astro, rendered)", () => {
  // Marko 6.3.51: text and placeholders only; `>` is the one escaped
  // character (`_escape_comment`); falsy renders nothing except `0`.
  it("renders a static comment", async () => {
    expect(await render("<html-comment>hi</html-comment>")).toBe("<!--hi-->");
  });

  it("renders an empty comment", async () => {
    expect(await render("<html-comment></html-comment>")).toBe("<!---->");
  });

  it("escapes only `>` in static text", async () => {
    expect(await render("<html-comment>x --> y &amp; z</html-comment>")).toBe(
      "<!--x --&gt; y &amp; z-->",
    );
  });

  it("interpolates and escapes `>` in the value", async () => {
    expect(
      await render(
        "<html-comment>a ${v} b</html-comment>",
        String.raw`const v = "a-->b<c>&\"'";`,
      ),
    ).toBe(`<!--a a--&gt;b<c&gt;&"' b-->`);
  });

  it.each([
    ["undefined", "a  b"],
    ["null", "a  b"],
    ["false", "a  b"],
    ['""', "a  b"],
    ["0", "a 0 b"],
    ["true", "a true b"],
  ])("interpolates %s as Marko does", async (literal, text) => {
    expect(
      await render(
        "<html-comment>a ${v} b</html-comment>",
        `const v = ${literal};`,
      ),
    ).toBe(`<!--${text}-->`);
  });

  it("writes a comment of only empty placeholders as `<!-- -->`", async () => {
    expect(
      await render(
        "<html-comment>${v}${w}</html-comment>",
        "const v = null; const w = false;",
      ),
    ).toBe("<!-- -->");
    expect(
      await render(
        "<html-comment>${v}${w}</html-comment>",
        'const v = "v"; const w = 0;',
      ),
    ).toBe("<!--v0-->");
  });

  it("leaves an unescaped placeholder's `>` alone", async () => {
    expect(
      await render("<html-comment>$!{v}</html-comment>", 'const v = "a>b";'),
    ).toBe("<!--a>b-->");
  });

  it("refuses a value that would render as [object Object], as Marko does", async () => {
    await expect(
      render("<html-comment>${v}</html-comment>", "const v = {};"),
    ).rejects.toThrow(
      "Text content cannot be a plain object (it would render as `[object Object]`).",
    );
  });

  it("renders markup in the body as text, as Marko does", async () => {
    // Stock Marko renders `<!--<b&gt;x</b&gt;-->` (measured through
    // packages/stock-marko): the body is parsed-text, so tags inside are text.
    expect(await render("<html-comment><b>x</b></html-comment>")).toBe(
      "<!--<b&gt;x</b&gt;-->",
    );
  });

  it("keeps a nested comment as text with its `>` escaped, as Marko does", async () => {
    expect(await render("<html-comment>a<!-- b -->c</html-comment>")).toBe(
      "<!--a<!-- b --&gt;c-->",
    );
  });

  it("keeps the whitespace beside a nested comment, as Marko does", async () => {
    expect(await render("<html-comment>a <!-- b --> c</html-comment>")).toBe(
      "<!--a <!-- b --&gt; c-->",
    );
  });

  it("is not a literal element", async () => {
    expect(await render("<html-comment>hi</html-comment>")).not.toContain(
      "html-comment>",
    );
  });
});
