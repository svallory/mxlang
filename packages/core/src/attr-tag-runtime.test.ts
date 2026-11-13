import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ATTR_TAG_FOLD,
  ATTR_TAG_RECORD,
  ATTR_TAG_RUNTIME,
  usesAttrTagRuntime,
} from "./attr-tag-runtime.ts";

type Rec = Record<string, unknown> & {
  [Symbol.iterator](): Iterator<Record<string, unknown>>;
  length: number;
  at(index: number): Record<string, unknown> | undefined;
  map<U>(fn: (item: Record<string, unknown>, index: number) => U): U[];
  filter(
    fn: (item: Record<string, unknown>, index: number) => unknown,
  ): Record<string, unknown>[];
  toArray(): Record<string, unknown>[];
};

/** The helper text as a host inlines it, types stripped and evaluated. */
const runtime = (() => {
  const js = ts.transpileModule(ATTR_TAG_RUNTIME, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  return new Function(
    `${js}\nreturn { record: ${ATTR_TAG_RECORD}, fold: ${ATTR_TAG_FOLD} };`,
  )() as {
    record: (attrs: object) => Rec;
    fold: (first: Rec | undefined, attrs: object) => Rec;
  };
})();

/** Marko's fold over occurrences, starting from `undefined`. */
function folded(...items: object[]): Rec | undefined {
  let acc: Rec | undefined;
  for (const item of items) acc = runtime.fold(acc, item);
  return acc;
}

describe("the attribute-tag record helper", () => {
  it("makes one occurrence a record of itself", () => {
    const one = runtime.record({ a: 1 });
    expect(one.a).toBe(1);
    expect([...one]).toEqual([one]);
    expect(one.length).toBe(1);
    expect(one.at(0)).toBe(one);
    expect(one.at(-1)).toBe(one);
    expect(one.at(1)).toBeUndefined();
    expect(one.toArray()).toEqual([one]);
  });

  it("folds every later occurrence behind the first, in order", () => {
    const record = folded({ a: 1 }, { a: 2 }, { a: 3 }) as Rec;
    expect(record.a).toBe(1);
    expect([...record].map((item) => item.a)).toEqual([1, 2, 3]);
    expect(record.length).toBe(3);
    expect(record.at(-1)?.a).toBe(3);
    expect(record.at(-3)?.a).toBe(1);
    expect(record.at(-4)).toBeUndefined();
    expect(record.at(1.7)?.a).toBe(2);
    expect(record.map((item, index) => [item.a, index])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(record.filter((item) => (item.a as number) > 1)).toEqual([
      { a: 2 },
      { a: 3 },
    ]);
    expect(record.toArray().map((item) => item.a)).toEqual([1, 2, 3]);
  });

  it("leaves no occurrence undefined", () => {
    expect(folded()).toBeUndefined();
  });

  it("keeps two records' rests apart", () => {
    const one = folded({ a: 1 }, { a: 2 }) as Rec;
    const two = folded({ b: 1 }) as Rec;
    expect(one.length).toBe(2);
    expect(two.length).toBe(1);
    expect([...two]).toEqual([two]);
  });

  it("adds only Marko's own keys: the attributes and symbols, nothing enumerable", () => {
    const record = folded({ a: 1, content: () => "x" }, { a: 2 }) as Rec;
    expect(Object.keys(record)).toEqual(["a", "content"]);
    expect(JSON.stringify(record)).toBe('{"a":1}');
    const symbols = Object.getOwnPropertySymbols(record).map((symbol) =>
      symbol === Symbol.iterator ? "iterator" : symbol.description,
    );
    expect(symbols).toEqual(["iterator", "Attribute Tag"]);
    for (const member of ["length", "at", "map", "filter", "toArray"]) {
      expect(Object.hasOwn(record, member), member).toBe(false);
    }
  });

  it("loses the prototype members, not the iteration, through a spread", () => {
    const record = folded({ a: 1 }, { a: 2 }) as Rec;
    const copy = { ...record } as unknown as Rec;
    expect([...copy].map((item) => item.a)).toEqual([1, 2]);
    expect(copy.map).toBeUndefined();
  });

  it("lets an own attribute shadow a prototype member", () => {
    const record = runtime.record({ length: 3 });
    expect(record.length).toBe(3);
  });

  it("declares only reserved names", () => {
    const file = ts.createSourceFile(
      "runtime.ts",
      ATTR_TAG_RUNTIME,
      ts.ScriptTarget.ES2022,
    );
    const names = file.statements.flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((d) =>
            d.name.getText(file),
          )
        : "name" in statement && statement.name
          ? [(statement.name as ts.Identifier).text]
          : [`<unnamed ${ts.SyntaxKind[statement.kind]}>`],
    );
    expect(names).toContain(ATTR_TAG_RECORD);
    expect(names).toContain(ATTR_TAG_FOLD);
    for (const name of names) expect(name).toMatch(/^__[mM]x/);
  });

  it("is needed only by text that calls it", () => {
    expect(usesAttrTagRuntime(`${ATTR_TAG_RECORD}({})`)).toBe(true);
    expect(usesAttrTagRuntime(`${ATTR_TAG_FOLD}(a, {})`)).toBe(true);
    expect(usesAttrTagRuntime("render({ item: {} })")).toBe(false);
  });
});
