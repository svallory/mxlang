import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginBuilder } from "bun";
import { expect, it, vi } from "vitest";

it("the own-only Hono Bun loader does not warn about a peer host restriction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-hono-own-hosts-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("Bun", { plugin: () => {} });
  try {
    mkdirSync(join(dir, "extra"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { tags: [{ dir: "extra", hosts: ["solid"] }] } }),
    );
    writeFileSync(join(dir, "extra/thing.mx"), "<div/>");
    writeFileSync(join(dir, "page.mx"), "<div/>");
    const { createHonoBunPlugin } = await import("./bun.ts");
    let load: ((args: { path: string }) => unknown) | undefined;
    const builder = {
      onLoad: (_options: unknown, callback: typeof load) => {
        load = callback;
      },
    };
    // SAFETY: setup only registers onLoad; the test supplies that seam.
    createHonoBunPlugin().setup(builder as PluginBuilder);
    expect(load?.({ path: join(dir, "page.mx") })).toMatchObject({
      loader: "tsx",
      contents: expect.any(String),
    });
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});
