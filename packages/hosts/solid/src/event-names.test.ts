/**
 * `SOLID_EVENT_PROP_NAMES` is vendored data (see `event-names.ts`), not a
 * rule anyone can derive — `dblclick` is `onDblClick`, never `onDblclick`.
 * Two things are pinned here:
 *
 * - a table test driving `solidEventPropName` with one row per vendored
 *   name, so a hand-edited list cannot drift from what the emitter actually
 *   produces;
 * - a drift test comparing the vendored list against the installed
 *   `@solidjs/web`'s own `jsx.d.ts`, so a pin bump cannot silently change
 *   Solid's names out from under the vendor.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSolidEventPropNames,
  SOLID_EVENT_PROP_NAMES,
  solidEventPropName,
} from "./event-names.ts";

const require = createRequire(import.meta.url);

describe("vendored Solid event prop names", () => {
  it("covers every vendored name: domName -> Solid's declared spelling", () => {
    const propNames = buildSolidEventPropNames();
    for (const solidName of SOLID_EVENT_PROP_NAMES) {
      const domName = solidName.toLowerCase();
      expect(propNames[domName], domName).toBe(solidName);
      expect(solidEventPropName(domName), domName).toBe(`on${solidName}`);
    }
  });

  it("recomposes a DOM name Solid's types do not declare with capitalize-first", () => {
    expect(solidEventPropName("myevent")).toBe("onMyevent");
  });

  it("matches multi-word names against jsx.d.ts, not capitalize-first", () => {
    expect(solidEventPropName("dblclick")).toBe("onDblClick");
    expect(solidEventPropName("keydown")).toBe("onKeyDown");
    expect(solidEventPropName("pointerdown")).toBe("onPointerDown");
    expect(solidEventPropName("focusin")).toBe("onFocusIn");
  });

  it("matches Solid's table against the installed @solidjs/web (drift test)", () => {
    let entry = "";
    try {
      // `@solidjs/web/package.json` is not an exported subpath, so resolve
      // the package's main entry and walk up to its root instead.
      entry = require.resolve("@solidjs/web");
    } catch {
      entry = "";
    }
    // A disarmed guard must fail loudly: the vendored list is only
    // trustworthy while it is checked against @solidjs/web itself, so a
    // missing package is an assertion failure, not a skip.
    expect(entry).toBeTruthy();
    const jsxTypesPath = join(dirname(dirname(entry)), "types/jsx.d.ts");
    expect(existsSync(jsxTypesPath)).toBe(true);
    const source = readFileSync(jsxTypesPath, "utf8");
    const fromSource = new Set<string>();
    for (const match of source.matchAll(/\bon([A-Z][A-Za-z]*)\?:/g)) {
      const name = match[1];
      if (name) fromSource.add(name);
    }
    expect([...SOLID_EVENT_PROP_NAMES].sort()).toEqual([...fromSource].sort());
  });
});
