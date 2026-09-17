import { describe, expect, it } from "vitest";
import {
  angularAstSnapshot,
  assertAngularParses,
  compileMx,
  emit,
} from "./helpers.ts";

describe("For of", () => {
  it("emits track $index with a once-per-file warning when by= is absent", () => {
    const { code, warnings } = compileMx("<for|p| of=people>${p}</for>");
    expect(code).toBe("@for (p of people; track $index) { {{ p }} }");
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/no `by=`/);
    expect(angularAstSnapshot(code)).toMatchObject([
      { trackBy: { ast: { name: "$index" } }, empty: null },
    ]);
    // MX's `For` IR (packages/core/src/ir.ts) has no else/empty-list branch
    // — Angular's own `@for`/`@empty` pairing has no MX construct that lowers
    // to it, confirmed by `empty: null` above on a loop with no such branch.
  });

  it("emits track p.id for a string by=", () => {
    const out = emit('<for|p| of=people by="id">${p}</for>');
    expect(out).toBe("@for (p of people; track p.id) { {{ p }} }");
    assertAngularParses(out);
  });

  it("emits track p.id for an arrow by=", () => {
    const out = emit("<for|p| of=people by=(p => p.id)>${p}</for>");
    expect(out).toBe("@for (p of people; track p.id) { {{ p }} }");
    assertAngularParses(out);
  });

  it("emits track p for by=identity", () => {
    const out = emit("<for|p| of=people by=identity>${p}</for>");
    expect(out).toBe("@for (p of people; track p) { {{ p }} }");
    assertAngularParses(out);
  });

  it("rejects a non-unwrappable by=", () => {
    expect(() => emit("<for|p| of=people by=trackFn>${p}</for>")).toThrow(
      /Angular's `track` is an expression, not a function/,
    );
  });

  it("rejects a block-bodied arrow by= rather than slicing its statements verbatim", () => {
    // `by=(p => { return p.id })` sliced by a naive `/=>\s*.../` regex would
    // emit `track { return p.id }`, a parse error at ng build — a block has
    // no single expression to extract, so it must fall through to the
    // non-unwrappable rejection like any other unusable form.
    expect(() =>
      emit("<for|p| of=people by=(p => { return p.id })>${p}</for>"),
    ).toThrow(/Angular's `track` is an expression, not a function/);
  });

  it("emits the exact expression body for a non-trivial arrow, not a naive =>-split", () => {
    const out = emit('<for|p| of=people by=(p => p.id ?? "x")>${p}</for>');
    expect(out).toBe('@for (p of people; track p.id ?? "x") { {{ p }} }');
    assertAngularParses(out);
  });

  it("emits track p.id for a template-literal by= with no interpolation", () => {
    // Core classifies a plain `` `id` `` template literal as `shape:
    // "string"` too — the same as a real StringLiteral — but its `.node`
    // is a TemplateLiteral with no `.value`, so the naive `StringLiteral`
    // check plus a quote-strip regex previously left the backticks in,
    // emitting `track p.`id`` (a parse error at ng build).
    const out = emit("<for|p| of=people by=`id`>${p}</for>");
    expect(out).toBe("@for (p of people; track p.id) { {{ p }} }");
    assertAngularParses(out);
  });

  it("rejects a template-literal by= containing an interpolation", () => {
    expect(() => emit("<for|p| of=people by=`${p.a}id`>${p}</for>")).toThrow(
      /Angular's `track` is an expression, not a function/,
    );
  });

  it("emits the index alias as a let binding", () => {
    const out = emit("<for|p, i| of=people by=identity>${i}</for>");
    expect(out).toBe("@for (p of people; track p; let i = $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("rejects a destructured second (alias) param", () => {
    expect(() => emit("<for|p, {i}| of=people by=identity>${p}</for>")).toThrow(
      /second \(alias\) param must be a plain name/,
    );
  });

  it("warns once per file, not once per loop", () => {
    const { warnings } = compileMx(
      "<for|a| of=xs>${a}</for><for|b| of=ys>${b}</for>",
    );
    expect(warnings.filter((w) => w.message.includes("no `by=`"))).toHaveLength(
      1,
    );
  });
});

describe("For in", () => {
  it("emits the keyvalue pipe with a null comparator and a once-per-file warning", () => {
    const { code, warnings } = compileMx("<for|k, v| in=obj>${k}${v}</for>");
    expect(code).toBe(
      "@for (mxEntry of (obj | keyvalue: null); track mxEntry.key) { @let k = mxEntry.key; @let v = mxEntry.value; {{ k }}{{ v }} }",
    );
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "this template uses `<for in=>`, emitted with Angular's `keyvalue` pipe; add `KeyValuePipe` to the component's imports.",
    );
  });
});

