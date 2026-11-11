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
import { __testing, createLoader, loadMx } from "./helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(packageRoot, ".mx-helpers-loader-isolation-tmp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loader instances", () => {
  it("do not share caches or sources for the same path", () => {
    const a = createLoader();
    const b = createLoader();
    const filename = join(dir, "inline.mx");
    writeFileSync(filename, "");
    const srcA = "<p>a</p>";

    const ra = a.mx(srcA, { filename });
    // Same loader, same input: cache hit.
    expect(a.mx(srcA, { filename })).toBe(ra);
    // Other loader, same input: its own compile, not A's cache entry.
    const rb = b.mx(srcA, { filename });
    expect(rb).not.toBe(ra);
  });

  it("recompiling in one loader leaves the other's module untouched", () => {
    const file = join(dir, "reload.mx");
    writeFileSync(file, "<p>one</p>\n");
    const a = createLoader();
    const b = createLoader();
    const ra1 = a.loadMx(file);
    const rb1 = b.loadMx(file);
    // B compiled for itself, not served from A's top-level cache.
    expect(rb1).not.toBe(ra1);

    writeFileSync(file, "<p>two</p>\n");
    const later = new Date("2100-01-01T00:00:00Z");
    utimesSync(file, later, later);

    const ra2 = a.loadMx(file);
    expect(ra2({})).toBe("<p>two</p>");
    expect(ra2).not.toBe(ra1);
    // B recompiles on its own; A's fresh entry is not B's.
    const rb2 = b.loadMx(file);
    expect(rb2({})).toBe("<p>two</p>");
    expect(rb2).not.toBe(rb1);
    expect(rb2).not.toBe(ra2);
  });

  it("register the Node hook once and still resolve each one's modules", () => {
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "tags", "badge.mx"), "<b>badge</b>\n");
    const page = join(dir, "page.mx");
    writeFileSync(page, "<badge/>\n");

    const nodeModule = createRequire(import.meta.url)(
      "node:module",
    ) as typeof import("node:module");
    // Any load through the default loader guarantees the hook is registered.
    expect(loadMx(page)({})).toBe("<b>badge</b>");
    const spy = vi.spyOn(nodeModule, "registerHooks");
    try {
      const a = createLoader();
      const b = createLoader();
      expect(a.loadMx(page)({})).toBe("<b>badge</b>");
      expect(b.loadMx(page)({})).toBe("<b>badge</b>");
      expect(__testing.hasNested(join(dir, "tags", "badge.mx"), a)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
