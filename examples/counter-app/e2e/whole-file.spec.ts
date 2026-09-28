import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mx from "@mxlang/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(root, ".whole-file-"));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/**
 * A whole-file Solid `.mx` compiles to TSX carrying its `Input` type
 * (`compileSolidUnit`, solid-whole-file-prop-typing). The vite plugin gives it
 * a `.tsx` id, Solid's compiler passes the types through, and vite strips them.
 * This builds and renders it for real, so a pipeline that could not parse or
 * strip the type would fail here.
 */
describe("whole-file Solid .mx with a typed Input", () => {
  it("builds through mx() + solid() and renders", async () => {
    // The example's own plugin order (`mx()` ahead of `solid()`), with
    // `ssr: true` so Solid's server transform runs and the bundle can be
    // rendered to a string in Node.
    await build({
      root,
      configFile: false,
      plugins: [mx(), solid({ ssr: true })],
      logLevel: "warn",
      build: {
        ssr: "src/Badge.mx",
        outDir: out,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { entryFileNames: "badge.mjs" } },
      },
    });

    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(join(out, "badge.mjs"), "utf8"),
    );
    // Types are erased by the time the bundle is written.
    expect(source).not.toContain("interface Input");
    expect(source).not.toContain("input: Input");

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
  });
});
