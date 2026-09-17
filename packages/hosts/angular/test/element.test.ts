import { describe, expect, it } from "vitest";
import {
  angularAstSnapshot,
  assertAngularParses,
  compileMx,
  emit,
} from "./helpers.ts";

describe("Element", () => {
  it("emits a static attribute", () => {
    const out = emit('<div class="a">x</div>');
    expect(out).toBe('<div class="a">x</div>');
    assertAngularParses(out);
  });

  it("emits a boolean attribute", () => {
    const out = emit("<input disabled>");
    expect(out).toBe("<input disabled>");
    assertAngularParses(out);
  });

  it("emits a void element with no closing tag", () => {
    const out = emit("<br>");
    expect(out).toBe("<br>");
    assertAngularParses(out);
  });

  it("emits a dynamic property binding", () => {
    const out = emit("<a value=expr>x</a>");
    expect(out).toBe('<a [value]="expr">x</a>');
    assertAngularParses(out);
  });

  it("emits an event binding", () => {
    const out = emit("<button onClick=handler>x</button>");
    expect(out).toBe('<button (click)="(handler)($event)">x</button>');
    assertAngularParses(out);
  });

  it("parenthesises an arrow-function event handler so it is called, not returned", () => {
    const out = emit("<button onClick=(e => handle(e))>x</button>");
    expect(out).toBe('<button (click)="(e => handle(e))($event)">x</button>');
    assertAngularParses(out);
    expect(angularAstSnapshot(out)).toMatchObject([
      { outputs: [{ name: "click", handler: { ast: { receiver: {} } } }] },
    ]);
  });

  it("does not treat once=/onto= as events", () => {
    const out = emit("<div once=x onto=y>z</div>");
    expect(out).toBe('<div [once]="x" [onto]="y">z</div>');
    assertAngularParses(out);
  });

  it("maps onDoubleClick to the real DOM event name, not a lowercased camelCase", () => {
    // A plain `.toLowerCase()` of the MX attribute name gives `doubleclick`,
    // not the DOM event `dblclick` Angular's `(dblclick)` binds to.
    const out = emit("<button onDoubleClick=handler>x</button>");
    expect(out).toBe('<button (dblclick)="(handler)($event)">x</button>');
    assertAngularParses(out);
  });

  it("emits a two-way binding", () => {
    const out = emit("<input value:=w>");
    expect(out).toBe('<input [(value)]="w">');
    assertAngularParses(out);
  });

  it("emits attr:/class:/style: modifiers", () => {
    const out = emit("<a attr:aria-label=l class:on=c style:width=w>x</a>");
    expect(out).toBe(
      '<a [attr.aria-label]="l" [class.on]="c" [style.width]="w">x</a>',
    );
    assertAngularParses(out);
  });

  it("emits [ngClass] for an object-valued class, with a once-per-file warning", () => {
    const { code, warnings } = compileMx("<div class={a: cond}>x</div>");
    expect(code).toBe('<div [ngClass]="{a: cond}">x</div>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/\[ngClass\]/);
    expect(warnings[0]?.message).toMatch(/NgClass/);
  });

  it("emits [ngClass] for an array-valued class", () => {
    const out = emit('<div class=["a", cond && "b"]>x</div>');
    expect(out).toBe(
      '<div [ngClass]="[&quot;a&quot;, cond &amp;&amp; &quot;b&quot;]">x</div>',
    );
    assertAngularParses(out);
    expect(angularAstSnapshot(out)).toMatchObject([
      { inputs: [{ name: "ngClass" }] },
    ]);
  });

  it("emits [ngStyle] for an object-valued style, warning once", () => {
    const { code, warnings } = compileMx("<div style={color: c}>x</div>");
    expect(code).toBe('<div [ngStyle]="{color: c}">x</div>');
    assertAngularParses(code);
    expect(warnings[0]?.message).toMatch(/\[ngStyle\]/);
    expect(warnings[0]?.message).toMatch(/NgStyle/);
  });

  it("warns [ngClass]/[ngStyle] once per file, not once per use", () => {
    const { warnings } = compileMx(
      "<div class={a: 1}>x</div><div class={b: 2}>y</div>",
    );
    expect(warnings.filter((w) => w.message.includes("ngClass"))).toHaveLength(
      1,
    );
  });

  it("keeps [class]/[style] for a plain string value", () => {
    const out = emit("<div class=someExpr>x</div>");
    expect(out).toBe('<div [class]="someExpr">x</div>');
    assertAngularParses(out);
  });

  it("rejects an unknown attribute modifier prefix", () => {
    // A modifier this host never resolves reaches rejectModifier, not the
    // dynamic-attr `includes(":")` branch — but the branch's own guard is
    // exercised directly here via a name that already contains a colon.
    expect(() => emit("<div prop:x=v>y</div>")).toThrow(
      /attribute modifier `prop:x` is not supported by Angular/,
    );
  });

  it("rejects a spread attribute", () => {
    expect(() => emit("<div ...attrs>x</div>")).toThrow(
      /spread attribute cannot be emitted/,
    );
  });
});
