import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "astro";
import { describe, expect, it } from "vitest";
import mxAstro from "./index.ts";

describe("extensions guard", () => {
  it("throws a clear error if extensions includes .marko", () => {
    // MX only supports the MX 1.0 subset of Marko syntax, so a caller
    // cannot opt back into `.marko` through `extensions`.
    expect(() => mxAstro({ extensions: [".mx", ".marko"] })).toThrow(
      /'\.marko' is not a supported extension/,
    );
  });
});

describe("addPageExtension guard", () => {
  it("registers .mx, and never .astro.mx, as a page extension", () => {
    const integration = mxAstro();
    const setupHook = integration.hooks["astro:config:setup"]!;

    const extensions: string[] = [];
    const addPageExtension = (...exts: (string | string[])[]) => {
      extensions.push(...exts.flat());
    };

    setupHook({
      config: { srcDir: new URL("file:///src/") },
      addRenderer: () => {},
      addPageExtension,
      updateConfig: () => {},
    });

    expect(extensions).toContain(".mx");
    // Astro strips only the last extension, so a page `.astro.mx` would route
    // to `/page.astro` (decision 134 addendum): it is an error, not a page.
    expect(extensions).not.toContain(".astro.mx");
  });

  it("registers the resolver that finds @mxlang/html for compiled modules", () => {
    let config: { vite?: { plugins?: Array<{ name: string }> } } = {};
    mxAstro().hooks["astro:config:setup"]!({
      config: { srcDir: new URL("file:///src/") },
      addRenderer: () => {},
      addPageExtension: () => {},
      updateConfig: (c) => {
        config = c as typeof config;
      },
    });

    expect(config.vite?.plugins?.map((p) => p.name)).toContain(
      "mx-astro-html-resolve",
    );
  });

  it("errors on every .astro.mx file under the pages directory, and still accepts .mx pages", () => {
    const root = mkdtempSync(join(tmpdir(), "mx-astro-integration-pages-"));
    try {
      const srcDir = pathToFileURL(join(root, "src") + "/");
      const write = (file: string) => {
        const path = join(root, "src", file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "---\n---\n<p/>\n");
      };
      const run = () =>
        mxAstro().hooks["astro:config:setup"]!({
          config: { srcDir },
          addRenderer: () => {},
          addPageExtension: () => {},
          updateConfig: () => {},
        });

      write("pages/index.mx");
      write("components/Card.astro.mx");
      expect(run).not.toThrow();

      write("pages/about.astro.mx");
      write("pages/blog/post.astro.mx");
      expect(run).toThrowError(
        /about\.astro\.mx:1:1:[\s\S]*post\.astro\.mx:1:1:/,
      );
      expect(run).toThrowError(/routes it to \/about\.astro, not \/about/);
      expect(run).toThrowError(/import the `\.astro\.mx` component from it/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a clear error if addPageExtension is missing", () => {
    const integration = mxAstro();
    const setupHook = integration.hooks["astro:config:setup"]!;

    expect(() => {
      setupHook({
        config: { srcDir: new URL("file:///src/") },
        addRenderer: () => {},
        addPageExtension: undefined,
        updateConfig: () => {},
      });
    }).toThrowError(/Astro .* does not provide the 'addPageExtension' hook/);
  });
});

describe("real Astro hooks integration", () => {
  it("exposes addPageExtension on the real setup hook params", async () => {
    let addPageExtensionType = "missing";

    const testIntegration = {
      name: "test-integration",
      hooks: {
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic hook presence
        "astro:config:setup": (options: any) => {
          addPageExtensionType = typeof options.addPageExtension;
        },
      },
    };

    // run a real but minimal Astro build to invoke the hook.
    // Astro build needs a root directory
    try {
      await build({
        root: fileURLToPath(
          new URL("../../../examples/astro-static", import.meta.url),
        ),
        integrations: [testIntegration],
        logLevel: "silent", // avoid polluting test output
      });
    } catch (_e) {
      // Astro build might fail if we run it like this, but the hook should have fired.
      // If we don't want to rely on examples/astro-static, we can just do a very minimal build.
    }

    expect(addPageExtensionType).toBe("function");
  });
});
