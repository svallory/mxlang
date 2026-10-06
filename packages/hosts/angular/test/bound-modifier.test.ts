import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { assertAngularParses, emit } from "./helpers.ts";

describe("a bound attribute's refinement (angular)", () => {
  it("keeps [(name)] byte for byte when there is no refinement", () => {
    expect(emit("<input value:=q/>")).toBe('<input [(value)]="q">');
    expect(emit("<div appPick v:=q.r/>")).toBe(
      '<div appPick [(v)]="q.r"></div>',
    );
  });

  it("writes a refinement as its two halves, so the handler runs `q = fn(next)`", () => {
    expect(emit("<div appPick v:fn:=q/>")).toBe(
      `<div appPick [v]="__mxGet(q)" (vChange)="__mxSet(this, 'q', fn($event))"></div>`,
    );
    expect(emit("<div appPick is:raw:=x.y/>")).toBe(
      `<div appPick [is]="__mxGet(x.y)" (isChange)="__mxSet(x, 'y', raw($event))"></div>`,
    );
    expect(emit("<div appPick v:fn:=x[i]/>")).toBe(
      `<div appPick [v]="__mxGet(x[i])" (vChange)="__mxSet(x, i, fn($event))"></div>`,
    );
  });

  // A template variable is never written as `this.<name>`: Angular's own
  // `[(v)]="item"` writes it with `.set()` and accepts only a signal there.
  it.each([
    [
      "a @for item",
      "<for|item| of=items><div appPick v:fn:=item/></for>",
      `@for (item of items; track $index) { <div appPick [v]="__mxGet(item)" (vChange)="item.set(fn($event))"></div> }`,
    ],
    [
      "a @for index",
      "<for|item, i| of=items><div appPick v:fn:=i/></for>",
      `@for (item of items; track $index; let i = $index) { <div appPick [v]="__mxGet(i)" (vChange)="i.set(fn($event))"></div> }`,
    ],
    [
      "a destructured @for field",
      "<for|{v}| of=objs><div appPick v:fn:=v/></for>",
      `@for (__mxRow of objs; track $index) { @let v = __mxRow.v; <div appPick [v]="__mxGet(v)" (vChange)="v.set(fn($event))"></div> }`,
    ],
    [
      "a <for in> value",
      "<for|k, val| in=obj><div appPick v:fn:=val/></for>",
      `@for (__mxEntry of (obj | keyvalue: null); track __mxEntry.key) { @let k = __mxEntry.key; @let val = __mxEntry.value; <div appPick [v]="__mxGet(val)" (vChange)="val.set(fn($event))"></div> }`,
    ],
    [
      "a <const> @let",
      "<const/x=q/><div appPick v:fn:=x/>",
      `@let x = q;<div appPick [v]="__mxGet(x)" (vChange)="x.set(fn($event))"></div>`,
    ],
  ])("writes %s with .set(), not this.<name>", (_name, mx, out) => {
    expect(emit(mx)).toBe(out);
  });

  it("scopes a template variable to its block", () => {
    // `x` is a `@let` inside the `@if` only; outside it, `x` is the component's.
    expect(emit("<if=c><const/x=q/></if><div appPick v:fn:=x/>")).toContain(
      `(vChange)="__mxSet(this, 'x', fn($event))"`,
    );
    // After the loop, `item` is the component's field again.
    expect(
      emit("<for|item| of=items><b/></for><div appPick v:fn:=item/>"),
    ).toContain(`(vChange)="__mxSet(this, 'item', fn($event))"`);
  });

  it("writes a member of a template variable through the object", () => {
    expect(
      emit("<for|item| of=items><div appPick v:fn:=item.v/></for>"),
    ).toContain(`(vChange)="__mxSet(item, 'v', fn($event))"`);
  });

  it("maps the refinement to the modifier's authored span", () => {
    const source = "<div appPick v:fn:=q.r/>";
    const result = compile(source, "x.mx");
    const pairs = result.mappings.map((mapping) => [
      result.code.slice(mapping.generatedStart, mapping.generatedEnd),
      source.slice(mapping.sourceStart, mapping.sourceEnd),
    ]);
    expect(pairs).toContainEqual(["fn", "fn"]);
    expect(pairs).toContainEqual(["vChange", "v"]);
    expect(pairs).toContainEqual(["v", "v"]);
    // `($event)` maps to the modifier too, so an ill-typed `fn` lands there.
    expect(pairs).toContainEqual(["($event)", "fn"]);
  });

  it("rejects a refinement Angular's expression language cannot read, at the modifier", () => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      emit("<div appPick v:ünï:=q/>");
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line: 1, column: 15 });
    expect(error?.message).toContain("reads only ASCII identifiers");
  });

  it("emits a template Angular parses", () => {
    assertAngularParses(emit("<div appPick v:fn:=q/>"));
  });

  it.each([
    ["<div v:no-update:=q/>", 1, 7],
    ["<div x::=q/>", 1, 7],
    ["<div a=1\n  v:no-update:=q/>", 2, 4],
  ])(
    "a refinement that is no identifier is Marko's error: %j",
    (source, line, column) => {
      let error: { message: string; line: number; column: number } | undefined;
      try {
        emit(source);
      } catch (e) {
        error = e as typeof error;
      }
      expect(error).toMatchObject({ line, column });
      expect(error?.message).toBe(
        "Bound attribute refinement shorthand must be a valid JavaScript identifier.",
      );
    },
  );
});
