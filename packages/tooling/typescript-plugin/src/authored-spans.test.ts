import { describe, expect, it } from "vitest";
import { markoAuthoredSpans } from "./authored-spans.ts";

const FILE = "/p/page.mx";

function texts(source: string): string[] {
  return markoAuthoredSpans(source, FILE, undefined)
    .filter((span) => span.kind !== "code")
    .map((span) => source.slice(span.start, span.end));
}

function code(source: string): string[] {
  return markoAuthoredSpans(source, FILE, undefined)
    .filter((span) => span.kind === "code")
    .map((span) => source.slice(span.start, span.end));
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

  it("marks tags and attributes by kind", () => {
    const source = "<p title=t>x</p>";

    expect(
      markoAuthoredSpans(source, FILE, undefined).map((span) => span.kind),
    ).toEqual(["tag", "attribute", "code"]);
  });

  it("gives every piece of authored code a span, and no static text or quoted string", () => {
    const source = [
      "$ const q = 1;",
      '<div title=missing class="missing word">',
      "  text missing",
      "  <if(cond)><b>${x + 1}</b></if>",
      "  <for|item| of=list>${item}</for>",
      "  <${dynamic}/>",
      "  <let/count=0/>",
      "</div>",
    ].join("\n");

    expect(code(source)).toEqual([
      "$ const q = 1;",
      "missing",
      "cond",
      "x + 1",
      "item",
      "list",
      "item",
      "dynamic",
      "count",
      "0",
    ]);
  });

  it("has no spans for a source that does not parse", () => {
    expect(markoAuthoredSpans("<div", FILE, undefined)).toEqual([]);
  });
});
