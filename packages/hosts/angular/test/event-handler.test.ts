import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { EVENT_HELPER_MEMBERS } from "../src/emitter.ts";
import { compile } from "../src/index.ts";
import { assertAngularParses, compileMx, emit } from "./helpers.ts";

// angular-event-handler-arity (option D). Marko 6.3.51 types a handler
// `(event, target) => unknown` and calls `handler(event, target)`, so a 0-arg
// `onClick=cancel` is valid there; `(cancel)($event)` is TS2554 under
// strictTemplates. The emit goes through typed invoker members on the
// component (`__mxOn` / `__mxOnAt`); these tests take MX source, emit it, and
// check the emitted template with ngtsc strictTemplates (and, for semantics,
// against a model of Angular's listener).

const checkerProject = resolve(
  import.meta.dirname,
  "../../../tooling/angular-checker",
);

const MEMBERS = EVENT_HELPER_MEMBERS.join("\n");

const CLASS_BODY = `
${MEMBERS}
  svc = {
    zero(): void {},
    one(e: MouseEvent): void {},
    two(e: MouseEvent, el: EventTarget | null): void {},
  };
  optSvc: { opt?: () => void } = {};
  cond = true as boolean;
  nul: null = null;
  undef: undefined = undefined;
  maybeFn: (() => void) | undefined = undefined;
  list = [this.svc];
  i = 0;
  maybe: { zero(): void } | undefined = undefined;
  mk() { return this.svc; }
  zero(): void {}
  one(e: MouseEvent): void {}
  two(e: MouseEvent, el: EventTarget | null): void {}
  keyboard(e: KeyboardEvent): void {}
  ret(): boolean { return false; }
  f(): void {}
  onPick(s: string): void {}
  onPickNumber(n: number): void {}
  onSubmit(e: Event): void {}
  submitZero(): void {}
`;

const SUPPORT = `
@Directive({ selector: "[appPick]", standalone: true })
export class Pick { @Output() picked = new EventEmitter<string>(); }
@Directive({ selector: "form[appForm]", standalone: true })
export class FormLike { @Output() ngSubmit = new EventEmitter<Event>(); }
`;

type Host = "standalone" | "module";

/** ngtsc + strictTemplates diagnostics for `template` inside `Probe`. */
function check(template: string, host: Host): string[] {
  const used = [
    template.includes("appPick") ? "Pick" : "",
    template.includes("appForm") ? "FormLike" : "",
  ].filter(Boolean);
  const head = `import { Component, Directive, EventEmitter, NgModule, Output } from "@angular/core";
${SUPPORT}`;
  const source =
    host === "standalone"
      ? `${head}
@Component({ selector: "mx-probe", standalone: true, imports: [${used.join(", ")}], template: \`${template}\` })
export class Probe {${CLASS_BODY}}
`
      : `${head}
@Component({ selector: "mx-probe", standalone: false, template: \`${template}\` })
export class Probe {${CLASS_BODY}}
@NgModule({ declarations: [Probe], imports: [${used.join(", ")}] })
export class ProbeModule {}
`;
  const checker = createAngularChecker({ projectDir: checkerProject });
  const diagnostics = checker.check(
    join(checkerProject, `event-handler-${host}.component.ts`),
    source,
  );
  checker.dispose();
  return diagnostics.map((d) => `${d.code} ${d.message.split("\n")[0]}`);
}

function emitted(mx: string): string {
  const out = emit(mx);
  assertAngularParses(out);
  return out;
}

const HOSTS: Host[] = ["standalone", "module"];

