import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import solid from "@solidjs/vite-plugin";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import mx from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "fixtures", "solid-whole-file");
// Inside the package so the bundle's `@solidjs/web` import resolves.
const out = mkdtempSync(join(here, "..", ".whole-file-build-"));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/**
 * A whole-file Solid `.mx` compiles to TSX that carries its `Input` type
 * (`compileSolidUnit`, solid-whole-file-prop-typing). The plugin gives it a
 * `.tsx` id, Solid's compiler passes the types through, and vite strips them.
 * This is a real `vite build` with `mx()` ahead of `@solidjs/vite-plugin`, and
 * the SSR bundle is then executed, so a pipeline that could not parse or strip
 * the type fails here in the package's own suite.
 */
describe("a whole-file Solid .mx with a typed Input, built for real", () => {
  it("builds through mx() + solid() and renders", async () => {
    await build({
      root,
      configFile: false,
      logLevel: "warn",
      plugins: [mx(), solid({ ssr: true })],
      build: {
        ssr: "src/Badge.mx",
        outDir: out,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { entryFileNames: "badge.mjs" } },
      },
    });

    const bundle = readFileSync(join(out, "badge.mjs"), "utf8");
    // Types are erased by the time the bundle is written.
    expect(bundle).not.toContain("interface Input");
    expect(bundle).not.toContain("input: Input");

    const { default: Badge } = (await import(
      pathToFileURL(join(out, "badge.mjs")).href
    )) as { default: (input: { label: string; count?: number }) => unknown };
    const { renderToString } = (await import("@solidjs/web")) as {
      renderToString: (fn: () => unknown) => string;
    };
    // Hydration markers (`<!--$-->`, `_hk`) are not part of what is asserted.
    const html = (input: { label: string; count?: number }) =>
      renderToString(() => Badge(input))
        .replace(/<!--.*?-->/g, "")
        .replace(/ _hk=\d+/g, "");
    expect(html({ label: "hi", count: 2 })).toBe(
      '<span class="badge">hi:2</span>',
    );
    expect(html({ label: "yo" })).toBe('<span class="badge">yo:0</span>');
  }, 60_000);
});
