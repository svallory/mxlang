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

  it("emits `on-<exact>` as an event binding from core's resolved name", () => {
    // Phase B of `dom-events` (decision 101): core lowers `on-my-event` to
    // the `event` kind carrying `event: "my-event"` verbatim, and Angular's
    // `(x)` can bind it — the phase-A `[on-my-event]=` passthrough is gone.
    const out = emit("<div on-my-event=f>x</div>");
    expect(out).toBe('<div (my-event)="(f)($event)">x</div>');
    assertAngularParses(out);
  });

  it("maps a lowercase expression `onclick=fn` to (click), per decision 101", () => {
    // A lowercase `onclick` is not event-shaped for the core kind (the
    // `/^on[A-Z-]/` gate keeps it `dynamic`), but decision 101 maps it on
    // this host instead of leaving a dead `[onclick]` property binding.
    const out = emit("<button onclick=handler>x</button>");
    expect(out).toBe('<button (click)="(handler)($event)">x</button>');
    assertAngularParses(out);
  });

  it("rejects on:/oncapture: with a fix-it naming `on-<exact>`", () => {
    expect(() => emit("<a on:click=f>x</a>")).toThrow(
      /`on:click=fn` is not MX syntax; write `onClick=fn`.*or `on-click=fn`/,
    );
    expect(() => emit("<a oncapture:click=f>x</a>")).toThrow(
      /`oncapture:click=fn` is not MX syntax; write `onClick=fn`/,
    );
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

  it("emits onDoubleClick as (doubleclick) with core's warning, never a rewrite", () => {
    // No aliases (decision 101 (c)): `onDoubleClick` lowercases to
    // `doubleclick`, which is not a DOM event; core warns at the attribute
    // name and the binding emits exactly what was written. The old
    // IRREGULAR_EVENTS table that rewrote this to `(dblclick)` is deleted.
    const { code, warnings } = compileMx(
      "<button onDoubleClick=handler>x</button>",
    );
    expect(code).toBe('<button (doubleclick)="(handler)($event)">x</button>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "`onDoubleClick` is not a DOM event; did you mean `onDblclick`",
    );
  });

  it("makes onDoubleClick, onDblClick and on-dblclick collapse except the warned one", () => {
    // Portability claim (design note §7): the two correct spellings emit
    // byte-identically; the React-trained spelling emits `(doubleclick)`
    // under the same warning the core pins.
    const { code, warnings } = compileMx(
      "<button onDblClick=a>x</button><button on-dblclick=b>y</button>",
    );
    expect(code).toBe(
      '<button (dblclick)="(a)($event)">x</button><button (dblclick)="(b)($event)">y</button>',
    );
    assertAngularParses(code);
    expect(warnings).toHaveLength(0);
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

describe("lowercase onclick mapping is native-element-only", () => {
  it("maps onclick=fn to (click) on a native element", () => {
    const out = emit("<button onclick=handler>x</button>");
    expect(out).toBe('<button (click)="(handler)($event)">x</button>');
    assertAngularParses(out);
  });

  it("keeps onclick=fn as the component's own [onclick] input", () => {
    // emitAttrs is shared between elements and component calls; the
    // lowercase mapping must not rewire a component's input into an output
    // binding (components have props; elements have events — the PR
    // body's claim, pinned).
    const out = emit("<UserCard onclick=handler/>");
    expect(out).toBe('<mx-user-card [onclick]="handler"></mx-user-card>');
    assertAngularParses(out);
  });
});
