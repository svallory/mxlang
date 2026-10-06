import { describe, expect, it } from "vitest";
import { markoAuthoredSpans } from "./authored-spans.ts";

const FILE = "/p/page.mx";

function texts(source: string): string[] {
  return markoAuthoredSpans(source, FILE, undefined).map((span) =>
    source.slice(span.start, span.end),
  );
}

describe("markoAuthoredSpans", () => {
  it("gives each tag and each attribute its own span, nested tags too", () => {
    const source = '<div class="a" title=t>\n  <span>${x}</span>\n</div>\n';

    expect(texts(source)).toEqual([
      source.trimEnd(),
      'class="a"',
      "title=t",
      "<span>${x}</span>",
    ]);
  });

  it("finds a tag on a later line by its line and column", () => {
    const source = "<hr/>\n\n<p>\n  <b>${x}</b>\n</p>\n";

    expect(texts(source)).toEqual([
      "<hr/>",
      "<p>\n  <b>${x}</b>\n</p>",
      "<b>${x}</b>",
    ]);
  });

  it("has no spans for a source that does not parse", () => {
    expect(markoAuthoredSpans("<div", FILE, undefined)).toEqual([]);
  });
});
