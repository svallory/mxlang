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

  it("keeps `on-<exact>` a plain property binding in the temporary passthrough", () => {
    // Round 1 regression guard (phase A of `dom-events`): core lowers
    // `on-my-event` to the new `event` kind, but this host's phase-A
    // passthrough must stay byte-identical to base — and base never matched
    // `on-` against `EVENT_NAME` (`/^on[A-Z]/` requires a capital, not a
    // dash), so it emitted a plain `[on-my-event]=` binding. Routing it
    // through `domEventName` emitted `(-my-event)="…"`, which is not valid
    // Angular. Phase B replaces this with `(my-event)=`.
    const out = emit("<div on-my-event=f>x</div>");
    expect(out).toBe('<div [on-my-event]="f">x</div>');
    assertAngularParses(out);
  });

  it("leaves a bare or string-valued `onClick` alone", () => {
    // The `event` kind is derived only for an expression value, so neither of
    // these reaches the event path: a bare `onClick` is a boolean attribute
    // and a string-valued one is an ordinary HTML attribute.
    expect(emit("<div onClick>x</div>")).toBe("<div onClick>x</div>");
    expect(emit('<div onClick="alert(1)">x</div>')).toBe(
      '<div onClick="alert(1)">x</div>',
    );
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

  it("rejects attr:/class:/style: modifiers as not Marko syntax (decision 86)", () => {
    expect(() => emit("<a attr:aria-label=l>x</a>")).toThrow(
      /attribute modifier `attr:aria-label` is not Marko syntax/,
    );
    expect(() => emit("<a class:on=c>x</a>")).toThrow(
      /attribute modifier `class:on` is not Marko syntax.*\[ngClass\]/,
    );
    expect(() => emit("<a style:width=w>x</a>")).toThrow(
      /attribute modifier `style:width` is not Marko syntax.*\[ngStyle\]/,
    );
  });

  it("binds a dynamic data-*/aria-* attribute as [attr.name]", () => {
    const out = emit("<div data-kind=k aria-label=l>x</div>");
    expect(out).toBe('<div [attr.data-kind]="k" [attr.aria-label]="l">x</div>');
    assertAngularParses(out);
  });

  it("keeps a static data-*/aria-* attribute as a plain attribute", () => {
    const out = emit('<div data-kind="ok">x</div>');
    expect(out).toBe('<div data-kind="ok">x</div>');
    assertAngularParses(out);
  });

  it("emits [ngClass] for an object-valued class, with a once-per-file warning matching A1:112 verbatim", () => {
    const { code, warnings } = compileMx("<div class={a: cond}>x</div>");
    expect(code).toBe('<div [ngClass]="{a: cond}">x</div>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "this template binds `class` to an object or array value, emitted as [ngClass]; add `NgClass` to the component's imports.",
    );
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

  it("emits [ngStyle] for an object-valued style, warning once, matching A1:113 verbatim", () => {
    const { code, warnings } = compileMx("<div style={color: c}>x</div>");
    expect(code).toBe('<div [ngStyle]="{color: c}">x</div>');
    assertAngularParses(code);
    expect(warnings[0]?.message).toBe(
      "this template binds `style` to an object value, emitted as [ngStyle]; add `NgStyle` to the component's imports.",
    );
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

  it("rejects an unknown attribute modifier prefix, without the data-*/aria-* detail", () => {
    expect(() => emit("<div prop:x=v>y</div>")).toThrow(
      "attribute modifier `prop:x` is not Marko syntax; MX has no attribute modifiers — write the attribute plainly (`x=`)",
    );
  });

  it("rejects a spread attribute", () => {
    expect(() => emit("<div ...attrs>x</div>")).toThrow(
      /spread attribute cannot be emitted/,
    );
  });
});
