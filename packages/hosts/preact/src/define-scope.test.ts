// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4. The JSX hosts cannot emit a `<define>` that is not at the top level
 * (the host's own rule, below), so the outer `<Foo/>` of a nested define is
 * never a call to it: with an import it is not reached at all, and with none
 * it is an unresolved tag. Before, core kept the name for the rest of the file
 * and the unresolved case compiled as far as the host's top-level error.
 */
import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
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
    expect(code).toContain("{input.a ? Foo() : null}");
    expect(code).toContain("<div>{Foo()}</div>");
    expect(code.match(/Foo\(\)/g)).toHaveLength(3);
  });
});

describe("a /var inside a body is scoped to that body (stock Marko 6.4.4)", () => {
  const counter = {
    template: {
      filename: "/fixtures/tags/counter.mx",
      source: "<return value=1/>",
    },
  } as CustomTag;
  const compile = (source: string) =>
    compilePreactMx(source, "/fixtures/page.mx", { customTags: { counter } })
      .code;

  it("a whole-file define body declares its own /var, beside an outer one", () => {
    const code = compile(
      "<define/Row><counter/x/>${x}</define><counter/x/><Row/>",
    );
    const define = code.slice(code.indexOf("const Row"));
    // Inside the define's function, ahead of the markup that reads `x`.
    expect(define).toMatch(
      /const Row = __mxDefine\(\(\) => \{ const __mxRet0 = \$mx_Counter1\.render\(\{ +\}\); const x = __mxRet0\.value; return \(<>/,
    );
    // The component's own `/x` has its own temp, outside the define.
    expect(code.match(/const x = /g)).toHaveLength(2);
    expect(code.match(/const __mxRet0 = /g)).toHaveLength(2);
  });

  it("two defines each declare their own /var", () => {
    const code = compile(
      "<define/A><counter/x/>${x}</define><define/B><counter/y/>${y}</define><A/><B/>",
    );
    expect(code.match(/const __mxRet0 = /g)).toHaveLength(2);
    expect(code).toMatch(/const A = __mxDefine\(\(\) => \{ const __mxRet0/);
    expect(code).toMatch(/const B = __mxDefine\(\(\) => \{ const __mxRet0/);
  });

  it.each([
    ["a dynamic tag body", "<${input.tag}><counter/x/>${x}</>"],
    [
      "a <try> @placeholder body",
      "<try><b/><@placeholder><counter/x/>${x}</@placeholder></try>",
    ],
    ["a <try> @catch body", "<try><b/><@catch><counter/x/>${x}</@catch></try>"],
  ])("%s declares its own /var beside an outer /x", (_label, body) => {
    const code = compile(`${body}\n<counter/x/>${"${x}"}`);
    // One declaration inside the body's own arrow, one in the component.
    expect(code.match(/const x = /g)).toHaveLength(2);
    expect(code).toMatch(/\(\) => \{ const __mxRet0 = \$mx_Counter1\.render\(/);
  });
});
