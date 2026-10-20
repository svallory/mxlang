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

/**
 * Installs a fake html descriptor whose compile records its options, and
 * returns the recorder plus a restore. `strict` chooses the descriptor's
 * own strictness so the "none" case is pinned without depending on the
 * built-in html descriptor.
 */
function fakeDescriptor(strict?: "always") {
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
    ...(strict ? { strict } : {}),
    mappings: "merge-recorded",
    load,
  };
  const lookup = builtinLookup();
  const original = lookup.target;
  vi.spyOn(lookup, "target").mockImplementation((name) =>
    name === "html" ? fake : original(name),
  );
  return { compileModule, load, restore: () => vi.restoreAllMocks() };
}

async function transform(target: string, strict?: boolean, mxExtra?: object) {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-dispatch-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { target, ...mxExtra } }),
  );
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
  it("compiles strict when the descriptor declares strict: always", async () => {
    const { compileModule, load } = fakeDescriptor("always");
    await transform("html");
    expect(load).toHaveBeenCalledWith(core);
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({
        strict: true,
        targets: builtinLookup(),
        resolveImport: expect.any(Function),
      }),
    );
    expect(compileModule.mock.calls[0]?.[2]).not.toHaveProperty("typeCheck");
  });

  it("compiles strict when the file's package.json sets mx.strict", async () => {
    const { compileModule } = fakeDescriptor();
    await transform("html", undefined, { strict: true });
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({ strict: true }),
    );
  });

  it("compiles strict when the caller passes options.strict", async () => {
    const { compileModule } = fakeDescriptor();
    await transform("html", true);
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({ strict: true }),
    );
  });

  it("compiles non-strict when neither descriptor, policy nor options ask for it", async () => {
    const { compileModule } = fakeDescriptor();
    await transform("html");
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({ strict: false }),
    );
  });

  it("an explicit strict: false does not turn off policy strictness", async () => {
    const { compileModule } = fakeDescriptor();
    await transform("html", false, { strict: true });
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({ strict: true }),
    );
  });

  it("an explicit strict: false does not turn off descriptor strictness (astro)", async () => {
    const { compileModule } = fakeDescriptor("always");
    await transform("html", false);
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({ strict: true }),
    );
  });

  it("refuses Angular pages with exact, uncoloured Angular build guidance", async () => {
    await expect(transform("angular-template")).rejects.toMatchObject({
      message:
        "Pages for the angular host cannot be imported by @mxlang/vite-plugin: Pages compile to template strings, not modules. Run `mx-angular build` before `ng build`, or `mx-angular watch` next to `ng serve`.",
    });
  });

  it("reports `tree` as an unknown target through the policy wrapper", async () => {
    expect(builtinLookup().target("tree")).toBeUndefined();
    await expect(transform("tree")).rejects.toThrow(
      'unknown mx.target "tree"; valid targets: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template. Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.',
    );
  });
});
