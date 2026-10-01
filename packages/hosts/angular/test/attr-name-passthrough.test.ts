import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

// Angular template syntax is the host's own vocabulary: the name check the
// other hosts apply (Marko's "Invalid attribute name.") must not reach it.
describe("Angular attribute-name passthrough", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', '[prop]="x"'],
    ["[attr.x]", '<div [attr.x]="y"/>', '[attr.x]="y"'],
    ["#ref", "<div #ref>hi</div>", "#ref"],
    ["*ngIf", '<div *ngIf="x">hi</div>', '*ngIf="x"'],
  ])("passes %s through to the template", (_name, source, expected) => {
    expect(emit(source, "x.ng.mx")).toContain(expected);
  });
});
