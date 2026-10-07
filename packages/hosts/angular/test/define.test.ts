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

  it("rejects an attribute tag on a `<define>` call instead of silently dropping it", () => {
    // `ngTemplateOutletContext` is a positional argument object, not content
    // projection, so an attribute tag has nowhere to go — a positioned error
    // instead of the S8 silent-drop class.
    expect(() =>
      emit(
        '<define/Card|title, head|>${title}</define><Card title="a"><@head>H</@head></Card>',
      ),
    ).toThrow(
      /attribute tags on `<Card>` aren't supported by @mxlang\/angular/,
    );
  });
});

describe("Define call with attributes (decision 160)", () => {
  it("passes one attributes object to a plain first param", () => {
    const out = emit("<define/Row|p|>${p.n}</define><Row n=1/>");
    expect(out).toBe(
      '<ng-template #Row let-p> {{ p.n }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: { n: 1 } }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("expands a destructured first param into let- plus one @let per bound name", () => {
    const out = emit("<define/Row|{ n }|>${n}</define><Row n=1/>");
    expect(out).toBe(
      '<ng-template #Row let-__mxArg> @let n = __mxArg.n; {{ n }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: { n: 1 } }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("applies a default when the property reads undefined", () => {
    const out = emit("<define/Row|{ n = 3 }|>${n}</define><Row/>");
    expect(out).toBe(
      '<ng-template #Row let-__mxArg> @let n = __mxArg.n === undefined ? 3 : __mxArg.n; {{ n }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: {} }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("binds rename and quoted keys, and quotes non-identifier object keys", () => {
    const out = emit(
      "<define/Row|{ a, b: c, 'd-e': f }|>${c}${f}</define><Row a=1 b=2 d-e=3/>",
    );
    expect(out).toBe(
      '<ng-template #Row let-__mxArg> @let a = __mxArg.a; @let c = __mxArg.b; @let f = __mxArg["d-e"]; {{ c }}{{ f }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: { a: 1, b: 2, &quot;d-e&quot;: 3 } }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("params after the first stay named context keys, reading undefined", () => {
    const out = emit("<define/Row|{ n }, i|>${n}${i}</define><Row n=1/>");
    expect(out).toBe(
      '<ng-template #Row let-__mxArg let-i="i"> @let n = __mxArg.n; {{ n }}{{ i }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: { n: 1 } }"></ng-container>',
    );
    assertAngularParses(out);
    const parsed = parseTemplate(out, "x.html");
    const variables = (
      parsed.nodes[0] as unknown as {
        variables: { name: string; value: string }[];
      }
    ).variables;
    expect(variables.map((v) => [v.name, v.value])).toEqual([
      ["__mxArg", ""],
      ["i", "i"],
    ]);
  });

  it("a define with no params still ignores the attributes ({}, unchanged)", () => {
    const out = emit("<define/Row>hi</define><Row n=1/>");
    expect(out).toBe(
      '<ng-template #Row> hi </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{}"></ng-container>',
    );
  });

  it("the tag-arguments call shape is unchanged", () => {
    const out = emit("<define/Row|a, b|>${a}${b}</define><Row(1, 2)/>");
    expect(out).toBe(
      '<ng-template #Row let-a let-b="b"> {{ a }}{{ b }} </ng-template><ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: 1, b: 2 }"></ng-container>',
    );
  });

  it("maps each attribute value expression onto the .mx source", () => {
    const out = emit("<define/Row|p|>${p.n}</define><const/x=5/><Row n=x/>");
    expect(out).toContain("{ $implicit: { n: x } }");
  });

  it("rejects a spread attribute with a positioned error", () => {
    expect(() => emit("<define/Row|p|>${p.n}</define><Row ...o/>")).toThrow(
      /a spread attribute cannot be passed to `<Row>`/,
    );
  });

  it("rejects body content on a call whose define takes a param", () => {
    expect(() =>
      emit("<define/Row|p|>${p.n}</define><Row n=1>hi</Row>"),
    ).toThrow(/body content on `<Row>` isn't supported by @mxlang\/angular/);
  });

  it("rejects a rest element in the first param", () => {
    expect(() =>
      emit("<define/Row|{ n, ...r }|>${n}</define><Row n=1/>"),
    ).toThrow(/a rest element in `<define Row>'s first param/);
  });

  it("rejects a nested pattern in the first param", () => {
    expect(() =>
      emit("<define/Row|{ n: { m } }|>${n}</define><Row n=1/>"),
    ).toThrow(/a nested pattern in `<define Row>'s first param/);
  });

  it("rejects an array pattern in the first param", () => {
    expect(() => emit("<define/Row|[a, b]|>${a}</define><Row a=1/>")).toThrow(
      /is an array or unsupported pattern/,
    );
  });

  it("rejects a computed key in the first param", () => {
    expect(() =>
      emit("<define/Row|{ [k]: v }|>${v}</define><Row a=1/>"),
    ).toThrow(/a computed key in `<define Row>'s first param/);
  });
});
