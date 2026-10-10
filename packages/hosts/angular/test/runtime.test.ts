import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { EVENT_HELPER_MEMBERS } from "../src/emitter.ts";
import { MxHandlers, MxHandlersMixin } from "../src/runtime.ts";
import { assertAngularParses, emit } from "./helpers.ts";

// angular-handlers-base. `@mxlang/host-angular/runtime` is a zero-import subpath
// carrying the two event invoker members (`__mxOn` / `__mxOnAt`) so a
// hand-written component can extend them instead of pasting them. These tests
// cover the module's behaviour, its shape (zero imports, in source and in the
// built output), and that both adoption paths — paste and base class — pass
// strict AOT (ngtsc, strictTemplates) on the template MX emits.

const pkgDir = resolve(import.meta.dirname, "..");
const checkerProject = resolve(pkgDir, "../../tooling/angular-checker");
const runtimeSource = readFileSync(join(pkgDir, "src/runtime.ts"), "utf8");

/** `code` without comments, so prose (a TSDoc example) is not read as an import. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Module specifiers a source text imports or re-exports from, or requires. */
function specifiersOf(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ]) {
    for (const match of code.matchAll(re)) found.push(match[1] as string);
  }
  return found;
}

describe("the runtime module's shape", () => {
  it("has no imports in its source", () => {
    expect(specifiersOf(runtimeSource)).toEqual([]);
  });

  it("is exported from package.json as ./runtime, types first", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    expect(pkg.exports["./runtime"]).toEqual({
      types: "./dist/runtime.d.ts",
      default: "./dist/runtime.js",
    });
    // The root entry is untouched.
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
  });

  it("marks the members @internal", () => {
    expect(runtimeSource).toMatch(/@internal[\s\S]*__mxOn\b/);
    expect(runtimeSource).toMatch(/@internal[\s\S]*__mxOnAt\b/);
  });

  // Needs `bun run build` first, like the other dist-resolving suites.
  describe("built output", () => {
    const built = (name: string) => join(pkgDir, "dist", name);

    it("emits runtime.js and runtime.d.ts", () => {
      expect(existsSync(built("runtime.js"))).toBe(true);
      expect(existsSync(built("runtime.d.ts"))).toBe(true);
    });

    it("imports nothing: no node:, compiler, or other @mxlang module", () => {
      for (const name of ["runtime.js", "runtime.d.ts"]) {
        const code = withoutComments(readFileSync(built(name), "utf8"));
        expect(specifiersOf(code), name).toEqual([]);
        expect(code, name).not.toMatch(/\bnode:/);
        expect(code, name).not.toMatch(/@marko|@mxlang|@angular/);
      }
    });

    it("exports MxHandlers and MxHandlersMixin, and nothing that needs Node", async () => {
      const mod = await import(built("runtime.js"));
      expect(Object.keys(mod).sort()).toEqual([
        "MxHandlers",
        "MxHandlersMixin",
      ]);
    });

    it("keeps the members public in the declarations (no TS4094 under declaration: true)", () => {
      const dts = withoutComments(readFileSync(built("runtime.d.ts"), "utf8"));
      expect(dts).not.toMatch(/\b(protected|private)\b/);
      expect(dts).toContain("__mxOn");
      expect(dts).toContain("__mxOnAt");
    });
  });
});

describe("MxHandlers", () => {
  const target = { tag: "button" } as unknown as EventTarget;

  it("__mxOn calls the handler with the receiver as this, and (event, currentTarget)", () => {
    const calls: unknown[][] = [];
    const receiver = { name: "r" };
    function handler(this: unknown, ...args: unknown[]) {
      calls.push([this, ...args]);
      return "ret";
    }
    const event = { currentTarget: target };
    const result = new MxHandlers().__mxOn(handler, receiver, event);
    expect(result).toBe("ret");
    expect(calls).toEqual([[receiver, event, target]]);
  });

  it("__mxOn passes null as the element when the event has none", () => {
    const seen: unknown[] = [];
    const on = new MxHandlers().__mxOn;
    on((_e: unknown, el: EventTarget | null) => seen.push(el), null, {});
    on((_e: unknown, el: EventTarget | null) => seen.push(el), null, null);
    expect(seen).toEqual([null, null]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false as const],
  ])("__mxOn is a no-op for a %s handler", (_name, handler) => {
    expect(new MxHandlers().__mxOn(handler, null, {})).toBeUndefined();
  });

  it("__mxOn is an own property, so a detached call keeps working", () => {
    const { __mxOn } = new MxHandlers();
    expect(__mxOn(() => 1, null, {})).toBe(1);
  });

  it("__mxOnAt reads the handler off the object and keeps the object as this", () => {
    const object = {
      n: 7,
      get(this: { n: number }, _e: unknown) {
        return this.n;
      },
    };
    expect(new MxHandlers().__mxOnAt(object, "get", {})).toBe(7);
  });

  it("__mxOnAt is a no-op when the member is missing or falsy", () => {
    const at = new MxHandlers().__mxOnAt;
    expect(at({} as { k?: () => void }, "k", {})).toBeUndefined();
    expect(
      at({ k: null } as { k?: (() => void) | null }, "k", {}),
    ).toBeUndefined();
  });

  it("__mxOnAt goes through this.__mxOn, so overriding __mxOn is honoured", () => {
    class Spy extends MxHandlers {
      seen = 0;
      override readonly __mxOn = (() => {
        this.seen++;
        return undefined;
      }) as MxHandlers["__mxOn"];
    }
    const spy = new Spy();
    spy.__mxOnAt({ f: () => 1 }, "f", {});
    expect(spy.seen).toBe(1);
  });
});

