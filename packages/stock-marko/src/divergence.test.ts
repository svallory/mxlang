/**
 * The divergence table: every EVENT_ROWS input renders different event
 * streams under the stock parser and MX's; both streams are pinned in
 * `divergence.expected.json` (regenerate with GRAMMAR_SPEC_UPDATE=1, then
 * review the diff — the file is the observation of record). TREE_ROWS
 * inputs render identical streams and are pinned at the Marko-tree level
 * instead. CONTROL_ROWS must stay equal.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROL_ROWS, EVENT_ROWS, TREE_ROWS } from "./divergence.cases.ts";
import { stockMarkoTree } from "./marko.ts";
import { mxEvents, stockEvents } from "./stock.ts";

interface ExpectedFile {
  rows: Record<string, { stock: string[]; mx: string[] }>;
}

const EXPECTED_PATH = fileURLToPath(
  new URL("./divergence.expected.json", import.meta.url),
);

function render(): ExpectedFile {
  const rows: ExpectedFile["rows"] = {};
  for (const row of [...EVENT_ROWS, ...TREE_ROWS, ...CONTROL_ROWS]) {
    rows[row.id] = { stock: stockEvents(row.input), mx: mxEvents(row.input) };
  }
  return { rows };
}

if (process.env.GRAMMAR_SPEC_UPDATE === "1") {
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(render(), null, 2)}\n`);
  console.log(`wrote ${EXPECTED_PATH}`);
}

const expected: ExpectedFile = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

/** Walks a Marko tree for nodes of one type. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") yield record;
  for (const value of Object.values(record)) yield* walk(value);
}

describe("the event-level divergence table", () => {
  it("has at least 20 rows", () => {
    expect(EVENT_ROWS.length).toBeGreaterThanOrEqual(20);
  });

  it("covers the documented divergences", () => {
    expect(EVENT_ROWS.map((row) => row.id)).toEqual(expectedRows());
  });

  it.each(EVENT_ROWS)("$id ($note)", (row) => {
    const pinned = expected.rows[row.id];
    expect(pinned, `no pinned stream for ${row.id}`).toBeDefined();
    expect(stockEvents(row.input)).toEqual(pinned.stock);
    expect(mxEvents(row.input)).toEqual(pinned.mx);
    expect(
      pinned.stock,
      `${row.id}: stock and MX streams must differ`,
    ).not.toEqual(pinned.mx);
  });
});

function expectedRows(): string[] {
  return Object.keys(expected.rows).filter((id) =>
    EVENT_ROWS.some((row) => row.id === id),
  );
}

describe("the tree-level divergence table", () => {
  it.each(TREE_ROWS)("$id: identical parser events", (row) => {
    const pinned = expected.rows[row.id];
    expect(stockEvents(row.input)).toEqual(pinned.stock);
    expect(mxEvents(row.input)).toEqual(pinned.mx);
    expect(pinned.stock).toEqual(pinned.mx);
  });

  it("tag-colon: stock Marko keeps `a:b` as one tag name", () => {
    const { ok, tree } = stockMarkoTree("<a:b/>");
    expect(ok).toBe(true);
    const names = [...walk(tree)]
      .filter((node) => node.type === "MarkoTag")
      .map((tag) => (tag.name as { value?: string }).value);
    expect(names).toEqual(["a:b"]);
  });

  it("bare-sugar: stock Marko fills `:x` as `value:x`", () => {
    const { ok, tree } = stockMarkoTree("<div :x/>");
    expect(ok).toBe(true);
    const attributes = [...walk(tree)].filter(
      (node) => node.type === "MarkoAttribute",
    );
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({ name: "value", modifier: "x" });
  });

  it("shorthand-colon: stock Marko keeps the class `hover:x`", () => {
    const { ok, tree } = stockMarkoTree("<a.hover:x/>");
    expect(ok).toBe(true);
    const attributes = [...walk(tree)].filter(
      (node) => node.type === "MarkoAttribute",
    );
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({
      name: "class",
      value: { type: "StringLiteral", value: "hover:x" },
    });
  });
});

describe("the controls", () => {
  it.each(CONTROL_ROWS)("$id: stock and MX agree", (row) => {
    const pinned = expected.rows[row.id];
    expect(stockEvents(row.input)).toEqual(pinned.stock);
    expect(mxEvents(row.input)).toEqual(pinned.mx);
    expect(
      pinned.mx,
      `${row.id}: a control row stopped being a control`,
    ).toEqual(pinned.stock);
  });
});