describe("For range", () => {
  it("bakes a to= range including the bound", () => {
    const out = emit("<for|i| to=3>${i}</for>");
    expect(out).toBe("@for (i of [0, 1, 2, 3]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes an until= range excluding the bound", () => {
    const out = emit("<for|i| until=3>${i}</for>");
    expect(out).toBe("@for (i of [0, 1, 2]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes from/to/step", () => {
    const out = emit("<for|i| from=1 to=5 step=2>${i}</for>");
    expect(out).toBe("@for (i of [1, 3, 5]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes from/until/step", () => {
    const out = emit("<for|i| from=1 until=5 step=2>${i}</for>");
    expect(out).toBe("@for (i of [1, 3]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes a descending range", () => {
    const out = emit("<for|i| from=3 to=1 step=-1>${i}</for>");
    expect(out).toBe("@for (i of [3, 2, 1]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes a descending range with an exclusive (until=) bound", () => {
    const out = emit("<for|i| from=5 until=1 step=-2>${i}</for>");
    expect(out).toBe("@for (i of [5, 3]; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("bakes an empty range when unreachable, not an error", () => {
    const out = emit("<for|i| from=1 to=5 step=-1>${i}</for>");
    expect(out).toBe("@for (i of []; track $index) { {{ i }} }");
    assertAngularParses(out);
  });

  it("rejects step=0", () => {
    expect(() => emit("<for|i| from=1 to=5 step=0>${i}</for>")).toThrow(
      /step=0` never terminates/,
    );
  });

  it("rejects a non-literal bound", () => {
    expect(() => emit("<for|i| to=n>${i}</for>")).toThrow(
      /non-literal bound cannot be emitted/,
    );
  });

  it("does not drop the last values of a fractional step on an exclusive bound", () => {
    // `bound - 1`/`bound + 1` assumed an integer step of 1 — for
    // `step=0.5` that dropped the two values closest to the exclusive
    // bound (`until=2.2` with a `bound - 1 = 1.2` cutoff stopped at `1`
    // instead of `2`). A true `i < bound` comparison fixes it.
    const out = emit("<for|i| from=0 until=2.2 step=0.5>${i}</for>");
    expect(out).toBe(
      "@for (i of [0, 0.5, 1, 1.5, 2]; track $index) { {{ i }} }",
    );
    assertAngularParses(out);
  });

  it("rejects a range that would bake more than 1000 elements", () => {
    expect(() => emit("<for|i| from=0 to=50000>${i}</for>")).toThrow(
      /would bake .+ elements; bind an array instead/,
    );
  });
});

describe("For destructured params", () => {
  it("binds a non-renamed object destructure through a gensym'd row and @let", () => {
    const out = emit("<for|{id, name}| of=people>${id}${name}</for>");
    expect(out).toBe(
      "@for (mxRow of people; track $index) { @let id = mxRow.id; @let name = mxRow.name; {{ id }}{{ name }} }",
    );
    assertAngularParses(out);
  });

  it("gensyms past a body reference to `mxRow` (R-b)", () => {
    const out = emit("<for|{id}| of=people>${mxRow}${id}</for>");
    expect(out).toBe(
      "@for (mxRow1 of people; track $index) { @let id = mxRow1.id; {{ mxRow }}{{ id }} }",
    );
    assertAngularParses(out);
  });

  it("gensyms past a <const/mxRow=.../> declared before the loop (R-b)", () => {
    const out = emit("<const/mxRow=1/><for|{id}| of=people>${id}</for>");
    expect(out).toBe(
      "@let mxRow = 1;@for (mxRow1 of people; track $index) { @let id = mxRow1.id; {{ id }} }",
    );
    assertAngularParses(out);
  });

  it("gives two nested destructured <for>s' rows distinct names, not a shadow", () => {
    const out = emit("<for|{a}| of=xs><for|{b}| of=ys>${a}${b}</for></for>");
    expect(out).toBe(
      "@for (mxRow of xs; track $index) { @let a = mxRow.a; @for (mxRow1 of ys; track $index) { @let b = mxRow1.b; {{ a }}{{ b }} } }",
    );
    assertAngularParses(out);
  });

  it("gensyms past an outer <for|mxRow|> wrapping a destructured loop (R-b)", () => {
    const out = emit(
      "<for|mxRow| of=xs><for|{a}| of=ys>${a}${mxRow}</for></for>",
    );
    expect(out).toBe(
      "@for (mxRow of xs; track $index) { @for (mxRow1 of ys; track $index) { @let a = mxRow1.a; {{ a }}{{ mxRow }} } }",
    );
    assertAngularParses(out);
  });
});
