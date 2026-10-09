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

  // Marko compiles `v:fn:=q?.a` with a nullish-guarded change handler; Angular
  // has no guarded write yet, so the refined form is refused at the attribute,
  // and the unrefined optional-chain target binds `[(v)]` as Marko's does.
  it("binds an optional-chain target as [(name)]", () => {
    expect(emit("<input value:=q?.a/>")).toBe('<input [(value)]="q?.a">');
  });

  it("refuses a refined optional-chain target at the attribute", () => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      emit("<input value:fn:=q?.a/>");
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line: 1, column: 7 });
    expect(error?.message).toBe(
      "a refined bound attribute (`v:fn:=q`) must be bound to a name or a member of one",
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

  // Angular's own `[(v)]="i"` on a `@for` index is a compile error ("Cannot use
  // a non-signal variable 'i' in a two-way binding expression"), so the refined
  // form is one too, at the attribute, decided from the IR scope the variable
  // was declared in: an index or a range number is never a signal.
  describe("a variable that is never a signal", () => {
    function failure(mx: string) {
      try {
        emit(mx);
      } catch (e) {
        return e as { message: string; line: number; column: number };
      }
      throw new Error("expected a compile error");
    }

    it("rejects a @for index at the attribute, naming the target and why", () => {
      const error = failure(
        "<for|item, i| of=items><div appPick v:fn:=i/></for>",
      );
      expect(error).toMatchObject({ line: 1, column: 36 });
      expect(error.message).toContain("`v:fn:=i`");
      expect(error.message).toContain("cannot write `i`");
      expect(error.message).toContain(
        "a `@for` index, which is never a signal",
      );
    });

    it("rejects the index under any name, and on a later line", () => {
      const error = failure(
        "<for|item, position| of=items>\n  <div appPick v:fn:=position/>\n</for>",
      );
      expect(error).toMatchObject({ line: 2, column: 15 });
      expect(error.message).toContain("cannot write `position`");
    });

    it("rejects a <for> range number", () => {
      const error = failure("<for|n| from=0 to=3><div appPick v:fn:=n/></for>");
      expect(error.message).toContain("a `<for>` range number");
    });

    it("decides by scope, not by name: `i` outside the loop is the component's", () => {
      expect(
        emit("<for|item, i| of=items><b/></for><div appPick v:fn:=i/>"),
      ).toContain(`(vChange)="__mxSet(this, 'i', fn($event))"`);
    });

    it("lets the innermost declaration win: a @let that shadows the index may hold a signal", () => {
      expect(
        emit(
          "<for|item, i| of=items><const/i=sig/><div appPick v:fn:=i/></for>",
        ),
      ).toContain(`(vChange)="i.set(fn($event))"`);
    });

    it("keeps a member of the index writable through the object", () => {
      expect(
        emit("<for|item, i| of=items><div appPick v:fn:=i.v/></for>"),
      ).toContain(`(vChange)="__mxSet(i, 'v', fn($event))"`);
    });

    it("keeps today's .set() for variables that can hold a signal", () => {
      for (const mx of [
        "<for|s| of=sigs><div appPick v:fn:=s/></for>",
        "<for|k, val| in=obj><div appPick v:fn:=val/></for>",
        "<const/x=sig/><div appPick v:fn:=x/>",
      ]) {
        expect(emit(mx)).toContain(".set(fn($event))");
      }
    });
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
