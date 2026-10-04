import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Decision 140: `typeCheck` is a tooling-only mode. Unset, the output is the
 * runtime output, byte for byte; set, every native element's event handler is
 * checked with the type-only `(fn) satisfies __MxH<"tag", "event">` (erased on
 * emit, so it can never reach a running module).
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
    // Runtime helpers use the reserved prefix too; only tooling names leak.
    expect(plain).not.toContain("__Mx");
    for (const token of [
      "__MxJSX",
      "type __MxM",
      "type __MxH",
      "__mxOn",
      " satisfies ",
    ])
      expect(plain).not.toContain(token);
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
      'onKeydown={((e) => e.key) satisfies __MxH<"input", "keydown">}',
    );
  });

  it("wraps a shorthand handler, keeping its parameter annotations", () => {
    const { code } = compile(
      "<button onClick(e: Event) { e.type; }>x</button>",
      true,
    );
    expect(code).toContain(
      'onClick={((e: Event) => { e.type; }) satisfies __MxH<"button", "click">}',
    );
  });

  it("wraps `on-` spellings by the recomposed name", () => {
    const { code } = compile(
      "<button on-dblclick(e) { e.detail; }>x</button>",
      true,
    );
    expect(code).toContain('satisfies __MxH<"button", "dblclick">');
  });

  it("declares the host's own handler types in a preamble", () => {
    const { code } = compile("<button onClick=(() => 1)>x</button>", true);
    expect(code).toContain(
      'import type { JSX as __MxJSX } from "preact/jsx-runtime";',
    );
    expect(code).not.toMatch(/declare function|__mxOn/);
    expect(code).toContain("type __MxH<");
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
    expect(code).not.toContain("satisfies");
  });

  it("leaves non-event attributes alone", () => {
    const { code } = compile('<div class="a" data-x=1>x</div>', true);
    expect(code).not.toContain("satisfies");
  });

  it("wraps handlers in nested elements, loops and defines", () => {
    const { code } = compile(
      "<for|i| of=[1]><li onClick=((e) => i)>x</li></for><define/Row|a|><b onClick=((e) => a)>y</b></define><Row(1)/>",
      true,
    );
    expect(code.match(/satisfies __MxH<"(li|b)", "click">/g)).toHaveLength(2);
  });
});

describe("typeCheck helper names never collide with the template (decision 140)", () => {
  const handler = "<button onClick=((e) => e.type)>x</button>";
  const helpers = ["__MxJSX", "__MxM", "__MxH"];

  it.each([
    ["a static const", (n: string) => `static const ${n} = 1`],
    ["an import", (n: string) => `import { x as ${n} } from "./x.ts"`],
    ["a type", (n: string) => `export type ${n} = number`],
  ])("avoids a user binding named like a helper (%s)", (_kind, declare) => {
    for (const helper of helpers) {
      const { code } = compile(`${declare(helper)}\n${handler}`, true);
      // The user's own declaration is the only occurrence of the bare name:
      // every generated identifier moved to a suffixed one.
      const bare = code.match(new RegExp(`\\b${helper}\\b`, "g")) ?? [];
      expect(bare).toHaveLength(1);
      expect(code).toMatch(new RegExp(`${helper}1\\b`));
    }
  });

  it.each([
    ["a braced escape in a type", "export type __Mx\\u{48} = number"],
    ["a fixed escape in a type", "export type __Mx\\u0048 = number"],
    [
      "a fixed escape in an import alias",
      'import type { Thing as __Mx\\u0048 } from "./x.ts"',
    ],
    ["an escape in the first character", "export type \\u005f_MxH = number"],
  ])("avoids a Unicode-escaped user binding (%s)", (_kind, declare) => {
    const { code } = compile(`${declare}\n${handler}`, true);
    expect(code).toContain("type __MxH1<");
    expect(code).toContain("satisfies __MxH1<");
    expect(code).not.toMatch(/type __MxH</);
  });

  it("keeps the plain names when nothing collides", () => {
    const { code } = compile(handler, true);
    expect(code).toContain("type __MxH<");
    expect(code).not.toContain("__MxH1");
  });
});
