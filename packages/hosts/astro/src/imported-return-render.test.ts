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
import type { Ir } from "@mxlang/core";
import { compile } from "@mxlang/target-html";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitTemplate, lowerAstroMx } from "./astro-template.ts";
import renderer from "./server.ts";

/**
 * An imported `.mx` tag that declares `<return>`, called without `/var` from
 * an `.astro.mx` page, rendered through Astro's real compiler and container
 * with the MX server renderer. Astro, not the call site, invokes the callee,
 * so the renderer is what drops the value and keeps the markup. Marko 6.4.4
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
  container.addServerRenderer({ name: "@mxlang/host-astro", renderer });
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

  // A fence default import of a `.mx` file reaches core, which reads the
  // callee's `<return>`; the Astro host then refuses `/var` with its own
  // message, since `.astro.mx` cannot bind one (the fence runs before the
  // template). It points at the `/n` binding (line 4, column 9), not at
  // the tag.
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
    expect(error?.message).toBe(
      '`/var` on `<Counter>` can\'t bind in `.astro.mx`: Astro runs the `---` fence before the template renders, so no statement can receive the value here. Call the unit directly from the fence instead, e.g. `import Counter from "./Counter.mx"; import { createOut } from "@mxlang/host-astro/runtime"; const value = Counter.render({ ... }, createOut());`, and use `value` in the template.',
    );
    expect({ line: error?.line, column: error?.column }).toEqual({
      line: 4,
      column: 9,
    });
  });

  // `emitTemplate(ir)` has no source to resolve the binding's offset against,
  // so the same refusal keeps the tag's own position.
  it("positions the /var refusal at the tag without a source", () => {
    const call = {
      kind: "Component",
      target: { kind: "name", name: "Counter" },
      nameSpan: null,
      attrs: [],
      content: null,
      attributeTags: [],
      attributeTagTree: [],
      args: [],
      var: "n",
      varBindings: [{ name: "n", span: { sourceStart: 50, sourceEnd: 51 } }],
      returnsValue: true,
      loc: { line: 4, column: 0 },
    } as unknown as Ir["body"][number];
    let error: (Error & { line?: number; column?: number }) | undefined;
    try {
      emitTemplate({ body: [call] } as unknown as Ir);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(/^`\/var` on `<Counter>` can't bind/);
    expect({ line: error?.line, column: error?.column }).toEqual({
      line: 4,
      column: 0,
    });
  });
});
