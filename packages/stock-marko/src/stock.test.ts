/**
 * `stockParse` / `stockEvents`: the stock parser's own behavior, and the
 * two probes the brief names as proof the wiring is stock.
 */
import { describe, expect, it } from "vitest";
import {
  mxEvents,
  stockEvents,
  stockParse,
  stockParserModule,
} from "./stock.ts";
import { PATCH_MARKERS } from "./vendor.ts";

describe("stockParse", () => {
  it("exposes stock's createParser and TagType", () => {
    const mod = stockParserModule();
    expect(typeof mod.createParser).toBe("function");
    expect(typeof mod.TagType.text).toBe("number");
    expect(typeof mod.TagType.void).toBe("number");
    expect(typeof mod.TagType.statement).toBe("number");
  });

  it("parses with handlers and read() returns the raw source", () => {
    const ranges: { start: number; end: number }[] = [];
    const parser = stockParse("<div a=b/>", {
      onAttrValue(range: { start: number; end: number }) {
        ranges.push(range);
      },
    });
    const seenText = ranges.map((r) => parser.read(r));
    expect(seenText).toEqual(["=b"]);
  });

  it("has no patch marker in its source (module level)", () => {
    const mod = stockParserModule() as unknown as Record<string, unknown>;
    // The patch's additions are internal functions, so absence is checked
    // on the source text in vendor.test.ts; here the public surface must
    // not know atoms.
    expect(Object.keys(mod).join(",")).not.toContain("onAtom");
    expect(PATCH_MARKERS.length).toBeGreaterThan(5);
  });
});

describe("stockEvents", () => {
  it("reads `<div a=b :c/>` as one attribute value `b :c`", () => {
    const events = stockEvents("<div a=b :c/>");
    expect(
      events.some((line) => line.includes('value=7-11 "b :c"')),
    ).toBe(true);
    expect(events.some((line) => line.startsWith("AttrName 9-11"))).toBe(
      false,
    );
  });

  it("reads `<div x=:a/>` as the attribute value `:a`, no atom", () => {
    const events = stockEvents("<div x=:a/>");
    expect(events.some((line) => line.includes('value=7-9 ":a"'))).toBe(true);
    expect(events.some((line) => line.startsWith("Atom"))).toBe(false);
  });

  it("differs from MX on both", () => {
    expect(stockEvents("<div a=b :c/>")).not.toEqual(
      mxEvents("<div a=b :c/>"),
    );
    expect(stockEvents("<div x=:a/>")).not.toEqual(mxEvents("<div x=:a/>"));
  });
});
