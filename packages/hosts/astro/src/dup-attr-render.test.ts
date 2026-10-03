import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * Decision 135 on Astro, by RENDERING. Core drops the earlier occurrence of a
 * repeated name; whether `{...x}` next to the survivor still lets a browser see
 * the spread's value depends on how Astro renders the tag, so the output is
 * rendered with Astro's own compiler and container and read the way a browser
 * reads it (the first duplicate wins).
 */
const dir = mkdtempSync(join(tmpdir(), "mx-astro-dup-attr-"));
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
  const echo = await compiler.transform(
    "<pre>{JSON.stringify(Astro.props)}</pre>",
    { filename: join(dir, "Echo.astro") },
  );
  writeFileSync(join(dir, "Echo.mjs"), containerModule(echo.code));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let serial = 0;

/** Renders `template` with `x` and `y` in scope; returns the first tag's attributes as a browser keeps them. */
async function render(template: string) {
  const name = `case${serial++}`;
  const source = `---
import Echo from "./Echo.mjs";
const x = { a: "from-x", b: "bx", id: "x-id", class: "from-x" };
const y = { a: "from-y", b: "by", c: "cy" };
---
${template}`;
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
  const html = await container.renderToString(component);
  const tag = /<[a-z]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/.exec(html);
  if (!tag) throw new Error(`no open tag in ${html}`);
  const names: string[] = [];
  const kept: Record<string, string> = {};
  for (const m of (tag[1] ?? "").matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) {
    const attr = m[1] as string;
    names.push(attr);
    if (!(attr in kept)) kept[attr] = m[2] ?? "";
  }
  return { html, names, kept };
}

describe("duplicate attributes next to a spread (astro, rendered)", () => {
  it("a later explicit attribute beats the spread", async () => {
    const out = await render("<div a=1 ...x a=2>hi</div>");
    expect(out.kept.a).toBe("2");
    expect(out.names.filter((n) => n === "a")).toHaveLength(1);
  });

  it("the last explicit attribute beats every spread", async () => {
    const out = await render("<div ...x a=1 ...y a=2>hi</div>");
    expect(out.kept.a).toBe("2");
    expect(out.kept.b).toBe("by");
    expect(out.names.filter((n) => n === "a")).toHaveLength(1);
  });

  it("a spread after an explicit attribute wins", async () => {
    const out = await render("<div a=1 ...x>hi</div>");
    expect(out.kept.a).toBe("from-x");
    expect(out.names.filter((n) => n === "a")).toHaveLength(1);
  });

  it("class comes from the spread when it follows, from the attribute when it does not", async () => {
    expect((await render('<div class="a" ...x>hi</div>')).kept.class).toBe(
      "from-x",
    );
    expect((await render('<div ...x class="a">hi</div>')).kept.class).toBe("a");
  });

  it("a component call receives the last value, as its props are one object", async () => {
    const { html } = await render("<Echo a=1 ...x a=2/>");
    const text = (/<pre>(.*)<\/pre>/s.exec(html)?.[1] ?? "").replace(
      /&(#34|quot);/g,
      '"',
    );
    expect(JSON.parse(text).a).toBe(2);
  });
});
