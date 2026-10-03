import { describe, expect, it } from "vitest";
import { unresolvedCustomTagMessage } from "./core.ts";
import { nearestHtmlElement, nearestName } from "./did-you-mean.ts";

describe("nearestHtmlElement", () => {
  it.each([
    ["dvi", "div"], // swapped pair: one edit, where Marko picks `bdi`
    ["buton", "button"],
    ["sapn", "span"],
    ["spna", "span"],
    ["secton", "section"],
    ["tabl", "table"],
    ["labl", "label"],
    ["imgg", "img"],
    ["heder", "header"],
    ["artcle", "article"],
    ["paragraph", undefined], // too far from every element
    ["my-widget", undefined],
    ["card", undefined],
    ["sp", undefined], // under three characters never suggests
    ["di", undefined],
    ["h7", undefined],
    ["div", undefined], // already an element: nothing to suggest
    ["tabel", undefined], // one edit from both `table` and `label`: ambiguous
    ["headr", undefined], // one edit from both `header` and `head`: ambiguous
  ])("%s -> %s", (name, expected) => {
    expect(nearestHtmlElement(name)).toBe(expected);
  });

  it("stays silent when two elements are equally near", () => {
    expect(nearestName("abc", ["abd", "abe"])).toBeUndefined();
  });
});

describe("nearestName", () => {
  it("compares case-insensitively and returns the candidate's own spelling", () => {
    expect(nearestName("Bage", ["Badge", "Card"])).toBe("Badge");
    expect(nearestName("Badge", ["Badge"])).toBeUndefined();
  });

  it("allows two edits only from five characters", () => {
    expect(nearestName("Crd", ["Card"])).toBe("Card");
    expect(nearestName("Cd", ["Card"])).toBeUndefined();
    expect(nearestName("Bdge1", ["Badge"])).toBe("Badge");
    expect(nearestName("Cadr", ["Cards"])).toBeUndefined(); // swap + insert = 2, length 4
    expect(nearestName("Panell1", ["Panel"])).toBe("Panel");
  });

  it("prefers the closer candidate over a farther one", () => {
    expect(nearestName("Badgee", ["Badge", "Badges2"])).toBe("Badge");
  });

  it("returns undefined with no candidates", () => {
    expect(nearestName("Card", [])).toBeUndefined();
  });
});

describe("unresolvedCustomTagMessage", () => {
  it("is Marko's wording alone when nothing helps", () => {
    expect(unresolvedCustomTagMessage("my-widget")).toBe(
      "Unable to find entry point for custom tag `<my-widget>`.",
    );
    expect(unresolvedCustomTagMessage("Card")).toBe(
      "Unable to find entry point for custom tag `<Card>`.",
    );
  });

  it("adds the host hint to a capitalized name only", () => {
    const hint = "Import it.";
    expect(unresolvedCustomTagMessage("Card", { hint })).toBe(
      "Unable to find entry point for custom tag `<Card>`. Import it.",
    );
    expect(unresolvedCustomTagMessage("my-widget", { hint })).toBe(
      "Unable to find entry point for custom tag `<my-widget>`.",
    );
  });

  it("suggests the nearest in-scope component, not the host hint", () => {
    expect(
      unresolvedCustomTagMessage("Bage", {
        candidates: ["Badge"],
        hint: "Import it.",
      }),
    ).toBe(
      "Unable to find entry point for custom tag `<Bage>`. Did you mean `<Badge>`?",
    );
  });

  it("suggests the nearest HTML element for a lowercase name", () => {
    expect(unresolvedCustomTagMessage("dvi")).toBe(
      "Unable to find entry point for custom tag `<dvi>`. Did you mean `<div>`?",
    );
  });

  it("does not offer an element for a capitalized name or a component for a lowercase one", () => {
    expect(unresolvedCustomTagMessage("Dvi")).toBe(
      "Unable to find entry point for custom tag `<Dvi>`.",
    );
    expect(unresolvedCustomTagMessage("badg", { candidates: ["Badge"] })).toBe(
      "Unable to find entry point for custom tag `<badg>`.",
    );
  });
});
