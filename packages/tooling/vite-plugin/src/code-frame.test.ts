import { describe, expect, it } from "vitest";
import { codeFrame } from "./index";

describe("codeFrame", () => {
  const source = "<div>\n  <for|x|/>\n</div>\n";

  it("draws one caret under the start when there is no end", () => {
    expect(codeFrame(source, 2, 2)).toBe("2 |   <for|x|/>\n      ^");
  });

  it("draws a run of carets from the start to an end on the same line", () => {
    expect(codeFrame(source, 2, 2, 6)).toBe("2 |   <for|x|/>\n      ^^^^");
  });

  it("runs to the end of the line when the diagnostic ends on a later line", () => {
    expect(codeFrame(source, 2, 2, Number.POSITIVE_INFINITY)).toBe(
      "2 |   <for|x|/>\n      ^^^^^^^^^",
    );
  });

  it("never runs past the end of the line", () => {
    expect(codeFrame(source, 2, 2, 400)).toBe(
      "2 |   <for|x|/>\n      ^^^^^^^^^",
    );
  });

  it("is at least one caret: an empty or backwards end is the one character", () => {
    expect(codeFrame(source, 2, 2, 2)).toBe("2 |   <for|x|/>\n      ^");
    expect(codeFrame(source, 2, 2, 0)).toBe("2 |   <for|x|/>\n      ^");
  });

  it("keeps one caret at a column past the end of the line", () => {
    expect(codeFrame("<div\n", 1, 4, 9)).toBe("1 | <div\n        ^");
  });

  it("is empty for a line the source does not have", () => {
    expect(codeFrame(source, 9, 0, 3)).toBe("");
  });
});
