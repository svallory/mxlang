import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-astro-conditional-slots-"));
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

/**
 * compiler-rs 0.4 emits build metadata that Astro 7's public runtime does not
 * export yet. Astro's Vite build consumes that metadata separately; the
 * container needs only the component factory, so remove the unrelated export
 * from these directly imported probe modules.
 */
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

  const filename = join(dir, "Card.astro");
  const result = await compiler.transform(
    '<section><slot name="header">fallback</slot></section>',
    { filename },
  );
  expect(result.diagnostics ?? []).toEqual([]);
  writeFileSync(join(dir, "Card.mjs"), containerModule(result.code));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function renderConditional(
  name: string,
  declarations: string,
  template: string,
): Promise<string> {
  const amxFile = join(dir, `${name}.amx`);
  const source = `---
import Card from "./Card.mjs";
${declarations}
---
${template}`;
  const lowered = lowerAstroMx(source, amxFile).code;
  const result = await compiler.transform(lowered, {
    filename: join(dir, `${name}.astro`),
  });
  expect(result.diagnostics ?? []).toEqual([]);

  const moduleFile = join(dir, `${name}.mjs`);
  writeFileSync(moduleFile, containerModule(result.code));
  const component = (
    (await import(
      /* @vite-ignore */ `${pathToFileURL(moduleFile).href}?case=${name}`
    )) as { default: Parameters<AstroContainer["renderToString"]>[0] }
  ).default;
  return container.renderToString(component);
}

async function renderPlain(name: string, template: string): Promise<string> {
  const amxFile = join(dir, `${name}.amx`);
  const lowered = lowerAstroMx(`---\n---\n${template}`, amxFile).code;
  const result = await compiler.transform(lowered, {
    filename: join(dir, `${name}.astro`),
  });
  expect(result.diagnostics ?? []).toEqual([]);

  const moduleFile = join(dir, `${name}.mjs`);
  writeFileSync(moduleFile, containerModule(result.code));
  const component = (
    (await import(
      /* @vite-ignore */ `${pathToFileURL(moduleFile).href}?case=${name}`
    )) as { default: Parameters<AstroContainer["renderToString"]>[0] }
  ).default;
  return container.renderToString(component);
}

describe("<for> with a nullish of=/in=", () => {
  it("renders nothing, matching Marko, rather than throwing", async () => {
    const html = await renderPlain(
      "for-nullish",
      "<for|x| of=undefined><b>${x}</b></for><for|k, v| in=null><b>${k}</b></for>",
    );
    expect(html).not.toContain("<b>");
  });
});

describe("conditional Astro named slots", () => {
  it("renders only the taken simple branch", async () => {
    const html = await renderConditional(
      "simple",
      "const takeFirst = true;",
      "<Card><if=takeFirst><@header><b>simple-taken</b></@header></if><else><@header><b>simple-not-taken</b></@header></else></Card>",
    );
    expect(html).toContain("simple-taken");
    expect(html).not.toContain("simple-not-taken");
  });

  it("renders a taken nested branch", async () => {
    const html = await renderConditional(
      "nested",
      "const outer = true; const inner = true;",
      "<Card><if=outer><if=inner><@header><b>nested-taken</b></@header></if></if></Card>",
    );
    expect(html).toContain("nested-taken");
    expect(html).not.toContain("fallback");
  });

  it("renders an if nested inside the taken else branch", async () => {
    const html = await renderConditional(
      "else-nested",
      "const first = false; const second = true;",
      "<Card><if=first><@header><b>else-not-taken</b></@header></if><else><if=second><@header><b>else-taken</b></@header></if></else></Card>",
    );
    expect(html).toContain("else-taken");
    expect(html).not.toContain("else-not-taken");
  });
});
