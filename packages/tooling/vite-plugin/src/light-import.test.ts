import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as core from "@mxlang/core";
import { expect, it } from "vitest";

it("shares core state with native lazy descriptor requires", () => {
  const native = createRequire(import.meta.url)("@mxlang/core") as typeof core;
  expect(core.withCalleeInputSources).toBe(native.withCalleeInputSources);
});

// The probe counts the Marko compiler (core's bundled one included), Astro's,
// and the Babel core lowers and prints with (`@babel/core`, `generator`,
// `traverse`): since decision 197 slice S3a a compile loads no Marko
// compiler, so Babel is what shows the `.mx` transform ran.
it("keeps config evaluation and reader registration compiler-lazy", () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(entry)});
    const { default: mx } = await import(${JSON.stringify(entry)});
    const plugin = mx();
    const compilers = () => Object.keys(require.cache).filter((key) =>
      /node_modules\\/(\\.bun\\/)?(@marko[+/]compiler|@astrojs[+/]compiler|@babel[+/](core|generator|traverse)[@/])|\\/marko-frontend\\.cjs$/.test(key));
    const before = compilers();
    await plugin.buildStart.call({});
    const registered = compilers();
    const dir = mkdtempSync(join(tmpdir(), "mx-vite-light-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"mx":{"target":"html"}}');
      await plugin.transform.call({}, "<p/>\\n", join(dir, "page.mx.tsx"));
      console.log(JSON.stringify({ before, registered, compiled: compilers().length > 0 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    before: [],
    registered: [],
    compiled: true,
  });
});
