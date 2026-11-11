import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// `spyOn` cannot patch an ES module namespace, so core's factory is wrapped to
// count each created cache's scans. Nothing else is replaced.
const counts = vi.hoisted(() => [] as number[]);
vi.mock("@mxlang/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mxlang/core")>();
  return {
    ...original,
    createScanCache: () => {
      const cache = original.createScanCache();
      const index = counts.push(0) - 1;
      return {
        scan: (...args: Parameters<typeof cache.scan>) => {
          counts[index] = (counts[index] ?? 0) + 1;
          return cache.scan(...args);
        },
      };
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

    expect(counts).toEqual([2, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
