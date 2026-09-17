import { parseTemplate } from "@angular/compiler";
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
      '<ng-template #Row let-a let-b="b"> {{ a }}{{ b }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: 1, b: 2 }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("binds every param after the first to its own context key, not $implicit", () => {
    // A bare `let-v` binds `$implicit`, so `k` and `v` would both receive the
    // first argument and `${v}` would read the key at runtime — invisible to
    // `ng build`, since a `let-` variable is implicitly `any`. Asserting the
    // parsed variable's `value` (rather than the emitted string alone) is what
    // pins the binding Angular actually performs.
    const out = emit("<define/Row|k, v|>${k}${v}</define>");
    expect(out).toBe(
      '<ng-template #Row let-k let-v="v"> {{ k }}{{ v }} </ng-template>',
    );

    assertAngularParses(out);
    const parsed = parseTemplate(out, "x.html");
    const variables = (
      parsed.nodes[0] as unknown as {
        variables: { name: string; value: string }[];
      }
    ).variables;
    expect(variables.map((v) => [v.name, v.value])).toEqual([
      // `$implicit` is what an empty `value` means to Angular.
      ["k", ""],
      ["v", "v"],
    ]);
  });

  it("invokes a define with no args", () => {
    const out = emit("<define/Empty>hi</define><Empty()/>");
    expect(out).toBe(
      '<ng-template #Empty> hi </ng-template><ng-container [ngTemplateOutlet]="Empty" [ngTemplateOutletContext]="{}"></ng-container>',
    );
    assertAngularParses(out);
  });
});
