import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import { expect, it } from "vitest";
import mx, { MX_SUFFIX } from "./index.ts";

// The plugin uses the registry scan. `style` is an html-delegated name, so
// its module declaration can be contract-only, with no template or transform.
it("reports a positioned mx.contracts error, invalidates the caller, and documents Node ESM reload", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-vite-contracts-")));
  const page = join(dir, "page.mx");
  const module = join(dir, "contracts.ts");
  const source = "<style>\n  .x { color: red }\n</style>\n";
  const declaration = (name: string) =>
    `export default { style: { attributes: { ${name}: { type: 'string', required: true } } } };\n`;
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: { host: "html", contracts: "./contracts.ts" },
      }),
    );
    writeFileSync(module, declaration("nonce"));
    writeFileSync(page, source);
    const plugin = mx() as unknown as {
      transform: (
        this: unknown,
        source: string,
        id: string,
      ) => Promise<unknown>;
      handleHotUpdate: (ctx: unknown) => unknown[] | undefined;
    };
    const error = {
      message: "`<style>`: missing required attribute `nonce`",
      id: page,
      loc: { file: page, line: 1, column: 0 },
    };
    await expect(
      plugin.transform.call({}, source, page + MX_SUFFIX),
    ).rejects.toMatchObject(error);

    // Editing only the module is enough for Vite to invalidate the caller,
    // even when its preceding transform failed with a contract error.
    writeFileSync(module, declaration("media"));
    const invalidated: unknown[] = [];
    const pageModule = { id: page + MX_SUFFIX };
    const modules = plugin.handleHotUpdate({
      file: module,
      modules: [],
      server: {
        moduleGraph: {
          getModuleById: (id: string) =>
            id === pageModule.id ? pageModule : null,
          invalidateModule: (mod: unknown) => invalidated.push(mod),
        },
      },
    });
    expect(invalidated).toEqual([pageModule]);
    expect(modules).toEqual([pageModule]);

    // TODO sync-esm-reload-node: in this long-lived Node/Vitest process,
    // require.cache eviction cannot evict ESM/TS exports. Restart is needed.
    await expect(
      plugin.transform.call({}, source, page + MX_SUFFIX),
    ).rejects.toMatchObject(error);
  } finally {
    clearScanCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
