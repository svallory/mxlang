import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanCache } from "@mxlang/core";
import { expect, it } from "vitest";
import { scanCached } from "./index.ts";

it("scanCached scans through the cache it is given, not the shared default", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-registry-cache-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"mx":{"target":"html"}}');
    const page = join(dir, "page.mx");
    writeFileSync(page, "<p>x</p>\n");
    const cache = createScanCache();

    const viaOption = scanCached(page, { cache });
    // Same cache again: the cached result itself comes back.
    expect(scanCached(page, { cache })).toBe(viaOption);
    // The shared default holds its own, separate result.
    expect(scanCached(page, {})).not.toBe(viaOption);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
