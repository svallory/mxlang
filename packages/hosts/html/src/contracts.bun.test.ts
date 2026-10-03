import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetLookup } from "@mxlang/core";
import { createHtmlBunPlugin } from "./bun.ts";

// Bun.build invokes the real loader's onLoad hook with the registry lookup,
// without depending on global import-module caches or the auto-preload plugin.
test("the Bun loader reports a positioned mx.contracts error and reloads the edited module", async () => {
  // Runtime import avoids a package dependency back to the registry, which
  // itself depends on this host. No host production dependency is added.
  const { builtinLookup } = (await import(
    new URL("../../../target-registry/src/index.ts", import.meta.url).href
  )) as { builtinLookup(): TargetLookup };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-bun-contracts-")));
  const page = join(dir, "page.mx");
  const module = join(dir, "contracts.ts");
  const declaration = (name: string) =>
    `export default { style: { attributes: { ${name}: { type: 'string', required: true } } } };\n`;
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: { host: "html", contracts: "./contracts.ts" },
      }),
    );
    writeFileSync(page, "<style>\n  .x { color: red }\n</style>\n");
    writeFileSync(module, declaration("nonce"));
    const loader = createHtmlBunPlugin(builtinLookup());
    const first = await Bun.build({
      entrypoints: [page],
      plugins: [loader],
      throw: false,
    });
    expect(first.success).toBe(false);
    expect(first.logs).toHaveLength(1);
    expect(first.logs[0]?.message).toBe(
      "`<style>`: missing required attribute `nonce`",
    );
    // Bun's BuildMessage positions are 0-based; core's call is 1:0.
    expect(first.logs[0]?.position).toMatchObject({
      file: page,
      line: 0,
      column: 0,
    });

    writeFileSync(module, declaration("media"));
    const second = await Bun.build({
      entrypoints: [page],
      plugins: [loader],
      throw: false,
    });
    expect(second.success).toBe(false);
    expect(second.logs).toHaveLength(1);
    expect(second.logs[0]?.message).toBe(
      "`<style>`: missing required attribute `media`",
    );
    expect(second.logs[0]?.position).toMatchObject({
      file: page,
      line: 0,
      column: 0,
    });
    // Same process and same caller: Bun reloads ESM/TS after cache eviction.
    // Long-lived Node tools instead need restart (TODO sync-esm-reload-node).
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
