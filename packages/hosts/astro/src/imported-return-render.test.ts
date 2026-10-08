// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX content syntax
import {
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
 * An imported `.mx` tag that declares `<return>`, called without `/var` from
 * an `.astro.mx` page, rendered through Astro's real compiler and container
 * with the MX server renderer. Astro, not the call site, invokes the callee,
 * so the renderer is what drops the value and keeps the markup. Marko 6.3.51
 * renders the body and drops the value.
 */
const dir = mkdtempSync(join(tmpdir(), "mx-astro-imported-return-"));
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

const COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span>",
  "<return value=input.start + 1/>",
  "",
].join("\n");

// compiler-rs emits metadata consumed by Vite, not the container's runtime.
function containerModule(code: string) {
  return code
    .replace(", createMetadata as $$createMetadata", "")
    .replace(
      /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
      "",
    );
}

beforeAll(async () => {
  symlinkSync(
    join(dirname(require.resolve("../package.json")), "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "counter.mx"), COUNTER);
  writeFileSync(
    join(dir, "counter.ts"),
    compile(COUNTER, join(dir, "counter.mx"), { strict: true }).code,
  );
  compiler = await import(
    pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href
  );
  container = await AstroContainer.create();
  container.addServerRenderer({ name: "@mxlang/astro", renderer });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("an imported tag that declares <return>, rendered on Astro", () => {
  it("renders its body and drops the value without /var", async () => {
    const lowered = lowerAstroMx(
      '---\nimport Counter from "./counter.mx";\n---\n<div><Counter start=1/></div>',
      join(dir, "page.astro.mx"),
    ).code.replace('"./counter.mx"', '"./counter.ts"');
    const compiled = await compiler.transform(lowered, {
      filename: join(dir, "page.astro"),
    });
    expect(compiled.diagnostics ?? []).toEqual([]);
    const moduleFile = join(dir, "page.mjs");
    writeFileSync(moduleFile, containerModule(compiled.code));
    const component = (
      await import(/* @vite-ignore */ pathToFileURL(moduleFile).href)
    ).default;
    expect(await container.renderToString(component)).toBe(
      "<div><span>1</span></div>",
    );
  });

  // Astro's fence imports reach core as plain bindings with no specifier, so
  // core cannot read the callee's `<return>` and keeps refusing `/var` here
  // with its generic message; `.astro.mx` cannot bind one either way (the
  // fence runs before the template).
  it("still refuses /var on the imported call, positioned", () => {
    let error: (Error & { line?: number; column?: number }) | undefined;
    try {
      lowerAstroMx(
        '---\nimport Counter from "./counter.mx";\n---\n<Counter/n start=1/><p>{n}</p>',
        join(dir, "page.astro.mx"),
      );
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(
      /tag variable `\/n` on `<Counter>` is not supported/,
    );
    // At the `/n` itself, not the tag (core's dynamic-tag-var-silent-drop
    // position change: `rejectUnsupportedFields` reports at `node.var`).
    expect({ line: error?.line, column: error?.column }).toEqual({
      line: 4,
      column: 9,
    });
  });
});
