import { parseTemplate } from "@angular/compiler";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { assertAngularParses, emit } from "./helpers.ts";

/** The evaluated `ngTemplateOutletContext` of the first outlet in `template`. */
function outletContext(template: string): { $implicit: unknown } {
  const parsed = parseTemplate(template, "x.html");
  const container = parsed.nodes.find(
    (n) => (n as { name?: string }).name === "ng-container",
  ) as unknown as {
    inputs: Array<{ name: string; value: { source?: string } }>;
  };
  const input = container.inputs.find(
    (i) => i.name === "ngTemplateOutletContext",
  );
  return new Function(`return (${input?.value.source})`)();
}

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

describe("Define call attrs: static values reach the context verbatim", () => {
  const cases: Array<[string, string]> = [
    ["a single brace pair", "{x}"],
    ["a double brace pair", "{{x}}"],
    ["a JSON string", '{"k":"v"}'],
    ["an embedded quote", 'say "hi"'],
    ["an apostrophe", "it's"],
    ["a backslash", "a\\b"],
    ["an ampersand entity", "&amp; <b>"],
  ];
  for (const [label, value] of cases) {
    it(`keeps ${label} as authored`, () => {
      const out = emit(
        `<define/Row|{ a }|>\${a}</define><Row a=${JSON.stringify(value)}/>`,
      );
      assertAngularParses(out);
      expect(outletContext(out)).toEqual({ $implicit: { a: value } });
    });
  }

  it("keeps a brace-bearing quoted key as authored", () => {
    const out = emit(
      "<define/Row|{ 'd-e': f }|>${f}</define><Row d-e=\"{x}\"/>",
    );
    expect(outletContext(out)).toEqual({ $implicit: { "d-e": "{x}" } });
  });
});

describe("Define call attrs: bound attributes", () => {
  it("rejects a bound attribute with a positioned error", () => {
    expect(() => emit("<define/Row|{ n }|>${n}</define><Row n:=q/>")).toThrow(
      /a bound attribute \(`n:=`\) cannot be passed to `<Row>`/,
    );
  });

  it("rejects a refined bound attribute too", () => {
    expect(() =>
      emit("<define/Row|{ n }|>${n}</define><Row n:fn:=q/>"),
    ).toThrow(/a bound attribute \(`n:fn:=`\) cannot be passed to `<Row>`/);
  });
});

describe("Define: later params stay in scope after an expanded first param", () => {
  it("lets a refined bound attribute on a later param emit `i.set(…)`", () => {
    const out = emit(
      "<define/Row|{ n }, i|><div appPick v:fn:=i/>${n}</define><Row({n:1}, sig)/>",
    );
    expect(out).toContain('[v]="__mxGet(i)" (vChange)="i.set(fn($event))"');
    expect(out).toContain("i: sig");
    assertAngularParses(out);
  });

  it("scopes a destructured binding of the first param the same way", () => {
    const out = emit(
      "<define/Row|{ n }, i|><div appPick v:fn:=n/></define><Row({n:1}, sig)/>",
    );
    expect(out).toContain("n.set(");
  });
});

describe("Define: mappings", () => {
  const slices = (source: string) => {
    const r = compile(source, "x.mx");
    return r.mappings.map((m) => ({
      derive: m.derive,
      ctx: m.deriveContext,
      generated: r.code.slice(m.generatedStart, m.generatedEnd),
      source: source.slice(m.sourceStart, m.sourceEnd),
    }));
  };

  it("maps the expanded first param to `let-__mxArg` as a define-pattern derivation", () => {
    expect(
      slices("<define/Row|{ a, b }|>${a}</define><Row a=1 b=2/>"),
    ).toContainEqual({
      derive: "define-pattern",
      ctx: "__mxArg",
      generated: "let-__mxArg",
      source: "{ a, b }",
    });
  });

  it("maps a default expression to its own source text", () => {
    expect(slices("<define/Row|{ n = 5 }|>${n}</define><Row/>")).toContainEqual(
      expect.objectContaining({ generated: "5", source: "5" }),
    );
  });

  it("maps only the genuine name of a quoted key", () => {
    const pairs = slices("<define/Row|{ 'd-e': f }|>${f}</define><Row d-e=3/>");
    expect(pairs).toContainEqual(
      expect.objectContaining({ generated: "d-e", source: "d-e" }),
    );
    for (const p of pairs) {
      expect(p.generated).not.toContain("&quot;");
    }
  });
});
