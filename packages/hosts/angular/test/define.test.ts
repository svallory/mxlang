import { describe, expect, it } from "vitest";
import { assertAngularParses, emit } from "./helpers.ts";

describe("Define", () => {
  it("emits an ng-template with a let- param", () => {
    const out = emit("<define/Row|x|>${x}</define>");
    expect(out).toBe("<ng-template #Row let-x> {{ x }} </ng-template>");
    assertAngularParses(out);
  });

  it("emits an ng-template with no params", () => {
    const out = emit("-- <define/Empty>hi</define>");
    expect(out).toBe("<ng-template #Empty> hi </ng-template>");
    assertAngularParses(out);
  });

  it("invokes a define via ngTemplateOutlet, mapping args by position", () => {
    const out = emit("<define/Row|a, b|>${a}${b}</define><Row(1, 2)/>");
    expect(out).toBe(
      '<ng-template #Row let-a let-b> {{ a }}{{ b }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: 1, b: 2 }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("invokes a define with no args", () => {
    const out = emit("<define/Empty>hi</define><Empty()/>");
    expect(out).toBe(
      '<ng-template #Empty> hi </ng-template><ng-container [ngTemplateOutlet]="Empty" [ngTemplateOutletContext]="{}"></ng-container>',
    );
    assertAngularParses(out);
  });
});
