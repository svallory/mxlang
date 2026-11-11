/**
 * Two loaders in one process own separate virtual-module state (sources,
 * versions, caches) and share only the process-wide Node hook.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLoader } from "./helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(packageRoot, ".mx-loader-isolation-tmp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loader instances", () => {
  it("do not share caches or sources for the same path", () => {
    const a = createLoader();
    const b = createLoader();
    const filename = join(dir, "inline.mx");
    writeFileSync(filename, "");
    const srcA = "<p>a</p>";
    const srcB = "<p>b</p>";

    const ra = a.mx(srcA, { filename });
    // Same loader, same input: cache hit.
    expect(a.mx(srcA, { filename })).toBe(ra);
    // Other loader, same input: its own compile, not A's cache entry.
    const rb = b.mx(srcA, { filename });
    expect(rb).not.toBe(ra);
    // Same path, different source per loader: each renders its own.
    expect(a.mx(srcB, { filename })("")).toBe("<p>b</p>");
    expect(b.mx(srcA, { filename })("")).toBe("<p>a</p>");
  });

  it("recompiling in one loader leaves the other's module untouched", () => {
    const file = join(dir, "reload.mx");
    writeFileSync(file, "<p>one</p>\n");
    const a = createLoader();
    const b = createLoader();
    const ra1 = a.loadMx(file);
    const rb1 = b.loadMx(file);

    writeFileSync(file, "<p>two</p>\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);

    expect(a.loadMx(file)("")).toBe("<p>two</p>");
    expect(a.loadMx(file)).not.toBe(ra1);
    // B's entry is still B's own, still fresh-checked against its mtime.
    expect(ra1("")).toBe("<p>one</p>");
    expect(rb1("")).toBe("<p>one</p>");
    expect(b.loadMx(file)("")).toBe("<p>two</p>");
  });

  it("register the Node hook once and still resolve each one's modules", () => {
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "tags", "badge.mx"), "<b>badge</b>\n");
    const page = join(dir, "page.mx");
    writeFileSync(page, "<badge/>\n");

    const nodeModule = createRequire(import.meta.url)(
      "node:module",
    ) as typeof import("node:module");
    const spy = vi.spyOn(nodeModule, "registerHooks");
    try {
      const a = createLoader();
      const b = createLoader();
      expect(a.loadMx(page)("")).toBe("<b>badge</b>");
      expect(b.loadMx(page)("")).toBe("<b>badge</b>");
      expect(a.hasNested(join(dir, "tags", "badge.mx"))).toBe(true);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