const CLEAN: [string, string][] = [
  ["0-arg method ref", "<button onClick=zero>x</button>"],
  ["1-arg method ref", "<button onClick=one>x</button>"],
  ["2-arg (event, element) method ref", "<button onClick=two>x</button>"],
  ["member ref svc.zero", "<button onClick=svc.zero>x</button>"],
  ["member ref svc.one", "<button onClick=svc.one>x</button>"],
  ["member ref svc.two", "<button onClick=svc.two>x</button>"],
  ["call-result receiver mk().zero", "<button onClick=mk().zero>x</button>"],
  ["indexed receiver list[i].one", "<button onClick=list[i].one>x</button>"],
  ["this.m", "<button onClick=this.zero>x</button>"],
  [
    "a conditional handler (cond && fn)",
    "<button onClick=(cond && zero)>x</button>",
  ],
  ["a possibly-undefined handler", "<button onClick=maybeFn>x</button>"],
  ["a null handler", "<button onClick=nul>x</button>"],
  ["an undefined handler", "<button onClick=undef>x</button>"],
  ["an optional member handler", "<button onClick=optSvc.opt>x</button>"],
  ["inline arrow, 0 params", "<button onClick=(() => f())>x</button>"],
  ["inline arrow, 1 param", "<button onClick=(e => one(e))>x</button>"],
  [
    "inline arrow, 2 params",
    "<button onClick=((e, el) => two(e, el))>x</button>",
  ],
  ["lowercase onclick=", "<button onclick=zero>x</button>"],
  ["on-click=", "<button on-click=zero>x</button>"],
  [
    "on-ngSubmit (a directive output typed Event)",
    "<form appForm on-ngSubmit=onSubmit>x</form>",
  ],
  [
    "on-ngSubmit, 0-arg handler",
    "<form appForm on-ngSubmit=submitZero>x</form>",
  ],
  [
    "a custom @Output with a string payload",
    "<div appPick on-picked=onPick>x</div>",
  ],
];

describe.each(HOSTS)("strictTemplates, %s component", (host) => {
  for (const [name, mx] of CLEAN) {
    it(`accepts ${name}`, () => {
      expect(check(emitted(mx), host)).toEqual([]);
    });
  }

  it("still rejects a KeyboardEvent handler on click", () => {
    expect(check(emitted("<button onClick=keyboard>x</button>"), host)).toEqual(
      [expect.stringMatching(/^2345 /)],
    );
  });

  it("still rejects a wrong event type behind a falsy guard", () => {
    expect(
      check(emitted("<button onClick=(cond && keyboard)>x</button>"), host),
    ).toEqual([expect.stringMatching(/^2345 /)]);
  });

  it("still rejects a handler of the wrong custom-output payload type", () => {
    expect(
      check(emitted("<div appPick on-picked=onPickNumber>x</div>"), host),
    ).toEqual([expect.stringMatching(/^2345 /)]);
  });
});

describe("a page component that lacks the invoker members", () => {
  // Contract behind the header/warning advice: strict AOT reports the miss at
  // build time (TS2339), including handlers nested in @for, so it never
  // reaches run time.
  function checkWithoutMembers(template: string): string[] {
    const source = `import { Component } from "@angular/core";
@Component({ selector: "mx-probe", standalone: true, template: \`${template}\` })
export class Probe { items = [1]; svc = { zero(): void {} }; zero(): void {} }
`;
    const checker = createAngularChecker({ projectDir: checkerProject });
    const diagnostics = checker.check(
      join(checkerProject, "event-handler-missing.component.ts"),
      source,
    );
    checker.dispose();
    return diagnostics.map((d) => `${d.code} ${d.message.split("\n")[0]}`);
  }

  it("fails strictTemplates with TS2339 naming __mxOn", () => {
    expect(
      checkWithoutMembers(emitted("<button onClick=zero>x</button>")),
    ).toEqual(["2339 Property '__mxOn' does not exist on type 'Probe'."]);
  });

  it("fails with TS2339 naming __mxOnAt for a member handler", () => {
    expect(
      checkWithoutMembers(emitted("<button onClick=svc.zero>x</button>")),
    ).toEqual(["2339 Property '__mxOnAt' does not exist on type 'Probe'."]);
  });

  it("fails for a handler nested in a @for block", () => {
    const template = emitted(
      "<ul><for|i| of=items by=(i => i)><li onClick=zero>${i}</li></for></ul>",
    );
    expect(checkWithoutMembers(template)).toEqual([
      "2339 Property '__mxOn' does not exist on type 'Probe'.",
    ]);
  });
});

describe("mappings", () => {
  it("map the object of a member handler to its own source text", () => {
    const source = "<button onClick=svc.cancel>x</button>";
    const { code, mappings } = compile(source, "x.mx");
    const slices = mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]);
    expect(slices).toContainEqual(["svc", "svc"]);
  });
});

