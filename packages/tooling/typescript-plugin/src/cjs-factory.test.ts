import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { makePluginInstall } from "./fixtures/plugin-install.ts";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PACKAGE_DIR, "dist");

// Only meaningful once `bun run build` has run (`bun run verify` builds before
// it tests); skipped rather than failed in a bare `vitest run` of this package.
const built = existsSync(path.join(DIST, "index.cjs"));

// tsserver's `Project.enableProxy` calls `ts.sys.require` and only proceeds when
// the module it gets back is a function; it never unwraps `.default`. An
// object-shaped CJS export makes it log "did not expose a proper factory
// function" and skip the plugin, so no tsserver editor ever loaded it.
describe.skipIf(!built)("the built CJS entry, as tsserver loads it", () => {
  const install = built ? makePluginInstall() : "";
  afterAll(() => {
    if (install) rmSync(install, { recursive: true, force: true });
  });

  const load = () => {
    const loaded = (ts.sys as ts.server.ServerHost).require?.(
      path.join(install, "node_modules"),
      "@mxlang/typescript-plugin",
    );
    if (!loaded || loaded.error) {
      throw new Error(`load failed: ${loaded?.error?.message}`);
    }
    return loaded.module as Record<string, unknown>;
  };

  it("is a factory function that returns a plugin module with `create`", () => {
    const loaded = load();
    expect(typeof loaded).toBe("function");
    const plugin = (loaded as unknown as (modules: unknown) => unknown)({
      typescript: ts,
    });
    expect(typeof (plugin as { create?: unknown }).create).toBe("function");
  });

  it("keeps `default` and every named export (additive)", () => {
    const loaded = load();
    const cjs = createRequire(import.meta.url)(path.join(DIST, "index.cjs"));
    expect(loaded.default).toBe(loaded);
    for (const name of [
      "composeAmxMappings",
      "createAmxLanguagePlugin",
      "createAstroLanguagePlugin",
      "createAstroTypeSurface",
      "createCompoundExtensionResolver",
      "createConfiguredLanguagePlugins",
      "createHtmlMappings",
      "createMxLanguagePlugin",
      "createNgMxLanguagePlugin",
      "createSolidMxLanguagePlugin",
    ]) {
      expect(typeof loaded[name], name).toBe("function");
      expect(cjs[name], name).toBe(loaded[name]);
    }
  });
});
