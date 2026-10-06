import { describe, expect, it } from "vitest";
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
      '<div appPick [v]="q" (vChange)="q = fn($event)"></div>',
    );
    expect(emit("<div appPick is:raw:=x.y/>")).toBe(
      '<div appPick [is]="x.y" (isChange)="x.y = raw($event)"></div>',
    );
  });

  it("emits a template Angular parses", () => {
    assertAngularParses(emit("<div appPick v:fn:=q/>"));
  });

  it.each([
    ["<div v:no-update:=q/>", 1, 6],
    ["<div x::=q/>", 1, 6],
    ["<div a=1\n  v:no-update:=q/>", 2, 3],
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
