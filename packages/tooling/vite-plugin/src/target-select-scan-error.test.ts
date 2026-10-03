import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslateError } from "@mxlang/core";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scanError: undefined as Error | undefined }));
vi.mock("@mxlang/target-registry", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@mxlang/target-registry")>();
  return {
    ...original,
    scanCached: (...args: Parameters<typeof original.scanCached>) => {
      if (state.scanError) throw state.scanError;
      return original.scanCached(...args);
    },
  };
});

import mx, { MX_SUFFIX } from "./index.ts";

it("locates a TranslateError from the tag scan at its authored file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mx-vite-scan-error-"));
  try {
    writeFileSync(join(root, "package.json"), '{"mx":{"target":"html"}}');
    const tagFile = join(root, "tag.mx");
    writeFileSync(tagFile, "<p>ok</p>\n<bad/>\n");
    const cause = new TranslateError("tag scan failed", 2, 1, tagFile);
    state.scanError = cause;
    const plugin = mx() as unknown as {
      transform: (
        this: unknown,
        source: string,
        id: string,
      ) => Promise<unknown>;
    };
    await expect(
      plugin.transform.call(
        {},
        "<p>page</p>",
        join(root, "page.mx") + MX_SUFFIX,
      ),
    ).rejects.toMatchObject({
      message: "tag scan failed",
      id: tagFile,
      loc: { file: tagFile, line: 2, column: 1 },
      frame: expect.stringContaining("<bad/>"),
    });
  } finally {
    state.scanError = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
