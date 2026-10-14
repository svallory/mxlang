// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * An attribute tag takes no arguments. `<@item(1)>` used to lower with `(1)`
 * dropped: the IR's `AttributeTag` has no field for it. Marko 6.4.4 refuses
 * it ("Tag does not support arguments.") at the argument, whatever the parent
 * is, so MX refuses it there too, under every tag-rules preset. What stock
 * accepts stays accepted: arguments on the call itself, empty `()`, type
 * arguments.
 *
 * An imported component is not here: `lowerSource` stops at a call to one
 * before lowering it (a data file cannot call a template tag), so that row
 * lives in the html target's test, which compiles it.
 *
 * Positions are probed against stock Marko 6.4.4 (`stockMarkoCompile`, a real
 * `tags/foo.marko`): its loc is the first argument, 0-based column.
 */
import { describe, expect, it } from "vitest";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const CODE = "MX_UNSUPPORTED_TAG_ARGUMENTS";
const PRESETS = [undefined, "none"] as const;

function lower(source: string, preset?: "none") {
  const options: LowerSourceOptions = {
    structural: "pass",
    imports: "pass",
    unknownTags: "allow",
    ...(preset ? { tagRules: preset } : {}),
  };
  return lowerSource(source, "/v/page.mx", options);
}

/** The marked source: `§` before the first argument, `¶` after the last one. */
function marked(source: string) {
  const start = source.indexOf("§");
  const text = source.replace("§", "");
  const end = text.indexOf("¶");
  const plain = text.replace("¶", "");
  const lineAt = (offset: number) => plain.slice(0, offset).split("\n");
  const at = (offset: number) => {
    const lines = lineAt(offset);
    return { line: lines.length, column: lines[lines.length - 1]?.length ?? 0 };
  };
  return { plain, start: at(start), end: at(end) };
}

function expectRefused(source: string, name: string, preset?: "none"): void {
  const m = marked(source);
  const result = lower(m.plain, preset);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.find((d) => d.code === CODE)).toMatchObject({
    severity: "error",
    code: CODE,
    line: m.start.line,
    column: m.start.column,
    end: { line: m.end.line, column: m.end.column },
    message: `\`<@${name}>\` does not take arguments. Remove \`(…)\` and pass the value as an attribute (\`<@${name} value=1>\`) or as the tag's body.`,
  });
}

describe("an attribute tag's arguments are refused, where stock Marko refuses", () => {
  for (const preset of PRESETS) {
    const label = preset ?? "default rules";

    describe(label, () => {
      it("under a template custom tag", () => {
        expectRefused(
          "<foo>\n<@item(§1¶)>hi</@item>\n</foo>\n",
          "item",
          preset,
        );
      });

      it("under a dynamic tag", () => {
        expectRefused(
          "<${input.c}>\n<@item(§1¶)>hi</@item>\n</>\n",
          "item",
          preset,
        );
      });

      it("under a <define> call", () => {
        expectRefused(
          "<define/Foo>x</define>\n<Foo><@item(§1¶)>hi</@item></Foo>\n",
          "item",
          preset,
        );
      });

      it("self-closing", () => {
        expectRefused("<foo><@item(§1¶)/></foo>\n", "item", preset);
      });

      it("with an attribute", () => {
        expectRefused(
          "<foo><@item(§1¶) a=2>hi</@item></foo>\n",
          "item",
          preset,
        );
      });

      it("nested in another attribute tag, naming the inner one", () => {
        expectRefused("<foo><@a><@b(§1¶)/></@a></foo>\n", "b", preset);
      });

      it("under an <if> in the parent", () => {
        expectRefused(
          "<foo><if=input.x><@item(§1¶)>hi</@item></if></foo>\n",
          "item",
          preset,
        );
      });

      it("under a <for> in the parent", () => {
        expectRefused(
          "<foo><for|i| of=[1]><@item(§1¶)>hi</@item></for></foo>\n",
          "item",
          preset,
        );
      });

      it("after type arguments", () => {
        expectRefused("<foo><@item<T>(§1¶)>hi</@item></foo>\n", "item", preset);
      });

      it("a hyphenated attribute tag keeps its name in the message", () => {
        expectRefused("<foo><@list-item(§1¶)/></foo>\n", "list-item", preset);
      });

      it("the range runs from the first argument to the last", () => {
        expectRefused("<foo><@item(§1, 2¶)/></foo>\n", "item", preset);
        expectRefused("<foo><@item(§a, b, c¶)/></foo>\n", "item", preset);
      });

      it("the range runs over a line break", () => {
        expectRefused(
          "<foo><@item(\n  §1,\n  2¶\n)>hi</@item></foo>\n",
          "item",
          preset,
        );
      });

      it("a spread argument, and a trailing comma", () => {
        expectRefused("<foo><@item(§...xs¶)/></foo>\n", "item", preset);
        expectRefused("<foo><@item(§1¶,)/></foo>\n", "item", preset);
      });

      it("in concise mode", () => {
        expectRefused("foo\n  @item(§1¶)\n    -- hi\n", "item", preset);
      });

      it("a refused attribute tag is the only diagnostic of its kind, and no IR", () => {
        const result = lower("<foo><@item(1)>hi</@item></foo>\n", preset);
        expect(result.ir).toBeUndefined();
        expect(result.diagnostics.filter((d) => d.code === CODE)).toHaveLength(
          1,
        );
      });
    });
  }
});

describe("what stock Marko accepts keeps lowering", () => {
  const accepted: Array<[string, string]> = [
    ["arguments on the call itself", "<foo(bar)/>\n"],
    ["type and call arguments on the call", "<foo<A>(bar)>hi</>\n"],
    [
      "call arguments with an attribute tag",
      "<foo(1)><@item>hi</@item></foo>\n",
    ],
    [
      "empty parentheses on an attribute tag",
      "<foo><@item()>hi</@item></foo>\n",
    ],
    ["type arguments on an attribute tag", "<foo><@item<T>>hi</@item></foo>\n"],
    ["no arguments", "<foo><@item>hi</@item></foo>\n"],
    ["params on an attribute tag", "<foo><@item|x|>${x}</@item></foo>\n"],
  ];
  for (const preset of PRESETS) {
    for (const [label, source] of accepted) {
      it(`${preset ?? "default rules"}: ${label}`, () => {
        const result = lower(source, preset);
        expect(result.diagnostics).toEqual([]);
        expect(result.ir).toBeDefined();
      });
    }
  }
});
