/**
 * The caches keyed on a `dialect` option (the validated dialect, the validated
 * bare table, a table's hash) are filled only for a deep-frozen object: every
 * plain object and array in it frozen. `Object.isFrozen` alone is shallow, so
 * a dialect frozen at the top with an unfrozen nested `contracts` map or
 * `table` row would otherwise keep serving its first contents after the
 * nested object changed. RegExps, functions, Maps, Sets and class instances
 * are opaque to the check: they are not walked and need not be frozen.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type LowerSourceOptions, lowerSource } from "./ir-entry/index.ts";
import {
  defaultSyntax,
  explicitSyntaxOf,
  isDeepFrozen,
  type SyntaxTable,
  syntaxHashes,
} from "./syntax-table.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-deep-freeze-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const FILE = join(dir, "p.x");

/** Freezes every plain object and array in `value`; RegExps, functions and the like are left alone. */
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !(value instanceof RegExp)) {
    for (const field of Object.values(value)) freezeDeep(field);
    Object.freeze(value);
  }
  return value;
}

// biome-ignore lint/suspicious/noExplicitAny: fixtures read and change nested fields freely
type Mutable = Record<string, any>;

/** What lowering `source` with `dialect` reports: the messages of its diagnostics (a refused dialect is one). */
function lower(dialect: object, source = "<box/>\n"): string[] {
  return lowerSource(source, FILE, {
    dialect: dialect as LowerSourceOptions["dialect"] & object,
  }).diagnostics.map((d) => d.message);
}

const MISSING_K = ["`<box>`: missing required attribute `k`"];

describe("a dialect frozen only at the top is re-validated on every call", () => {
  it("a nested `contracts` entry changed between two calls: the second call sees the new error, then the error going away", () => {
    const contracts: Mutable = {
      box: { attributes: { k: { type: "string", required: true } } },
    };
    const own = Object.freeze({
      id: "lexi",
      name: "Lexi",
      table: {},
      contracts,
    });
    expect(Object.isFrozen(own)).toBe(true);
    expect(lower(own)).toEqual(MISSING_K);
    contracts.box = {
      attributes: { k: { type: "string", required: true } },
      bogusKey: 1,
    };
    expect(lower(own)).toEqual([
      'the `dialect` option is not a valid dialect: `dialect.contracts.box`: Unknown key "bogusKey" in the declaration of tag "box"; allowed: parseOptions, attributes, attributeTags, children, parents, defaultTag, analyze, transform, finalize',
    ]);
    contracts.box = { attributes: { k: { type: "string", required: true } } };
    expect(lower(own)).toEqual(MISSING_K);
  });

  it("a nested `table` row changed between two calls: the second call sees the new error, then it goes away", () => {
    const table: Mutable = { blockTag: { open: "{%", close: "%}" } };
    const own = Object.freeze({ id: "lexi", name: "Lexi", table });
    expect(lower(own, "<p>a</p>\n")).toEqual([]);
    table.blockTag = { open: "", close: "%}" };
    expect(lower(own, "<p>a</p>\n")).toEqual([
      'the `dialect` option is not a valid dialect: `dialect.table.blockTag`: `blockTag` is null or { open, close } with non-empty strings; `dialect.table.blockTag.open`: `placeholder.open` ("${") and `blockTag.open` ("") start alike; one would hide the other',
    ]);
    table.blockTag = { open: "{%", close: "%}" };
    expect(lower(own, "<p>a</p>\n")).toEqual([]);
  });

  it("the resolution is not remembered: every call resolves afresh", () => {
    const table: Mutable = { blockTag: { open: "{%", close: "%}" } };
    const own = Object.freeze({ id: "lexi", name: "Lexi", table });
    const first = explicitSyntaxOf(own as never, FILE);
    expect(explicitSyntaxOf(own as never, FILE)).not.toBe(first);
  });
});

describe("a bare table frozen only at the top is re-validated on every call", () => {
  it("a nested row changed between two calls: the second call sees the new error, then it goes away", () => {
    const table: Mutable = Object.freeze({
      ...defaultSyntax(),
      blockTag: { open: "{%", close: "%}" },
    });
    expect(lower(table, "<p>a</p>\n")).toEqual([]);
    table.blockTag.open = "";
    expect(lower(table, "<p>a</p>\n")).toEqual([
      'the `dialect` option is not a valid syntax table: `dialect.blockTag`: `blockTag` is null or { open, close } with non-empty strings; `dialect.blockTag.open`: `placeholder.open` ("${") and `blockTag.open` ("") start alike; one would hide the other',
    ]);
    table.blockTag.open = "{%";
    expect(lower(table, "<p>a</p>\n")).toEqual([]);
  });

  it("is hashed and validated on every call, where a deep-frozen one is hashed once", () => {
    const partly = Object.freeze({
      ...defaultSyntax(),
      blockTag: { open: "{%", close: "%}" },
    }) as SyntaxTable;
    const before = syntaxHashes.count;
    for (let i = 0; i < 4; i++) explicitSyntaxOf(partly, FILE);
    expect(syntaxHashes.count - before).toBe(4);

    const deep = freezeDeep({
      ...defaultSyntax(),
      blockTag: { open: "[%", close: "%]" },
    }) as SyntaxTable;
    const mid = syntaxHashes.count;
    for (let i = 0; i < 4; i++) explicitSyntaxOf(deep, FILE);
    expect(syntaxHashes.count - mid).toBe(1);
  });
});