describe("emitted shape", () => {
  it("routes a bare name through __mxOn with the component as receiver", () => {
    expect(emitted("<button onClick=zero>x</button>")).toBe(
      '<button (click)="__mxOn(zero, this, $event)">x</button>',
    );
  });

  it("routes a member expression through __mxOnAt so the object is evaluated once", () => {
    expect(emitted("<button onClick=svc.zero>x</button>")).toBe(
      "<button (click)=\"__mxOnAt(svc, 'zero', $event)\">x</button>",
    );
    expect(emitted("<button onClick=mk().zero>x</button>")).toBe(
      "<button (click)=\"__mxOnAt(mk(), 'zero', $event)\">x</button>",
    );
    expect(emitted("<button onClick=list[i].one>x</button>")).toBe(
      "<button (click)=\"__mxOnAt(list[i], 'one', $event)\">x</button>",
    );
    expect(emitted("<button onClick=this.zero>x</button>")).toBe(
      "<button (click)=\"__mxOnAt(this, 'zero', $event)\">x</button>",
    );
    expect(emitted("<button onClick=maybe!.zero>x</button>")).toBe(
      "<button (click)=\"__mxOnAt(maybe!, 'zero', $event)\">x</button>",
    );
  });

  it("keeps `a?.b` as one value (its short-circuit) with no receiver", () => {
    expect(emitted("<button onClick=maybe?.zero>x</button>")).toBe(
      '<button (click)="__mxOn(maybe?.zero, null, $event)">x</button>',
    );
  });

  it("routes an inline arrow through __mxOn, contextually typed by $event", () => {
    expect(emitted("<button onClick=(e => one(e))>x</button>")).toBe(
      '<button (click)="__mxOn(e => one(e), null, $event)">x</button>',
    );
  });

  it("warns once, coded as event-helper advice, to add the members to a page's class", () => {
    const { warnings } = compileMx(
      "<button onClick=a>x</button><button onClick=b>y</button>",
    ) as { warnings: { message: string; code?: string }[] };
    const advice = warnings.filter((w) => w.message.includes("__mxOn"));
    expect(advice).toHaveLength(1);
    expect(advice[0]?.code).toBe("angular.event-helper-advice");
  });
});

