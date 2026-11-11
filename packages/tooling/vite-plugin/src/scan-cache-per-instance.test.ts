import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ caches: [] as unknown[] }));
vi.mock("@mxlang/targets", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mxlang/targets")>();
  return {
    ...original,
    scanCached: (...args: Parameters<typeof original.scanCached>) => {
      seen.caches.push(args[1]?.cache);
      return original.scanCached(...args);
    },
  };
});

import mx, { MX_SUFFIX } from "./index.ts";

type Transform = (this: unknown, code: string, id: string) => Promise<unknown>;

it("each mx() instance scans through its own cache, kept for its lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "mx-vite-scan-cache-"));
  try {
    writeFileSync(join(root, "package.json"), '{"mx":{"target":"html"}}');
    const id = join(root, "page.mx") + MX_SUFFIX;
    const first = (mx() as unknown as { transform: Transform }).transform;
    const second = (mx() as unknown as { transform: Transform }).transform;

    await first.call({}, "<p>a</p>", id);
    await first.call({}, "<p>b</p>", id);
    await second.call({}, "<p>a</p>", id);

    const [a1, a2, b1] = seen.caches;
    expect(a1).toBeDefined();
    expect(a2).toBe(a1);
    expect(b1).toBeDefined();
    expect(b1).not.toBe(a1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
