import { describe, expect, it } from "vitest";
import { exportNameFor } from "./export-name.ts";

describe("exportNameFor", () => {
  const rows: Array<[string, string]> = [
    ["icon.mx", "Icon"],
    ["table-of.mx", "TableOf"],
    ["/a/b/tree.mx", "Tree"],
    ["my_widget.mx", "MyWidget"],
    ["my.widget.mx", "MyWidget"],
    ["Icon.mx", "Icon"],
    ["page.solid.mx", "PageSolid"],
    // Not an identifier start: prefixed rather than emitted invalid. The
    // separator matters — see the distinctness case below.
    ["1st.mx", "Tag_1st"],
    // Nothing usable in the basename at all.
    [".mx", "Tag"],
    // `Tag` is an ordinary basename, not a signal to prefix: an earlier
    // version double-prefixed this to `TagTag`.
    ["tag.mx", "Tag"],
    // `$` is an identifier character an author chose, not a word separator,
    // so it survives — and a `$`-leading name needs no prefix. Documented
    // rather than incidental: the result is valid but not PascalCase.
    ["$x.mx", "$x"],
  ];

  for (const [filename, expected] of rows) {
    it(`derives ${expected} from ${filename}`, () => {
      expect(exportNameFor(filename)).toBe(expected);
    });
  }

  it("keeps a digit-leading name distinct from a Tag-prefixed sibling", () => {
    // Two tag files in one directory are separate compilations with separate
    // `Ctx`s, so they never see each other's names and the collision re-mint
    // below cannot separate them. If the prefix had no separator, `9.mx` and
    // `tag-9.mx` would both be `Tag9` and one would silently shadow the
    // other at the call site.
    expect(exportNameFor("9.mx")).not.toBe(exportNameFor("tag-9.mx"));
    expect(exportNameFor("9.mx")).toBe("Tag_9");
    expect(exportNameFor("tag-9.mx")).toBe("Tag9");
  });

  it("re-mints a name that collides with a binding in the file", () => {
    const taken = new Set(["Icon", "Icon2"]);
    expect(exportNameFor("icon.mx", (name) => taken.has(name))).toBe("Icon3");
  });

  it("leaves a non-colliding name alone", () => {
    expect(exportNameFor("icon.mx", (name) => name === "Other")).toBe("Icon");
  });
});