// A model of Angular's listener: a template expression runs against the
// component instance, a bare name is an unbound property read, a bare call is
// `ctx.f(x)` (this === ctx), `this` is the component, and the listener returns
// the expression's value (Angular calls preventDefault() on `false`). `with`
// models exactly that for these shapes. The component is a real class built
// from the emitted invoker members, transpiled from TypeScript.
function component(extra: Record<string, unknown>): Record<string, unknown> {
  const js = ts.transpileModule(`class Ctx {\n${MEMBERS}\n}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const Ctx = new Function(`${js}; return Ctx;`)() as new () => object;
  return Object.assign(new Ctx(), extra) as Record<string, unknown>;
}

function listener(
  template: string,
): (ctx: Record<string, unknown>, ev: unknown) => unknown {
  const expr = /\(click\)="([^"]*)"/.exec(template)?.[1];
  if (!expr) throw new Error(`no (click) binding in ${template}`);
  const decoded = expr
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    // The TypeScript non-null `!` is Angular template syntax the JS model
    // cannot parse; it has no run-time effect.
    .replace(/(\w)!(?=[.,)])/g, "$1");
  const fn = new Function(
    "ctx",
    "$event",
    `with (ctx) { return (${decoded}); }`,
  );
  return (ctx, ev) => fn.call(ctx, ctx, ev);
}

function click(mx: string, ctx: Record<string, unknown>, ev: unknown): unknown {
  return listener(emitted(mx))(ctx, ev);
}

describe("handler semantics", () => {
  const el = { tagName: "BUTTON" };
  const ev = { type: "click", currentTarget: el };

  it("calls the handler with exactly (event, element)", () => {
    const seen: unknown[][] = [];
    const ctx = component({
      two(...args: unknown[]) {
        seen.push(args);
      },
    });
    click("<button onClick=two>x</button>", ctx, ev);
    expect(seen).toEqual([[ev, el]]);
    expect(seen[0]).toHaveLength(2);
  });

  it("passes null as the element for a payload with no currentTarget", () => {
    const seen: unknown[][] = [];
    const ctx = component({
      onPick(...args: unknown[]) {
        seen.push(args);
      },
    });
    click("<button onClick=onPick>x</button>", ctx, "a-string-payload");
    expect(seen).toEqual([["a-string-payload", null]]);
  });

  it("binds `this` to the component for a bare method ref", () => {
    const seen: unknown[] = [];
    const ctx = component({
      rec(this: unknown) {
        seen.push(this);
      },
    });
    click("<button onClick=rec>x</button>", ctx, ev);
    expect(seen).toEqual([ctx]);
  });

  it("binds `this` to the object of svc.m", () => {
    const seen: unknown[] = [];
    const svc = {
      rec(this: unknown) {
        seen.push(this);
      },
    };
    click("<button onClick=svc.rec>x</button>", component({ svc }), ev);
    expect(seen).toEqual([svc]);
  });

  it("binds `this` to the object of this.m", () => {
    const seen: unknown[] = [];
    const ctx = component({
      rec(this: unknown) {
        seen.push(this);
      },
    });
    click("<button onClick=this.rec>x</button>", ctx, ev);
    expect(seen).toEqual([ctx]);
  });

  it("evaluates a call-result receiver a().b once and binds it", () => {
    const seen: unknown[] = [];
    let calls = 0;
    const made = {
      rec(this: unknown) {
        seen.push(this);
      },
    };
    const ctx = component({
      mk() {
        calls++;
        return calls === 1 ? made : { rec: () => seen.push("second object") };
      },
    });
    click("<button onClick=mk().rec>x</button>", ctx, ev);
    expect(calls).toBe(1);
    expect(seen).toEqual([made]);
  });

  it("binds a[i].b to a[i], evaluating the index once", () => {
    const seen: unknown[] = [];
    let reads = 0;
    const first = {
      rec(this: unknown) {
        seen.push(this);
      },
    };
    const ctx = component({
      list: [first],
      get i() {
        reads++;
        return 0;
      },
    });
    click("<button onClick=list[i].rec>x</button>", ctx, ev);
    expect(reads).toBe(1);
    expect(seen).toEqual([first]);
  });

  it("binds a!.b to a", () => {
    const seen: unknown[] = [];
    const maybe = {
      rec(this: unknown) {
        seen.push(this);
      },
    };
    click("<button onClick=maybe!.rec>x</button>", component({ maybe }), ev);
    expect(seen).toEqual([maybe]);
  });

  // Marko dispatches `handler?.(ev, target)`: a falsy handler is a no-op.
  it.each([
    [
      "cond && fn with cond false",
      "(cond && fn)",
      { cond: false, fn: () => 1 },
    ],
    ["null", "nul", { nul: null }],
    ["undefined", "undef", { undef: undefined }],
    ["false", "no", { no: false }],
  ])("treats a falsy handler as a no-op: %s", (_n, expr, props) => {
    const ctx = component(props);
    expect(click(`<button onClick=${expr}>x</button>`, ctx, ev)).toBe(
      undefined,
    );
  });

  it("treats a falsy member handler as a no-op", () => {
    const ctx = component({ svc: {} });
    expect(click("<button onClick=svc.missing>x</button>", ctx, ev)).toBe(
      undefined,
    );
  });

  it("still calls a truthy conditional handler", () => {
    const seen: unknown[] = [];
    const ctx = component({ cond: true, fn: (e: unknown) => seen.push(e) });
    click("<button onClick=(cond && fn)>x</button>", ctx, ev);
    expect(seen).toEqual([ev]);
  });

  it("passes the handler's return value through (false reaches Angular)", () => {
    const ctx = component({ ret: () => false });
    expect(click("<button onClick=ret>x</button>", ctx, ev)).toBe(false);
    const svcCtx = component({ svc: { ret: () => false } });
    expect(click("<button onClick=svc.ret>x</button>", svcCtx, ev)).toBe(false);
  });

  it("passes an arrow handler's return value and event through", () => {
    const ctx = component({ g: (e: unknown) => e === ev });
    expect(click("<button onClick=(e => g(e))>x</button>", ctx, ev)).toBe(true);
  });
});
