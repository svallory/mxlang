import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetCompiler, TargetDescriptor } from "@mxlang/core";
import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import { afterEach, describe, expect, it, vi } from "vitest";
import mx, { MX_SUFFIX } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  core.clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function transform(target: string, strict?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-dispatch-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ mx: { target } }));
  const plugin = mx({ strict }) as unknown as {
    transform: (this: unknown, source: string, id: string) => Promise<unknown>;
    configResolved: (config: unknown) => void;
  };
  plugin.configResolved({
    resolve: { alias: [{ find: "@", replacement: "/app" }] },
  });
  return plugin.transform.call({}, "<p/>\n", join(dir, "page.mx") + MX_SUFFIX);
}

describe("target-table Vite dispatch", () => {
  it.each([undefined, false, true])(
    "passes caller strict=%s, core and the full lookup to a fake descriptor without map or mappings",
    async (strict) => {
      const compileModule = vi.fn<TargetCompiler["compileModule"]>(() => ({
        code: "export default 1;",
        dependencies: [],
      }));
      const load = vi.fn(() => ({ compileModule }));
      const fake: TargetDescriptor = {
        descriptorVersion: 0,
        name: "html",
        packageName: "@test/fake",
        defaultTag: "node",
        host: { name: "not-a-built-in-host" },
        strict: "always",
        mappings: "merge-recorded",
        load,
      };
      const lookup = builtinLookup();
      const original = lookup.target;
      vi.spyOn(lookup, "target").mockImplementation((name) =>
        name === "html" ? fake : original(name),
      );
      expect(await transform("html", strict)).toEqual({
        code: "export default 1;",
        map: null,
      });
      expect(load).toHaveBeenCalledWith(core);
      expect(compileModule).toHaveBeenCalledWith(
        "<p/>\n",
        expect.any(String),
        expect.objectContaining({
          strict: strict ?? false,
          targets: lookup,
          resolveImport: expect.any(Function),
        }),
      );
      expect(compileModule.mock.calls[0]?.[2]).not.toHaveProperty("typeCheck");
    },
  );

  it("keeps the absent-load pending text byte-identical", async () => {
    await expect(transform("angular-template")).rejects.toThrow(
      "the angular host is not wired into @mxlang/vite-plugin yet (phase 2)",
    );
  });

  it("reports `tree` as an unknown target through the policy wrapper", async () => {
    expect(builtinLookup().target("tree")).toBeUndefined();
    await expect(transform("tree")).rejects.toThrow(
      'unknown mx.target "tree"; valid targets: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template. Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.',
    );
  });
});