describe("MxHandlersMixin", () => {
  class Base {
    constructor(
      public readonly a: number,
      public readonly b: string,
    ) {}
    hello() {
      return `hi ${this.a}${this.b}`;
    }
  }

  it("keeps the base class: constructor arguments, methods, instanceof", () => {
    const Mixed = MxHandlersMixin(Base);
    const mixed = new Mixed(1, "x");
    expect(mixed.hello()).toBe("hi 1x");
    expect(mixed).toBeInstanceOf(Base);
    expect(mixed.a).toBe(1);
  });

  it("adds both members with MxHandlers' behaviour", () => {
    const mixed = new (MxHandlersMixin(Base))(1, "x");
    const receiver = {};
    let got: unknown;
    mixed.__mxOn(
      function (this: unknown) {
        got = this;
      },
      receiver,
      {},
    );
    expect(got).toBe(receiver);
    expect(mixed.__mxOnAt({ f: () => 5 }, "f", {})).toBe(5);
  });

  it("can be applied twice and to an empty class", () => {
    class Empty {}
    const once = MxHandlersMixin(Empty);
    const twice = MxHandlersMixin(once);
    expect(new twice().__mxOnAt({ f: () => 2 }, "f", {})).toBe(2);
  });

  it("keeps two mixed classes distinct", () => {
    const A = MxHandlersMixin(class {});
    const B = MxHandlersMixin(class {});
    expect(new A()).not.toBeInstanceOf(B);
  });
});

// ---------------------------------------------------------------------------
// Strict AOT. The template is what MX emits for a page; the class either
// carries the pasted members or takes them from the runtime module.
// ---------------------------------------------------------------------------

const PAGE = `
<button onClick=zero>a</button>
<button onClick=one>b</button>
<button onClick=two>c</button>
<button onClick=svc.one>d</button>
<button onClick=(cond && zero)>e</button>
<button onClick=(e => one(e))>f</button>
`;

const CLASS_BODY = `
  svc = { one(e: MouseEvent): void {} };
  cond = true as boolean;
  zero(): void {}
  one(e: MouseEvent): void {}
  two(e: MouseEvent, el: EventTarget | null): void {}
`;

let checkCount = 0;

/** ngtsc + strictTemplates diagnostics for `source`, given the runtime as a sibling file. */
function checkSource(source: string): string[] {
  checkCount++;
  const checker = createAngularChecker({ projectDir: checkerProject });
  // Served from memory next to the component, as `./mx-runtime`.
  checker.check(join(checkerProject, "mx-runtime.ts"), runtimeSource);
  const diagnostics = checker.check(
    join(checkerProject, `runtime-${checkCount}.component.ts`),
    source,
  );
  checker.dispose();
  return diagnostics.map((d) => `${d.code} ${d.message.split("\n")[0]}`);
}

function component(heritage: string, body: string, template: string): string {
  return `import { Component } from "@angular/core";
import { MxHandlers, MxHandlersMixin } from "./mx-runtime";
void MxHandlers; void MxHandlersMixin;
@Component({ selector: "mx-probe", standalone: true, template: \`${template}\` })
export class Probe${heritage} {${body}}
`;
}

describe("strict AOT", () => {
  const template = emit(PAGE);

  it("emits the invoker for the page (precondition)", () => {
    assertAngularParses(template);
    expect(template).toContain("__mxOn(");
  });

  it("paste path: the pasted members type-check", () => {
    const body = `\n${EVENT_HELPER_MEMBERS.join("\n")}\n${CLASS_BODY}`;
    expect(checkSource(component("", body, template))).toEqual([]);
  });

  it("base-class path: extends MxHandlers type-checks", () => {
    expect(
      checkSource(component(" extends MxHandlers", CLASS_BODY, template)),
    ).toEqual([]);
  });

  it("mixin path: extends MxHandlersMixin(Base) type-checks, keeping Base's members", () => {
    const source = `import { Component } from "@angular/core";
import { MxHandlersMixin } from "./mx-runtime";
class Base { title = "t"; constructor(readonly n: number) {} }
@Component({ selector: "mx-probe", standalone: true, template: \`${template}<p>{{ title }}{{ n }}</p>\` })
export class Probe extends MxHandlersMixin(Base) {
  constructor() { super(1); }
${CLASS_BODY}}
`;
    expect(checkSource(source)).toEqual([]);
  });

  it("the runtime's own declarations are emittable (members public)", () => {
    // A base class the component re-exports as a declaration would hit TS4094
    // for protected members of an anonymous mixin class; the source having no
    // `protected`/`private` is the guard.
    expect(runtimeSource).not.toMatch(/^\s*(protected|private)\b/m);
  });

  it("a wrong handler type is still an error through the base class", () => {
    const bad = emit("<button onClick=onPick>x</button>");
    const diagnostics = checkSource(
      component(
        " extends MxHandlers",
        "\n  onPick(n: number, m: number, o: number): void {}\n",
        bad,
      ),
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
