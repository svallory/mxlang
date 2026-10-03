import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import mx, { MX_SUFFIX } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each(["bogus", "html", "@acme/target", "data"])(
  "%s fails every transform via this.error at package.json, with a frame",
  async (target) => {
    const root = mkdtempSync(join(tmpdir(), "mx-vite-target-"));
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ mx: { host: "solid", target } }, null, 2),
    );
    const plugin = mx() as unknown as {
      transform: (
        this: unknown,
        source: string,
        id: string,
      ) => Promise<unknown>;
    };
    const warn = vi.fn();
    const error = vi.fn((cause: Error) => {
      throw cause;
    });
    for (let i = 0; i < 2; i++) {
      await expect(
        plugin.transform.call(
          { warn, error },
          "<p>ok</p>",
          join(root, "page.mx") + MX_SUFFIX,
        ),
      ).rejects.toMatchObject({
        id: join(root, "package.json"),
        loc: { file: join(root, "package.json"), line: 4, column: 14 },
        frame: expect.stringContaining('"target"'),
      });
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  },
);
