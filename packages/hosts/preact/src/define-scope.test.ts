// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4. The JSX hosts cannot emit a `<define>` that is not at the top level
 * (the host's own rule, below), so the outer `<Foo/>` of a nested define is
 * never a call to it: with an import it is not reached at all, and with none
 * it is an unresolved tag. Before, core kept the name for the rest of the file
 * and the unresolved case compiled as far as the host's top-level error.
 */
import { parse } from "@babel/parser";
import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { paramNames, typedDefineParam } from "./emitter.ts";
import { compilePreactMx } from "./index.ts";

const FOO = "<define/Foo><p>inner</p></define>";
const emit = (source: string) => compilePreactMx(source, "/f/t.preact.mx").code;

describe("preact: a <define> is scoped to the body that declares it", () => {
  for (const [label, block] of [
    ["<if>", `<if=input.a>${FOO}</if>`],
    ["<for>", `<for|i| of=[1]>${FOO}</for>`],
    ["a native element", `<div>${FOO}</div>`],
  ] as const) {
    it(`${label}: <Foo/> after it with no import is an unresolved tag`, () => {
      expect(() => emit(`${block}\n<Foo/>\n`)).toThrow(
        "Unable to find entry point for custom tag `<Foo>`.",
      );
    });

    it(`${label}: the define itself is still refused below the top level`, () => {
      expect(() => emit(`${block}\n`)).toThrow(
        "`<define>` must appear at the top level of the template",
      );
    });
  }

  it("a top-level define is called from every later block", () => {
    const code = emit(
      `${FOO}\n<if=input.a><Foo/></if>\n<div><Foo/></div>\n<Foo/>\n`,
    );
    // One call per block: bare in the `<if>` arm (an expression slot), a JSX
    // child in the element and at the top level.
    expect(code).toContain("{input.a ? __mxDef_Foo() : null}");
    expect(code).toContain("<div>{__mxDef_Foo()}</div>");
    expect(code.match(/__mxDef_Foo\(\)/g)).toHaveLength(3);
  });
});

const HOSTS = ["preact", "react", "hono"] as const;

async function compilerFor(
  host: (typeof HOSTS)[number],
): Promise<typeof compilePreactMx> {
  if (host === "preact") return compilePreactMx;
  const url = new URL(`../../${host}/src/index.ts`, import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Record<
    string,
    unknown
  >;
  return module[
    host === "react" ? "compileReactMx" : "compileHonoMx"
  ] as typeof compilePreactMx;
}

const parseTsx = (code: string) =>
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

describe.each(HOSTS)(
  "%s: a /var inside a body is scoped to that body (stock Marko 6.4.4)",
  (host) => {
    const counter = {
      template: {
        filename: "/fixtures/tags/counter.mx",
        source: "<return value=1/>",
      },
    } as CustomTag;
    const compile = async (source: string) =>
      (await compilerFor(host))(source, "/fixtures/page.mx", {
        customTags: { counter },
      }).code;

    it("a whole-file define body declares its own /var, beside an outer one", async () => {
      const code = await compile(
        "<define/Row><counter/x/>${x}</define><counter/x/><Row/>",
      );
      const define = code.slice(code.indexOf("const __mxDef_Row"));
      // Inside the define's function, ahead of the markup that reads `x`.
      expect(define).toMatch(
        /const __mxDef_Row = \(\) => \{ const __mxRet0 = \$mx_Counter1\.render\(\{ +\}\); const x = __mxRet0\.value; return \(<>/,
      );
      // The component's own `/x` has its own temp, outside the define.
      expect(code.match(/const x = /g)).toHaveLength(2);
      expect(code.match(/const __mxRet0 = /g)).toHaveLength(2);
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("two defines each declare their own /var", async () => {
      const code = await compile(
        "<define/A><counter/x/>${x}</define><define/B><counter/y/>${y}</define><A/><B/>",
      );
      expect(code.match(/const __mxRet0 = /g)).toHaveLength(2);
      expect(code).toMatch(/const __mxDef_A = \(\) => \{ const __mxRet0/);
      expect(code).toMatch(/const __mxDef_B = \(\) => \{ const __mxRet0/);
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("a /var in a define body that reuses one of its params is core's duplicate", async () => {
      await expect(
        compile("<define/Row|{ x }|><counter/x/>${x}</define><Row x=1/>"),
      ).rejects.toThrow(/Duplicate declaration/);
    });

    it.each([
      ["a dynamic tag body", "<${input.tag}><counter/x/>${x}</>"],
      [
        "a <try> @placeholder body",
        "<try><b/><@placeholder><counter/x/>${x}</@placeholder></try>",
      ],
      [
        "a <try> @catch body",
        "<try><b/><@catch><counter/x/>${x}</@catch></try>",
      ],
      ["a <try> body", "<try><counter/x/>${x}<@catch>e</@catch></try>"],
    ])("%s declares its own /var beside an outer /x", async (_label, body) => {
      const code = await compile(`${body}\n<counter/x/>${"${x}"}`);
      // One declaration inside the body's own arrow, one in the component.
      expect(code.match(/const x = /g)).toHaveLength(2);
      expect(code).toMatch(
        /\(\) => \{ const __mxRet0 = \$mx_Counter1\.render\(/,
      );
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("a dynamic-tag body inside a <for> still refuses a /var", async () => {
      await expect(
        compile("<for|i| of=input.xs><${input.t}><counter/x/>${x}</></for>"),
      ).rejects.toThrow(/not supported/);
    });

    it("the body of a direct define call is its own scope, beside an outer /x", async () => {
      const code = await compile(
        "<define/Row|c|>${c}</define><Row><counter/x/>${x}</Row><counter/x/>${x}",
      );
      expect(code.match(/const x = /g)).toHaveLength(2);
      expect(code).toMatch(/\{ const __mxRet0 = \$mx_Counter1\.render\(/);
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("a define read only by <return> keeps its public binding", async () => {
      const code = await compile(
        "<define/Row><p>r</p></define><return value=Row/>",
      );
      expect(code).toContain('const Row = __mxDefine(__mxDef_Row, "Row");');
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("a define with attributes that is only called directly has no public binding", async () => {
      const code = await compile("<define/Row x=1><p>r</p></define><Row/>");
      expect(code).not.toContain("const Row =");
    });

    it.each([
      ["a spread attribute", "<define/Row a=1/><div ...Row/>"],
      [
        "a spread inside an expression",
        "<define/Row list=[1]/>${[...Row.list]}",
      ],
    ])(
      "a define read through %s keeps its public binding",
      async (_label, source) => {
        const code = await compile(source);
        expect(code).toContain("const Row = Object.assign(");
        expect(() => parseTsx(code)).not.toThrow();
      },
    );

    it.each([
      ["a dynamic target", "<define/Ñame a=1>x</define><${Ñame}/>"],
      ["a spread", "<define/Rowé a=1/><div ...Rowé/>"],
    ])(
      "a define with a non-ASCII name read as %s keeps its public binding",
      async (_label, source) => {
        const code = await compile(source);
        expect(code).toMatch(/const (Ñame|Rowé) = Object\.assign\(/);
        expect(() => parseTsx(code)).not.toThrow();
      },
    );

    it("a define with attributes whose property is read keeps its binding", async () => {
      const code = await compile(
        "<define/Row x=1><p>r</p></define><Row/>${Row.x}",
      );
      expect(code).toContain("const Row = Object.assign(");
    });

    it("an outer /x read before a body that declares its own /x compiles", async () => {
      const code = await compile(
        "<counter/x/>${x}<${input.tag}><counter/x/>${x}</>",
      );
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("an imported value tag's body is its own scope, beside an outer /x", async () => {
      const code = await compile(
        'import { Box } from "./box.tsx";\n<Box><counter/x/>${x}</Box><counter/x/>${x}',
      );
      // The body's /var runs inside its content function, not in the render
      // of the component that calls Box.
      expect(code).toMatch(
        /content: \(\) => \{ const __mxRet0 = \$mx_Counter1\.render\(/,
      );
      expect(code.match(/const x = /g)).toHaveLength(2);
      expect(() => parseTsx(code)).not.toThrow();
    });

    it("an outer /x declared before a body's own /x is refused by core (only body-first compiles)", async () => {
      await expect(
        compile("<counter/x/><${input.tag}><counter/x/>${x}</>${x}"),
      ).rejects.toThrow("not in scope here");
    });
  },
);

describe("the typeCheck projection reads the public define name", () => {
  it("calls a define directly through its public binding", () => {
    const code = compilePreactMx(
      "<define/Row|p|>${p}</define><Row('a')/>",
      "/f/t.mx",
      {
        typeCheck: true,
      },
    ).code;
    expect(code).toContain("{Row('a')}");
    expect(code).toContain('const Row = __mxDefine(__mxDef_Row, "Row");');
  });
});

describe("typedDefineParam", () => {
  it.each([
    ["p", "p: any"],
    ["...r", "...r: any[]"],
    ["{ a }", "{ a }: any"],
    ["[a, b]", "[a, b]: any"],
    ["a: string", "a: string"],
    ["a = 1", "a = 1"],
    ["a = -1.5", "a = -1.5"],
    ["a = 'x'", "a = 'x'"],
    ["a = true", "a = true"],
    ["a = 1 + 1", "a: any = 1 + 1"],
    ["xs = []", "xs: any = []"],
    ["a = null", "a: any = null"],
    ["a = undefined", "a: any = undefined"],
    ["{ a = 1 }", "{ a = 1 }: any"],
    ["{ a } = {}", "{ a }: any = {}"],
    ["[a] = []", "[a]: any = []"],
    ["...r: string[]", "...r: string[]"],
  ])("%s -> %s", (param, typed) => {
    expect(typedDefineParam(param)).toBe(typed);
  });
});

describe.each(HOSTS)("%s: define calls and attributes", (host) => {
  const compile = async (source: string) =>
    (await compilerFor(host))(source, "/f/t.mx").code;

  it("a param default that names a define does not shadow it", async () => {
    const code = await compile(
      "<define/Row|o|>${o.content}</define><define/Id|{ a = Row }|><Row({ children: 'c' })/></define><Id/>",
    );
    expect(code).toContain("__mxDef_Row({ children: 'c' })");
  });

  it("a param default holding a regex literal fails safe: the call reaches the shadowing param", async () => {
    const code = await compile(
      "<define/Row|x|><li>${x}</li></define><define/List|{ a = /[}]/, Row }|><Row(1)/></define><List(null)/>",
    );
    expect(code).toContain("{Row(1)}");
    expect(code).not.toContain("__mxDef_Row(1)");
  });

  it("a param default holding a template literal fails safe too", async () => {
    const code = await compile(
      "<define/Row|x|><li>${x}</li></define><define/List|{ a = `${'`'}`, Row }|><Row(1)/></define><List(null)/>",
    );
    expect(code).toContain("{Row(1)}");
    expect(code).not.toContain("__mxDef_Row(1)");
  });

  it("a define attribute with a side effect is emitted once when the define is only called directly", async () => {
    const code = await compile(
      "<define/Row x=input.track()><p>r</p></define><Row/>",
    );
    expect(code.match(/input\.track\(\)/g)).toHaveLength(1);
    expect(code).toContain("void Object.assign(__mxDef_Row");
    expect(code).not.toContain("const Row =");
  });
});

describe("paramNames", () => {
  it.each([
    [["p"], ["p"]],
    [
      ["a", "b"],
      ["a", "b"],
    ],
    [["...rest"], ["rest"]],
    [["a = Row"], ["a"]],
    [["{ a = Row }"], ["a"]],
    [["{ a, b: c, ...d }"], ["a", "c", "d"]],
    [["{ a: { b = [1, 2] } }"], ["b"]],
    [["[a, , [b], ...c]"], ["a", "b", "c"]],
    [["{ a } = { a: Row }"], ["a"]],
    [["x: Map<string, number>"], ["x"]],
    [["{ 'k-1': k, [`z${1}`]: z }"], ["*"]],
    [["{ a = /[}]/, Row }"], ["*"]],
    [["{ a = 1 / 2, Row }"], ["*"]],
    [["{ 'k-1': k, [\"z\"]: z }"], ["k", "z"]],
    [["{ Ñame }"], ["Ñame"]],
  ])("%j -> %j", (params, names) => {
    expect(paramNames(params)).toEqual(names);
  });
});
