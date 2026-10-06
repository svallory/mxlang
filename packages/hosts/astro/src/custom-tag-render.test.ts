// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX content syntax
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@mxlang/html";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";
import renderer from "./server.ts";

/**
 * A discovered custom tag (`tags/badge.mx`) called from an `.astro.mx` page,
 * rendered through Astro's real compiler (`@astrojs/compiler-rs`, what Astro 7
 * builds with) and container. Astro treats a tag whose name does not start with
 * an upper-case letter as an HTML element, so a `$`-led binding shipped the
 * literal `<$mx_Badge1 />` with no diagnostic; asserting the rendered HTML, not
 * the lowered text, is what catches that.
 */
const dir = mkdtempSync(join(tmpdir(), "mx-astro-custom-tag-"));
const require = createRequire(import.meta.url);
const astroRequire = createRequire(
  realpathSync(require.resolve("astro/package.json")),
);
let compiler: {
  transform(
    source: string,
    options: { filename: string },
  ): Promise<{ code: string; diagnostics?: unknown[] }>;
};
let container: AstroContainer;

const BADGE = [
  "export interface Input { label: string }",
  "<b>badge:${input.label}</b>",
  "",
].join("\n");

const badge = {
  template: {
    filename: join(dir, "tags", "badge.mx"),
    source: BADGE,
  },
} as never;

// compiler-rs emits metadata consumed by Vite, not the container's runtime.
function containerModule(code: string) {
  return code
    .replace(", createMetadata as $$createMetadata", "")
    .replace(
      /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
      "",
    );
}

let pageId = 0;
async function render(source: string): Promise<string> {
  const lowered = lowerAstroMx(source, join(dir, "page.astro.mx"), {
    customTags: { badge },
  }).code.replaceAll("/badge.mx", "/badge.ts");
  const compiled = await compiler.transform(lowered, {
    filename: join(dir, "page.astro"),
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
  const moduleFile = join(dir, `page${++pageId}.mjs`);
  writeFileSync(moduleFile, containerModule(compiled.code));
  const component = (
    await import(/* @vite-ignore */ pathToFileURL(moduleFile).href)
  ).default;
  return container.renderToString(component);
}

beforeAll(async () => {
  symlinkSync(
    join(dirname(require.resolve("../package.json")), "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "tags"));
  writeFileSync(
    join(dir, "tags", "badge.ts"),
    compile(BADGE, join(dir, "tags", "badge.mx"), { strict: true }).code,
  );
  compiler = await import(
    pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href
  );
  container = await AstroContainer.create();
  container.addServerRenderer({ name: "@mxlang/astro", renderer });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a discovered custom tag called from .astro.mx, rendered on Astro", () => {
  it("renders the tag's markup, not a literal element", async () => {
    const html = await render('---\n---\n<div><badge label="a"/></div>');
    expect(html).toBe("<div><b>badge:a</b></div>");
  });

  it("renders every call of the same tag and of two tags", async () => {
    const html = await render(
      '---\n---\n<badge label="a"/><p><badge label="b"/></p>',
    );
    expect(html).toBe("<b>badge:a</b><p><b>badge:b</b></p>");
  });

  it("does not collide with an author binding named like the renamed tag", async () => {
    const html = await render(
      '---\nconst Mx_Badge1 = "mine";\n---\n<p>${Mx_Badge1}</p><badge label="a"/>',
    );
    expect(html).toBe("<p>mine</p><b>badge:a</b>");
  });

  it("emits an upper-case-led component name", () => {
    const { code } = lowerAstroMx(
      '---\n---\n<badge label="a"/>',
      join(dir, "page.astro.mx"),
      { customTags: { badge } },
    );
    expect(code).not.toContain("$mx_");
    expect(code).toMatch(
      /^import [A-Z]\w*Badge\d* from "\.\/tags\/badge\.mx"/m,
    );
  });
});
