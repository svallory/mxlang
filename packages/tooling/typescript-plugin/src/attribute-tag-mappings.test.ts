import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regionCompileFor } from "@mxlang/targets";
import { print } from "@mxlang/tsx-bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** The offset of the name in the `n`th (1-based) opening `<@name`. */
function opening(source: string, name: string, n: number): number {
  return nth(source, `<@${name}`, n) + 2;
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
      [opening(source, "item", 1), nth(generated, "item={", 1)],
      [opening(source, "item", 2), nth(generated, ADD, 2)],
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
      [opening(source, "item", 1), nth(generated, "item={", 1)],
      [opening(source, "item", 2), nth(generated, ADD, 2)],
    ]);
  });

  // A closing `</@item>` is not an occurrence: the next opening tag is.
  it("skips the closing tag of an occurrence with a body", () => {
    const source = "<A><@item id=1>a</@item><@item id=2/></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 1, content: "a" }); __mxAttrTagAcc({ "id": 2 }); }, true)}/>';
    expect(objectStarts(source, generated)).toEqual([
      [opening(source, "item", 1), nth(generated, "item={", 1)],
      [opening(source, "item", 2), nth(generated, ADD, 2)],
    ]);
    expect(attributeTargets(source, generated)).toEqual([
      ["id=1", nth(generated, `"id": 1`, 1)],
      ["id=2", nth(generated, `"id": 2`, 1)],
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
      [opening(source, "item", 1), nth(generated, "item={", 1)],
      [opening(source, "item", 2), nth(generated, "item={", 2)],
      [opening(source, "item", 3), nth(generated, ADD, 3)],
      [opening(source, "item", 4), nth(generated, ADD, 4)],
    ]);
    expect(
      attributeTargets(source, generated).find(([attr]) => attr === "id=2"),
    ).toEqual(["id=2", nth(generated, `"id": 2`, 1)]);
  });

  // A nested call folding *another* name, with the same `add` name: its
  // `add` calls are not the outer fold's next occurrence.
  it("skips a nested builder of another name inside an occurrence", () => {
    const source =
      "<A><@item id=1><B><@other k=3/><@other k=4/></B></@item><@item id=2/></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 1, content: <B other={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "k": 3 }); __mxAttrTagAcc({ "k": 4 }); }, true)}/> }); __mxAttrTagAcc({ "id": 2 }); }, true)}/>';
    expect(objectStarts(source, generated)).toEqual([
      [opening(source, "item", 1), nth(generated, "item={", 1)],
      [opening(source, "other", 1), nth(generated, "other={", 1)],
      [opening(source, "other", 2), nth(generated, ADD, 3)],
      [opening(source, "item", 2), nth(generated, ADD, 4)],
    ]);
    expect(
      attributeTargets(source, generated).find(([attr]) => attr === "id=2"),
    ).toEqual(["id=2", nth(generated, `"id": 2`, 1)]);
  });

  // `subitem={...}` is another prop; probing `item` must not open a fold there.
  it("does not take a longer prop name ending in the name for its builder", () => {
    const source = "<A><@subitem id=1/><@item id=2/></A>";
    const generated =
      '<A subitem={__mxAttrTag({ "id": 1 })} item={__mxAttrTag({ "id": 2 })}/>';
    expect(objectStarts(source, generated)).toEqual([
      [opening(source, "subitem", 1), nth(generated, "subitem={", 1)],
      [opening(source, "item", 1), nth(generated, " item={", 1) + 1],
    ]);
  });

  // The builder's statements before its first `add` are the `<if>`'s and the
  // `<for>`'s own code: only the prop name maps to the tag name.
  it.each([
    [
      "<if=cond>",
      "<A><if=cond><@item x=1/></if><@item x=2/></A>",
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { if (cond) { __mxAttrTagAcc({ "x": 1 }); } __mxAttrTagAcc({ "x": 2 }); }, true)}/>',
      "cond",
    ],
    [
      "<for of=src>",
      "<A><for|v| of=src><@item x=v/></for></A>",
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { for (const v of src) { __mxAttrTagAcc({ "x": v }); } })}/>',
      "src",
    ],
  ])(
    "leaves the fold's %s code to its own mappings",
    (_, source, generated, code) => {
      const at = generated.indexOf(code);
      const covering = attributeTagDiagnosticMappings(source, generated).filter(
        (mapping) =>
          mapping.lengths[0] === 0 &&
          (mapping.generatedOffsets[0] as number) <= at &&
          at <
            (mapping.generatedOffsets[0] as number) +
              (mapping.generatedLengths?.[0] as number),
      );
      expect(covering).toEqual([]);
      expect(objectStarts(source, generated)[0]).toEqual([
        opening(source, "item", 1),
        nth(generated, "item={", 1),
      ]);
    },
  );

  // A nested call passing another value as a prop of the same name
  // (`<B item=...>`) is no record: it is passed over, and the outer second
  // occurrence still takes the outer builder's `add`.
  it("passes over a same-name prop of a nested call that is no record", () => {
    const source =
      "<A><@item id=1><B item=(() => 1)()/></@item><@item id=2/></A>";
    const generated =
      '<A item={__mxAttrTagsOf((__mxAttrTagAcc) => { __mxAttrTagAcc({ "id": 1, "content": <B item={(() => { return 1; })()}/> }); __mxAttrTagAcc({ "id": 2 }); }, true)}/>';
    expect(attributeTargets(source, generated)).toContainEqual([
      "id=2",
      nth(generated, `"id": 2`, 1),
    ]);
  });

  // A fold no declared type reaches is an arrow called in place; its steps
  // are the occurrences, and a nested one's steps (another name, the same
  // accumulator) are never the outer fold's.
  it("walks an in-place fold and skips a nested one", () => {
    const source =
      "<A><@item id=1><B><@entry k=3/><@entry k=4/></B></@item><@item id=2/></A>";
    const fold = (body: string) =>
      `(() => { let __mxAttrTagAcc; ${body} return __mxAttrTagAcc; })()`;
    const step = (attrs: string) =>
      `__mxAttrTagAcc = __mxAttrTags(__mxAttrTagAcc, { ${attrs} });`;
    const inner = fold(`${step('"k": 3')} ${step('"k": 4')}`);
    const generated = `<A item={${fold(
      `${step(`"id": 1, "content": <B entry={${inner}}/>`)} ${step('"id": 2')}`,
    )}}/>`;
    expect(attributeTargets(source, generated)).toEqual([
      ["id=1", nth(generated, `"id": 1`, 1)],
      ["k=3", nth(generated, `"k": 3`, 1)],
      ["k=4", nth(generated, `"k": 4`, 1)],
      ["id=2", nth(generated, `"id": 2`, 1)],
    ]);
  });
});

