import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAstroLanguagePlugin } from "./astro-language.ts";

describe("loading Astro's language plugin", () => {
  it("resolves @astrojs/language-server from the project, not the plugin's location", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-astro-peer-"));
    try {
      const pkg = join(dir, "node_modules", "@astrojs", "language-server");
      mkdirSync(join(pkg, "dist", "core"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "@astrojs/language-server", version: "0.0.0" }),
      );
      writeFileSync(
        join(pkg, "dist", "core", "index.js"),
        'module.exports = { getAstroLanguagePlugin: () => ({ marker: "from-project" }) };',
      );

      expect(loadAstroLanguagePlugin(dir)).toEqual({ marker: "from-project" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not hide a project copy that throws on load behind the plugin's own", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-astro-peer-"));
    try {
      const pkg = join(dir, "node_modules", "@astrojs", "language-server");
      mkdirSync(join(pkg, "dist", "core"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "@astrojs/language-server", version: "0.0.0" }),
      );
      writeFileSync(
        join(pkg, "dist", "core", "index.js"),
        'throw new Error("broken project copy");',
      );

      expect(() => loadAstroLanguagePlugin(dir)).toThrowError(
        "broken project copy",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
