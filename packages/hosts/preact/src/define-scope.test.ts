// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4. The JSX hosts cannot emit a `<define>` that is not at the top level
 * (the host's own rule, below), so the outer `<Foo/>` of a nested define is
 * never a call to it: with an import it is not reached at all, and with none
 * it is an unresolved tag. Before, core kept the name for the rest of the file
 * and the unresolved case compiled as far as the host's top-level error.
 */
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
    expect(code.match(/\{Foo\(\)\}/g)).toHaveLength(3);
  });
});