/**
 * The same walk over what the Preact and Solid region compiles really print,
 * for typed `.mx` callees: nested folds of two names, the outer one with
 * bodies, so the hand-written shapes above cannot drift from the emitters.
 */
describe("attributeTagDiagnosticMappings over real region output", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mx-attr-tag-mappings-"));
    for (const host of ["preact", "solid"]) {
      mkdirSync(join(root, host));
      writeFileSync(
        join(root, host, "package.json"),
        JSON.stringify({ name: host, mx: { host } }),
      );
      writeFileSync(
        join(root, host, "tabs.mx"),
        "export interface Input { tab?: AttrTag<{ id: number }> }\n<div/>\n",
      );
      writeFileSync(
        join(root, host, "menu.mx"),
        "export interface Input { entry?: AttrTag<{ k: number }> }\n<div/>\n",
      );
    }
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(["preact", "solid"])(
    "maps every occurrence and attribute on %s",
    (host) => {
      const file = join(root, host, `view.${host}.mx`);
      const source = [
        'import Tabs from "./tabs.mx";',
        'import Menu from "./menu.mx";',
        "export const view = <Tabs><@tab id=1><Menu><@entry k=3/><@entry k=4/></Menu></@tab><@tab id=2>b</@tab></Tabs>;",
        "",
      ].join("\n");
      const generated = print(source, file, {
        mx: true,
        mxRegionCompile: regionCompileFor(file, { typeCheck: true }) as never,
      }).code;
      const add = (attr: string) => nth(generated, `${ADD} ${attr}`, 1);
      expect(objectStarts(source, generated)).toEqual([
        [opening(source, "tab", 1), nth(generated, "tab={", 1)],
        [opening(source, "entry", 1), nth(generated, "entry={", 1)],
        [opening(source, "entry", 2), add(`"k": 4`)],
        [opening(source, "tab", 2), add(`"id": 2`)],
      ]);
      expect(attributeTargets(source, generated)).toEqual([
        ["id=1", nth(generated, `"id": 1`, 1)],
        ["k=3", nth(generated, `"k": 3`, 1)],
        ["k=4", nth(generated, `"k": 4`, 1)],
        ["id=2", nth(generated, `"id": 2`, 1)],
      ]);
    },
  );
});
