import { describe, expect, it } from "vitest";
import { attributeTagDiagnosticMappings } from "./language.ts";

/** The offset of the `n`th (1-based) `text` in `within`. */
function nth(within: string, text: string, n: number): number {
  let at = -1;
  for (let seen = 0; seen < n; seen++) {
    at = within.indexOf(text, at + 1);
    if (at < 0) throw new Error(`no ${n}th ${JSON.stringify(text)}`);
  }
  return at;
}

/**
 * Each authored `@name` and the generated start of the object mapped to it
 * (a fold's first occurrence starts at its prop, `name={`, so an error on the
 * whole record lands on the tag name):
 * the earliest generated offset of the tag-name mappings (zero source length)
 * whose source is that name.
 */
function objectStarts(
  source: string,
  generated: string,
): Array<[number, number]> {
  const starts = new Map<number, number>();
  for (const mapping of attributeTagDiagnosticMappings(source, generated)) {
    if (mapping.lengths[0] !== 0) continue;
    const from = mapping.sourceOffsets[0] as number;
    const to = mapping.generatedOffsets[0] as number;
    starts.set(from, Math.min(to, starts.get(from) ?? to));
  }
  return [...starts].sort((left, right) => left[0] - right[0]);
}

/** Each authored `name=value` and the generated offset it is mapped to. */
function attributeTargets(
  source: string,
  generated: string,
): Array<[string, number]> {
  return attributeTagDiagnosticMappings(source, generated)
    .filter((mapping) => mapping.lengths[0] !== 0)
    .map((mapping) => {
      const from = mapping.sourceOffsets[0] as number;
      return [
        source.slice(from, from + (mapping.lengths[0] as number)),
        mapping.generatedOffsets[0] as number,
      ];
    });
}

const ADD = "__mxAttrTagAcc({";

describe("attributeTagDiagnosticMappings over a fold builder", () => {
  it("maps each occurrence to its own `add` call", () => {
    const source = "<A><@item id=1/><@item id=2/></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 1 }); __mxAttrTagAcc({ "id": 2 }); }, true)}/>';
    expect(objectStarts(source, generated)).toEqual([
      [nth(source, "item", 1), nth(generated, "item={", 1)],
      [nth(source, "item", 2), nth(generated, ADD, 2)],
    ]);
    expect(attributeTargets(source, generated)).toEqual([
      ["id=1", nth(generated, `"id": 1`, 1)],
      ["id=2", nth(generated, `"id": 2`, 1)],
    ]);
  });

  it("maps each branch of an `<if>` to its own `add` call", () => {
    const source = "<A><if=c><@item id=1/></if><else><@item id=2/></else></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { if (c) { __mxAttrTagAcc({ "id": 1 }); } else { __mxAttrTagAcc({ "id": 2 }); } })}/>';
    expect(objectStarts(source, generated)).toEqual([
      [nth(source, "item", 1), nth(generated, "item={", 1)],
      [nth(source, "item", 2), nth(generated, ADD, 2)],
    ]);
  });

  // A nested call folds the same name inside the outer fold's first
  // occurrence, with the same `add` name: its occurrences are its own `add`
  // calls, and the outer fold's second occurrence is still the outer's.
  it("maps a nested call's fold of the same name to the nested builder", () => {
    const source =
      "<A><@item id=1><B><@item id=3/><@item id=4/></B></@item><@item id=2/></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 1, content: <B item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 3 }); __mxAttrTagAcc({ "id": 4 }); }, true)}/> }); __mxAttrTagAcc({ "id": 2 }); }, true)}/>';
    expect(objectStarts(source, generated)).toEqual([
      [nth(source, "item", 1), nth(generated, "item={", 1)],
      [nth(source, "item", 2), nth(generated, "item={", 2)],
      [nth(source, "item", 3), nth(generated, ADD, 3)],
      [nth(source, "item", 4), nth(generated, ADD, 4)],
    ]);
  });

  // `subitem={...}` is another prop; probing `item` must not open a fold there.
  it("does not take a longer prop name ending in the name for its builder", () => {
    const source = "<A><@subitem id=1/><@item id=2/></A>";
    const generated =
      '<A subitem={__mxAttrTag({ "id": 1 })} item={__mxAttrTag({ "id": 2 })}/>';
    expect(objectStarts(source, generated)).toEqual([
      [nth(source, "subitem", 1), nth(generated, "subitem={", 1)],
      [nth(source, "@item", 1) + 1, nth(generated, " item={", 1) + 1],
    ]);
  });
});
