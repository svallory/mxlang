/**
 * Pins the vendored stock parser's bytes (decision 157.3's reference):
 *
 * 1. The vendored tarball's sha512 is the integrity `bun.lock` records for
 *    `htmljs-parser@5.18.0` — the published, unpatched artifact.
 * 2. The extracted builds contain none of the root patch's markers.
 * 3. Applying `patches/htmljs-parser@5.18.0.patch` forward to the vendored
 *    builds reproduces the installed (patched) `dist` byte for byte — the
 *    vendored copy is the patch's exact pre-image, and the install every
 *    other package resolves really is these bytes plus the patch.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ensureStockParserExtracted,
  PATCH_MARKERS,
  STOCK_TARBALL_INTEGRITY,
  STOCK_TARBALL_PATH,
  sha512Base64,
  untar,
} from "./vendor.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const patchPath = join(repoRoot, "patches/htmljs-parser@5.18.0.patch");
const lockPath = join(repoRoot, "bun.lock");

/** The installed, patched htmljs-parser package directory. */
function installedPatchedDir(): string {
  const require = createRequire(join(repoRoot, "package.json"));
  return dirname(dirname(require.resolve("htmljs-parser")));
}

describe("the vendored tarball", () => {
  it("has the sha512 bun.lock records for htmljs-parser@5.18.0", () => {
    expect(`sha512-${sha512Base64(STOCK_TARBALL_PATH)}`).toBe(
      STOCK_TARBALL_INTEGRITY,
    );
    const lock = readFileSync(lockPath, "utf8");
    expect(lock).toContain(
      `"htmljs-parser": ["htmljs-parser@5.18.0", "", {}, "${STOCK_TARBALL_INTEGRITY}"]`,
    );
  });

  it("carries dist (both builds), LICENSE and package.json, version 5.18.0", () => {
    const files = untar(STOCK_TARBALL_PATH);
    for (const name of [
      "package/dist/index.js",
      "package/dist/index.mjs",
      "package/dist/package.json",
      "package/LICENSE",
      "package/package.json",
    ]) {
      expect(files.has(name), name).toBe(true);
    }
    expect(
      JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "")
        .version,
    ).toBe("5.18.0");
    expect(files.get("package/LICENSE")?.toString("utf8")).toContain(
      "MIT License",
    );
  });
});

describe("the extracted stock builds", () => {
  it("contain none of the patch's markers", () => {
    const patch = readFileSync(patchPath, "utf8");
    const { cjs, mjs } = ensureStockParserExtracted();
    const builds = [readFileSync(cjs, "utf8"), readFileSync(mjs, "utf8")];
    for (const marker of PATCH_MARKERS) {
      // Guard against a rotting list: every marker names a patch addition.
      expect(patch, `marker ${marker} not in the patch`).toContain(marker);
      for (const build of builds) {
        expect(build.includes(marker), `stock build contains ${marker}`).toBe(
          false,
        );
      }
    }
  });

  it("plus the patch, byte-equal the installed patched dist", () => {
    const work = mkdtempSync(join(tmpdir(), "mx-stock-vendor-"));
    try {
      const { dir } = ensureStockParserExtracted();
      const patched = installedPatchedDir();
      const patch = readFileSync(patchPath, "utf8");
      for (const file of ["dist/index.js", "dist/index.mjs"]) {
        const applied = applyPatch(
          readFileSync(join(dir, file), "utf8"),
          patch,
          file,
        );
        expect(applied, file).toBe(readFileSync(join(patched, file), "utf8"));
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

/**
 * Applies the hunks of `patchText` that touch `file` to `text`, in plain
 * JS (the gate machine's PATH may have no `patch` binary). Every hunk's
 * "old" block (context and `-` lines) is searched for and swapped for its
 * "new" block (context and `+` lines) — the forward direction of the
 * reversal in `packages/core/src/stock-parser.test.ts`.
 */
export function applyPatch(
  text: string,
  patchText: string,
  file: string,
): string {
  for (const section of patchText.split(/^diff --git /m).slice(1)) {
    const sectionFile = section.match(/^a\/(\S+) b\//)?.[1];
    if (sectionFile !== file) continue;
    for (const hunk of section.split(/^@@ .* @@.*$/m).slice(1)) {
      const lines = hunk.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const kept = lines.filter((line) => !line.startsWith("\\"));
      const removed = kept
        .filter((line) => line[0] === " " || line[0] === "-")
        .map((line) => line.slice(1))
        .join("\n");
      const added = kept
        .filter((line) => line[0] === " " || line[0] === "+")
        .map((line) => line.slice(1))
        .join("\n");
      if (!text.includes(removed)) {
        throw new Error(`hunk not found while patching ${file}`);
      }
      text = text.replace(removed, () => added);
    }
  }
  return text;
}
