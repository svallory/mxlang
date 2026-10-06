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

  it("maps the refinement to the modifier's authored span", () => {
    const source = "<div appPick v:fn:=q.r/>";
    const result = compile(source, "x.mx");
    const pairs = result.mappings.map((mapping) => [
      result.code.slice(mapping.generatedStart, mapping.generatedEnd),
      source.slice(mapping.sourceStart, mapping.sourceEnd),
    ]);
    expect(pairs).toContainEqual(["fn", "fn"]);
    expect(pairs).toContainEqual(["vChange", "v:fn"]);
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