describe("a deep-frozen dialect stays cached", () => {
  /** A dialect with an unfrozen `/x/g` RegExp and a function in its contract, every plain object and array frozen. */
  function build() {
    const shape = /x/g;
    const checks = { count: 0 };
    const own = freezeDeep({
      id: "lexi",
      name: "Lexi",
      table: {},
      contractFields: { attribute: ["shape"] },
      checkContract() {
        checks.count += 1;
      },
      contracts: {
        box: { attributes: { k: { type: "string", required: true, shape } } },
      },
    });
    return { own, shape, checks };
  }

  it("the RegExp and the function are opaque: the dialect is deep-frozen with them unfrozen", () => {
    const { own, shape } = build();
    expect(Object.isFrozen(shape)).toBe(false);
    expect(isDeepFrozen(own)).toBe(true);
  });

  it("resolves to the same object on every call, whatever the RegExp's state", () => {
    const { own, shape } = build();
    const first = explicitSyntaxOf(own as never, FILE);
    shape.lastIndex = 7;
    expect(explicitSyntaxOf(own as never, FILE)).toBe(first);
    expect(explicitSyntaxOf(own as never, FILE)).toBe(first);
  });

  it("is validated once across N lowerings", () => {
    const { own, checks } = build();
    for (let i = 0; i < 5; i++) expect(lower(own)).toEqual(MISSING_K);
    expect(checks.count).toBe(1);
  });

  it("a deep-frozen dialect is not walked again once proven", () => {
    const calls = { ownKeys: 0 };
    const nested = new Proxy(Object.freeze({ a: Object.freeze([1]) }), {
      ownKeys(target) {
        calls.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    const top = Object.freeze({ nested });
    expect(isDeepFrozen(top)).toBe(true);
    const walked = calls.ownKeys;
    expect(walked).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) expect(isDeepFrozen(top)).toBe(true);
    expect(isDeepFrozen(nested)).toBe(true);
    expect(calls.ownKeys).toBe(walked);
  });
});

describe("isDeepFrozen", () => {
  it("needs the top object itself frozen", () => {
    expect(isDeepFrozen({})).toBe(false);
    expect(isDeepFrozen(Object.freeze({}))).toBe(true);
    expect(isDeepFrozen([])).toBe(false);
    expect(isDeepFrozen(Object.freeze([]))).toBe(true);
  });

  it("walks plain objects and arrays at any depth", () => {
    expect(isDeepFrozen(Object.freeze({ a: { b: 1 } }))).toBe(false);
    expect(isDeepFrozen(Object.freeze({ a: Object.freeze({ b: [1] }) }))).toBe(
      false,
    );
    expect(isDeepFrozen(Object.freeze({ a: [Object.freeze({ b: 1 })] }))).toBe(
      false,
    );
    expect(isDeepFrozen(freezeDeep({ a: [{ b: { c: [{}] } }] }))).toBe(true);
  });

  it("a null-prototype object is walked like a plain one", () => {
    const bare = Object.assign(Object.create(null), { a: {} });
    expect(isDeepFrozen(Object.freeze(bare))).toBe(false);
    expect(isDeepFrozen(freezeDeep(bare))).toBe(true);
  });

  it("RegExps, functions, Maps, Sets and class instances are opaque: not walked, need not be frozen", () => {
    class Box {
      inner = { open: true };
    }
    const opaque = {
      re: /x/g,
      fn() {},
      arrow: () => 1,
      map: new Map([["k", { open: true }]]),
      set: new Set([{ open: true }]),
      box: new Box(),
      date: new Date(0),
    };
    expect(isDeepFrozen(freezeDeep(opaque))).toBe(true);
    // And the plain object around them still has to be frozen.
    expect(isDeepFrozen({ ...opaque })).toBe(false);
  });

  it("an accessor property is not frozen data: its result can change", () => {
    const withGetter = Object.freeze({
      get field() {
        return 1;
      },
    });
    expect(isDeepFrozen(withGetter)).toBe(false);
    expect(isDeepFrozen(Object.freeze({ inner: withGetter }))).toBe(false);
  });

  it("a cycle of frozen objects terminates", () => {
    const a: Mutable = {};
    const b: Mutable = { a };
    a.b = b;
    expect(isDeepFrozen(a)).toBe(false);
    Object.freeze(a);
    expect(isDeepFrozen(a)).toBe(false);
    Object.freeze(b);
    expect(isDeepFrozen(a)).toBe(true);
    expect(isDeepFrozen(b)).toBe(true);
  });

  it("a failed walk is not remembered: freezing the missing piece makes it true", () => {
    const inner: Mutable = { x: 1 };
    const top = Object.freeze({ inner: Object.freeze({ deeper: inner }) });
    expect(isDeepFrozen(top)).toBe(false);
    expect(isDeepFrozen(top)).toBe(false);
    Object.freeze(inner);
    expect(isDeepFrozen(top)).toBe(true);
  });

  it("a positive answer covers the nested objects proven on the way", () => {
    const inner = freezeDeep({ x: [1] });
    const top = Object.freeze({ inner });
    expect(isDeepFrozen(top)).toBe(true);
    expect(isDeepFrozen(inner)).toBe(true);
    expect(isDeepFrozen(inner.x)).toBe(true);
  });

  it("primitives and null fields are skipped", () => {
    expect(
      isDeepFrozen(
        Object.freeze({ a: 1, b: "s", c: null, d: undefined, e: true }),
      ),
    ).toBe(true);
  });
});
