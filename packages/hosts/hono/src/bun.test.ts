import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import honoPlugin from "./bun.ts";

/**
 * Runs under `bun test`, not vitest: it exercises `Bun.plugin` and Bun's
 * dynamic `import()` of a `.mx` module, both Bun-runtime-only — the same
 * shape as `@mxlang/html`'s own `bun.test.ts`.
 */
describe("@mxlang/hono/bun", () => {
  test("compiles a tag discovered beside the file, with no import", async () => {
    Bun.plugin(honoPlugin);

    // Through the real plugin, so the loader's own `getCustomTags` call is
    // what is under test: deleting it from `bun.ts` must fail this. A test
    // that called `compileHonoMx()` with a tag map it fetched itself would
    // stay green with the loader gutted.
    //
    // Inside the package tree, because the emitted module imports from
    // `hono/jsx` by bare specifier, which Bun resolves from the file's own
    // directory.
    const base = join(import.meta.dirname, "..");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "honostamp.tag.ts");
    const page = join(base, "bun-discovery.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('discovered')])] };\n",
    );
    writeFileSync(page, "<honostamp/>\n");
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => unknown;
      expect(String(render({}))).toContain("discovered");
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("resolves a discovered template tag's injected import", async () => {
    Bun.plugin(honoPlugin);

    // The unit-model path, distinct from the sidecar test above: a *template*
    // tag compiles to its own module and the caller emits an import of it.
    // This asserts the loader resolves that injected import for real —
    // `tags/hicon.mx` has to be found, compiled and imported, or the page
    // module fails to load rather than merely rendering the wrong thing.
    const base = join(import.meta.dirname, "..");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "hicon.mx");
    const page = join(base, "bun-template-page.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template
      '<span class="icon">${input.name}</span>\n',
    );
    writeFileSync(page, '<div><hicon name="star"/></div>\n');
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => unknown;
      const html = String(render({}));
      expect(html).toContain("star");
      expect(html).toContain('class="icon"');
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("does not claim a .solid.mx path", async () => {
    Bun.plugin(honoPlugin);

    // A different file kind (TSX with MX regions), handled by the Vite
    // plugin. Bun's default loader for an unrecognized extension returns the
    // file's own path as the module's default export, which is what "the
    // onLoad hook declined this path" looks like from the caller's side.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-hono-bun-solid-"));
    const path = join(dir, "Counter.solid.mx");
    writeFileSync(
      path,
      "export function Counter() {\n  return <button>Count</button>;\n}\n",
    );

    const mod = await import(path);
    expect(mod.default).toEndWith("Counter.solid.mx");
  });
});
