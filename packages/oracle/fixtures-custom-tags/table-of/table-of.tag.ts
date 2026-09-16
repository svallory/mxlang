/**
 * `<table-of=rows columns=["name", "price"]/>`: L2 without the collecting pair.
 *
 * The counterpart to `icon-sprite`. Nothing here depends on the set of calls,
 * so there is no `analyze` and no `finalize` — a tag that only needs to see
 * one call writes one hook. What it does need is the other two halves of the
 * L2 surface: `literalOnly`, so the column list is a value this file can read
 * at compile time rather than code the host must emit, and `ctx.build`'s
 * structural builders, so the body is a real `<for>` in the IR and each host
 * lowers it with its own loop rather than receiving pre-rendered rows.
 */
import type {
  CustomTag,
  Expr,
  IrNode,
  TagCall,
  TransformContext,
} from "@mxlang/core";

/**
 * Reads a `columns=["a", "b"]` attribute back as strings.
 *
 * `literalOnly` has already guaranteed the value is a compile-time constant, so
 * the only thing left to check is that it is a constant of the right *shape*
 * — an array of strings rather than, say, a number. That check is here rather
 * than declared because `attributes.type` describes scalars.
 */
function columnsOf(call: TagCall, ctx: TransformContext): string[] {
  const attr = call.attrs.find(
    (candidate) => candidate.kind !== "spread" && candidate.name === "columns",
  );
  if (attr?.kind !== "dynamic") {
    throw ctx.fail("`columns` must be an array of string literals");
  }
  const node = attr.value.node as
    | { type?: string; elements?: Array<{ type?: string; value?: unknown }> }
    | null
    | undefined;
  if (node?.type !== "ArrayExpression") {
    throw ctx.fail("`columns` must be an array of string literals", attr.loc);
  }
  const names: string[] = [];
  for (const element of node.elements ?? []) {
    if (
      element?.type !== "StringLiteral" ||
      typeof element.value !== "string"
    ) {
      throw ctx.fail("`columns` must be an array of string literals", attr.loc);
    }
    names.push(element.value);
  }
  if (names.length === 0) {
    throw ctx.fail("`columns` must name at least one column", attr.loc);
  }
  return names;
}

function rowsOf(call: TagCall, ctx: TransformContext): Expr {
  // The default attribute (`<table-of=rows>`) arrives under Marko's own name
  // for it, `value`.
  const attr = call.attrs.find(
    (candidate) => candidate.kind !== "spread" && candidate.name === "value",
  );
  if (attr?.kind !== "dynamic") {
    throw ctx.fail(
      "requires the rows as its default attribute, `<table-of=rows>`",
    );
  }
  return attr.value;
}

const tableOf: CustomTag = {
  parseOptions: { openTagOnly: true },
  attributes: {
    value: { type: "expression", required: true },
    columns: { literalOnly: true, required: true },
    class: { type: "string" },
  },

  transform(call: TagCall, ctx: TransformContext): IrNode[] {
    const columns = columnsOf(call, ctx);
    const rows = rowsOf(call, ctx);
    const passthrough = call.attrs.filter(
      (attr) =>
        attr.kind !== "spread" &&
        attr.name !== "value" &&
        attr.name !== "columns",
    );
    // A name no template can see, so a caller's own `row` binding is untouched
    // by the one this tag introduces.
    const row = ctx.gensym("row");

    const head = ctx.build.element(
      "thead",
      [],
      [
        ctx.build.element(
          "tr",
          [],
          columns.map((column) =>
            ctx.build.element("th", [], [ctx.build.text(column)]),
          ),
        ),
      ],
    );

    const body = ctx.build.element(
      "tbody",
      [],
      [
        ctx.build.forLoop({
          source: { kind: "of", list: rows },
          params: [row],
          children: [
            ctx.build.element(
              "tr",
              [],
              columns.map((column) =>
                ctx.build.element(
                  "td",
                  [],
                  [ctx.build.interpolation(ctx.build.expr(`${row}.${column}`))],
                ),
              ),
            ),
          ],
        }),
      ],
    );

    return [ctx.build.element("table", passthrough, [head, body])];
  },
};

export default tableOf;
