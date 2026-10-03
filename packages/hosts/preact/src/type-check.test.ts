import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Decision 140: `typeCheck` is a tooling-only mode. Unset, the output is the
 * runtime output, byte for byte; set, every native element's event handler is
 * wrapped in the type-only `__mxOn<"tag", "event">(fn)` call.
 */
const compile = (source: string, typeCheck?: boolean) =>
  compilePreactMx(source, "/fixtures/test.mx", { typeCheck });

const SOURCES = [
  "<button onClick=((e) => e.type)>x</button>",
  "<button onClick(e) { e.type; }>x</button>",
  "<input onKeyDown=((e) => e.key) onInput=((e) => e.currentTarget.value)/>",
  "<button on-dblclick(e) { e.detail; }>x</button>",
  "<my-el onClick=((e) => e)>x</my-el>",
  `<const/tag = "button"/><\${tag} onClick=((e) => e)>x</>`,
  `<div class="a" data-x=1><span>\${1 + 1}</span></div>`,
];

describe("typeCheck unset (the runtime compile)", () => {
  it.each(SOURCES)("emits no wrapper and no preamble for %s", (source) => {
    const plain = compile(source).code;
    expect(plain).not.toContain("__mx");
    expect(compile(source, false).code).toBe(plain);
  });

  it("keeps the shorthand handler's TypeScript annotations erased", () => {
    expect(
      compile("<button onClick(e: Event) { e.type; }>x</button>").code,
    ).toContain("onClick={(e) => {");
  });
});

describe("typeCheck set", () => {
  it("wraps a native element's handler and names the recomposed event", () => {
    const { code } = compile("<input onKeyDown=((e) => e.key)/>", true);
    expect(code).toContain(
      'onKeydown={__mxOn<"input", "keydown">((e) => e.key)}',
    );
  });

  it("wraps a shorthand handler, keeping its parameter annotations", () => {
    const { code } = compile(
      "<button onClick(e: Event) { e.type; }>x</button>",
      true,
    );
    expect(code).toContain(
      'onClick={__mxOn<"button", "click">((e: Event) => { e.type; })}',
    );
  });

  it("wraps `on-` spellings by the recomposed name", () => {
    const { code } = compile(
      "<button on-dblclick(e) { e.detail; }>x</button>",
      true,
    );
    expect(code).toContain('__mxOn<"button", "dblclick">(');
  });

  it("declares the host's own handler types in a preamble", () => {
    const { code } = compile("<button onClick=(() => 1)>x</button>", true);
    expect(code).toContain(
      'import type { JSX as __MxJSX } from "preact/jsx-runtime";',
    );
    expect(code).toContain("declare function __mxOn<");
  });

  it("maps a shorthand handler to the attribute name and an arrow to nothing of its own", () => {
    const source = "<button onClick(e) { e.type; }>x</button>";
    const { code, mappings } = compile(source, true);
    const wrapped = code.indexOf("(e) => { e.type; }");
    const mapping = mappings.find(
      (item) => item.generatedStart <= wrapped && wrapped < item.generatedEnd,
    );
    expect(mapping).toBeDefined();
    expect(source.slice(mapping?.sourceStart, mapping?.sourceEnd)).toBe(
      "onClick",
    );
  });

  it.each([
    "<my-el onClick=((e) => e)>x</my-el>",
    `<const/tag = "button"/><\${tag} onClick=((e) => e)>x</>`,
  ])("leaves a custom element or dynamic tag unwrapped: %s", (source) => {
    const { code } = compile(source, true);
    expect(code).not.toMatch(/__mxOn<"/);
  });

  it("leaves non-event attributes alone", () => {
    const { code } = compile('<div class="a" data-x=1>x</div>', true);
    expect(code).not.toMatch(/__mxOn<"/);
  });

  it("wraps handlers in nested elements, loops and defines", () => {
    const { code } = compile(
      "<for|i| of=[1]><li onClick=((e) => i)>x</li></for><define/Row|a|><b onClick=((e) => a)>y</b></define><Row(1)/>",
      true,
    );
    expect(code.match(/__mxOn<"(li|b)", "click">/g)).toHaveLength(2);
  });
});
