// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * An attribute tag takes no arguments. `<@item(1)>` used to compile with `(1)`
 * dropped (the html output carried no trace of it). Marko 6.4.4 refuses it
 * with "Tag does not support arguments." at the argument, so MX refuses it at
 * the same position, whatever the parent: a `<define>` call, a dynamic tag, an
 * imported component. Arguments on the call itself stay accepted.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const emit = (source: string) => compile(source, "/fixtures/page.mx").code;
const MESSAGE = (name: string) =>
  `\`<@${name}>\` does not take arguments. Remove \`(…)\` and pass the value as an attribute (\`<@${name} value=1>\`) or as the tag's body.`;

describe("html: an attribute tag's arguments are a positioned error", () => {
  // line and column are the first argument, as Marko 6.4.4 reports them
  // (its loc column is 0-based: 12 for `(1)` in `<Foo><@item(1)>`).
  const REFUSED: Array<[string, string, string, number, number]> = [
    [
      "a <define> call",
      "<define/Foo>x</define>\n<Foo><@item(1)>hi</@item></Foo>\n",
      "item",
      2,
      12,
    ],
    [
      "a dynamic tag",
      "<${input.c}>\n<@item(1)>hi</@item>\n</>\n",
      "item",
      2,
      7,
    ],
    [
      "an imported component",
      'import C from "./c.mx"\n<C>\n<@item(1)>hi</@item>\n</C>\n',
      "item",
      3,
      7,
    ],
    [
      "a self-closing attribute tag",
      "<define/Foo>x</define>\n<Foo><@item(1)/></Foo>\n",
      "item",
      2,
      12,
    ],
    [
      "an attribute tag with an attribute",
      "<define/Foo>x</define>\n<Foo><@item(1) a=2>hi</@item></Foo>\n",
      "item",
      2,
      12,
    ],
    [
      "a nested attribute tag",
      "<define/Foo>x</define>\n<Foo><@a><@b(1)/></@a></Foo>\n",
      "b",
      2,
      13,
    ],
    [
      "an attribute tag under <if>",
      "<define/Foo>x</define>\n<Foo><if=input.x><@item(1)>hi</@item></if></Foo>\n",
      "item",
      2,
      24,
    ],
    [
      "an attribute tag under <for>",
      "<define/Foo>x</define>\n<Foo><for|i| of=[1]><@item(1)>hi</@item></for></Foo>\n",
      "item",
      2,
      27,
    ],
    [
      "type arguments before the arguments",
      "<define/Foo>x</define>\n<Foo><@item<T>(1)>hi</@item></Foo>\n",
      "item",
      2,
      15,
    ],
    [
      "arguments over several lines",
      "<define/Foo>x</define>\n<Foo><@item(\n  1,\n  2\n)>hi</@item></Foo>\n",
      "item",
      3,
      2,
    ],
  ];

  for (const [label, source, name, line, column] of REFUSED) {
    it(`${label}`, () => {
      expect(() => emit(source)).toThrow(
        expect.objectContaining({
          diagnosticCode: "MX_UNSUPPORTED_TAG_ARGUMENTS",
          message: MESSAGE(name),
          line,
          column,
        }),
      );
    });
  }
});

describe("html: what Marko accepts still compiles", () => {
  const ACCEPTED: Array<[string, string]> = [
    ["arguments on the <define> call", "<define/Foo>x</define>\n<Foo(bar)/>\n"],
    [
      "type and call arguments on the call",
      "<define/Foo>x</define>\n<Foo<A>(bar)>hi</>\n",
    ],
    [
      "call arguments with an attribute tag",
      "<define/Foo>x</define>\n<Foo(1)><@item>hi</@item></Foo>\n",
    ],
    [
      "empty parentheses on an attribute tag",
      "<define/Foo>x</define>\n<Foo><@item()>hi</@item></Foo>\n",
    ],
    [
      "type arguments on an attribute tag",
      "<define/Foo>x</define>\n<Foo><@item<T>>hi</@item></Foo>\n",
    ],
    [
      "an attribute tag without arguments",
      "<define/Foo>x</define>\n<Foo><@item>hi</@item></Foo>\n",
    ],
  ];
  for (const [label, source] of ACCEPTED) {
    it(label, () => {
      expect(() => emit(source)).not.toThrow();
    });
  }
});
