import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as core from "@mxlang/core";
import { expect, it } from "vitest";

it("shares core state with native lazy descriptor requires", () => {
  const native = createRequire(import.meta.url)("@mxlang/core") as typeof core;
  expect(core.withCalleeInputSources).toBe(native.withCalleeInputSources);
});

it("keeps config evaluation and reader registration compiler-lazy", () => {
  const entry = new URL("./index.ts", import.meta.url).pathname;
  const script = `
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { default: mx } = await import(${JSON.stringify(entry)});
    const plugin = mx();
    const compilers = () => Object.keys(require.cache).filter((key) =>
      /node_modules\\/(\\.bun\\/)?(@marko[+/]compiler|@astrojs[+/]compiler)/.test(key));
    const before = compilers();
    const registryBefore = Object.keys(require.cache).filter((key) => key.includes("/target-registry/"));
    await plugin.buildStart.call({});
    const registered = compilers();
    const dir = mkdtempSync(join(tmpdir(), "mx-vite-light-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"mx":{"target":"html"}}');
      await plugin.transform.call({}, "<p/>\\n", join(dir, "page.mx.tsx"));
      console.log(JSON.stringify({ before, registryBefore, registered, compiled: compilers().length > 0 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `;
  const result = spawnSync("bun", ["-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    before: [],
    registryBefore: [],
    registered: [],
    compiled: true,
  });
});
