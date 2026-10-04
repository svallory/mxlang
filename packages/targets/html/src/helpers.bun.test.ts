import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadMx, mx } from "./helpers.ts";

/**
 * Runs under `bun test` (`bun run test:bun`), not vitest — vitest's own
 * worker process reports no `Bun` global even when invoked via `bunx`
 * (measured), so `mx`/`loadMx`'s Bun branch (`require` of a plugin virtual module) is
 * otherwise never actually exercised by the vitest suite in
 * `helpers.test.ts`, which only ever runs the Node `registerHooks` branch.
 * `bun:test`'s own worker genuinely runs under Bun, so this file is what
 * proves the Bun path — same fixture shape as `helpers.test.ts`'s, kept in
 * this package (never `/tmp` directly) for real `node_modules` resolution,
 * the same lesson `bun.test.ts` above already lives by for `Bun.plugin`.
 */

const packageRoot = new URL("..", import.meta.url).pathname;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

function makeFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(packageRoot, ".mx-helpers-bun-tmp-"));
  mkdirSync(join(dir, "tags"));
  writeFileSync(join(dir, "page.mx"), '<icon label="hi"/>\n');
  writeFileSync(
    join(dir, "tags", "icon.mx"),
    [
      "export interface Input { label: string }",
      "<div><label label=input.label/></div>",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tags", "label.mx"),
    [
      "export interface Input { label: string }",
      "<span>${input.label}</span>",
    ].join("\n"),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function bumpMtime(path: string): void {
  const past = new Date(Date.now() - 2000);
  utimesSync(path, past, past);
}

describe("mx-helpers on Bun (virtual-module require path)", () => {
  it("compiles and renders a template with no imports and no filename", () => {
    const render = mx<{ n: number }>("<p>${input.n}</p>");
    expect(render({ n: 42 })).toBe("<p>42</p>");
  });

  it("loads a page that calls a discovered custom tag, which itself imports another .mx file, with zero disk writes", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const before = listFiles(dir);
      const render = loadMx<Record<string, never>>(join(dir, "page.mx"));
      const html = render({});
      const after = listFiles(dir);

      expect(html).toBe("<div><span>hi</span></div>");
      expect(after).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("a file loaded standalone, then imported as a nested tag, resolves to the same already-evaluated module (round 2, finding 2)", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const labelPath = join(dir, "tags", "label.mx");
      const label = loadMx<{ label: string }>(labelPath);
      expect(label({ label: "solo" })).toBe("<span>solo</span>");

      const page = loadMx(join(dir, "page.mx"));
      expect(page({})).toBe("<div><span>hi</span></div>");
    } finally {
      cleanup();
    }
  });

  it("returns the same renderer on a second call when nothing changed (cache hit)", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const r1 = loadMx(join(dir, "page.mx"));
      const r2 = loadMx(join(dir, "page.mx"));
      expect(r1).toBe(r2);
    } finally {
      cleanup();
    }
  });

  it("invalidates when a NESTED dependency changes", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const path = join(dir, "page.mx");
      const r1 = loadMx(path);
      expect(r1({})).toBe("<div><span>hi</span></div>");

      const labelPath = join(dir, "tags", "label.mx");
      bumpMtime(labelPath);
      writeFileSync(
        labelPath,
        [
          "export interface Input { label: string }",
          "<span>CHANGED-${input.label}</span>",
        ].join("\n"),
      );

      const r2 = loadMx(path);
      expect(r2).not.toBe(r1);
      expect(r2({})).toBe("<div><span>CHANGED-hi</span></div>");
    } finally {
      cleanup();
    }
  });

  // Bun 1.3.14 (the CI pin) cannot resolve a `data:` URL past ~1.5 KB:
  // `NameTooLong while resolving package 'data:text/typescript;base64,…'`.
  // Bun 1.4.2 has no such limit, so these only go red on the pinned Bun — run
  // them with `~/.proto/tools/bun/1.3.14/bun` to see the regression.
  it("evaluates a template whose emitted module is far past any data: URL limit", () => {
    const big = "lorem ipsum dolor sit amet ".repeat(400);
    const render = mx<{ n: number }>(`<p>${big}\${input.n}</p>`);
    expect(render({ n: 7 })).toBe(`<p>${big}7</p>`);
  });

  it("evaluates a large page that imports a large nested tag", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const big = "lorem ipsum dolor sit amet ".repeat(400);
      writeFileSync(
        join(dir, "tags", "label.mx"),
        [
          "export interface Input { label: string }",
          `<span>${big}\${input.label}</span>`,
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "page.mx"),
        `<icon label="hi"/>\n<p>${big}</p>\n`,
      );
      const html = loadMx<Record<string, never>>(join(dir, "page.mx"))({});
      expect(html).toBe(`<div><span>${big}hi</span></div><p>${big}</p>`);
    } finally {
      cleanup();
    }
  });

  it("throws for a missing file", () => {
    const { dir, cleanup } = makeFixture();
    try {
      expect(() => loadMx(join(dir, "does-not-exist.mx"))).toThrow(
        /cannot find module/i,
      );
    } finally {
      cleanup();
    }
  });

  it("throws for an import cycle, naming the cycle", () => {
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-bun-cycle-tmp-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(join(dir, "page.mx"), "<a/>\n");
      writeFileSync(
        join(dir, "tags", "a.mx"),
        ["export interface Input {}", "<b/>"].join("\n"),
      );
      writeFileSync(
        join(dir, "tags", "b.mx"),
        ["export interface Input {}", "<a/>"].join("\n"),
      );

      expect(() => loadMx(join(dir, "page.mx"))).toThrow(/import cycle/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
