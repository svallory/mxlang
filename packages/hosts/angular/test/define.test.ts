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

  it("rejects body content on a `<define>` call instead of silently dropping it", () => {
    // `ngTemplateOutletContext` carries positional arguments only; unlike
    // Marko, which appends a trailing `{ content }` object, Angular has no
    // channel for the body — a positioned error, not the silent-drop class.
    try {
      emit("<define/Row|a|>${a}</define>\n<Row(1)>body</Row>");
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "body content on `<Row>` isn't supported by @mxlang/host-angular",
      );
      expect((error as Error).message).toContain(
        "pass the value as a tag argument instead",
      );
      // The call tag itself, second line, column 0.
      expect((error as { line?: number }).line).toBe(2);
      expect((error as { column?: number }).column).toBe(0);
    }
  });

  it("rejects a no-argument call's body content at the call tag", () => {
    try {
      emit("-- <define/Empty>hi</define>\n\n<Empty()>fallback</Empty>");
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "body content on `<Empty>` isn't supported by @mxlang/host-angular",
      );
      expect((error as { line?: number }).line).toBe(3);
      expect((error as { column?: number }).column).toBe(0);
    }
  });

  it("compiles a call with an empty body exactly like the self-closing form", () => {
    // `<Row(1)></Row>` has no content (decision 141 keeps `content: null`),
    // so the empty closing form must keep compiling, byte-identical.
    const closed = emit("<define/Row|a|>${a}</define><Row(1)></Row>");
    const selfClosed = emit("<define/Row|a|>${a}</define><Row(1)/>");
    expect(closed).toBe(selfClosed);
    expect(closed).toBe(
      '<ng-template #Row let-a> {{ a }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: 1 }"></ng-container>',
    );
    assertAngularParses(closed);
  });

  it("rejects an attribute tag on a `<define>` call instead of silently dropping it", () => {
    // `ngTemplateOutletContext` is a positional argument object, not content
    // projection, so an attribute tag has nowhere to go — a positioned error
    // instead of the S8 silent-drop class.
    expect(() =>
      emit(
        '<define/Card|title, head|>${title}</define><Card title="a"><@head>H</@head></Card>',
      ),
    ).toThrow(
      /attribute tags on `<Card>` aren't supported by @mxlang\/host-angular/,
    );
  });
});
