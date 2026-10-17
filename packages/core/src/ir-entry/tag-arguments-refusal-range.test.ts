// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A tag that takes no arguments, or no arguments next to attributes or a body,
 * blames the whole argument list: from the first argument's start to the last
 * one's end. Stock Marko 6.4.4's `assertNoArgs` and
 * `assertAttributesOrSingleArg` raise on `args[0].loc.start` .. `args.at(-1)
 * .loc.end`; MX ended the range at the first argument (`<if(a, b)>`,
 * `<let/x(1, 2)/>`) or blamed the tag name (`<Foo(a, b) c=1/>`).
 *
 * Probed with `bun run --cwd packages/stock-marko probe '<source>'`; the
 * attribute-tag case is `attr-tag-arguments.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const CONSTRUCT = "MX_UNSUPPORTED_CONSTRUCT";
const ARGUMENTS = "MX_UNSUPPORTED_TAG_ARGUMENTS";
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
  const at = (offset: number) => {
    const lines = plain.slice(0, offset).split("\n");
    return { line: lines.length, column: lines[lines.length - 1]?.length ?? 0 };
  };
  return { plain, start: at(start), end: at(end) };
}

function expectRefused(
  source: string,
  code: string,
  message: string | RegExp,
  preset?: "none",
): void {
  const m = marked(source);
  const result = lower(m.plain, preset);
  expect(result.ir).toBeUndefined();
  const found = result.diagnostics.find((d) => d.code === code);
  expect(found).toMatchObject({
    severity: "error",
    code,
    line: m.start.line,
    column: m.start.column,
    end: { line: m.end.line, column: m.end.column },
  });
  if (typeof message === "string") expect(found?.message).toBe(message);
  else expect(found?.message).toMatch(message);
}

describe("a built-in tag's arguments are blamed over the whole list", () => {
  for (const preset of PRESETS) {
    describe(preset ?? "default rules", () => {
      it("<if(a, b)>", () => {
        expectRefused(
          "<if(§a, b¶)>x</if>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("<if(a, b)/> and concise `if(a, b)`", () => {
        expectRefused(
          "<if(§a, b¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
        expectRefused(
          "if(§a, b¶)\n  -- x\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("<else-if(a,b)/>", () => {
        expectRefused(
          "<if=c></if><else-if(§a,b¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("<for(a,b)>", () => {
        expectRefused(
          "<for(§a,b¶)>x</for>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("<const/x(1,2)/>", () => {
        expectRefused(
          "<const/x(§1,2¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("three arguments, a spread, and a line break", () => {
        expectRefused(
          "<const/x(§1, 2, 3¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
        expectRefused(
          "<const/x(§...a, b¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
        expectRefused(
          "<const/x(\n  §1,\n  2¶\n)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });

      it("one argument still blames exactly that argument", () => {
        expectRefused(
          "<const/x(§1¶)/>\n",
          CONSTRUCT,
          /^Tag does not support arguments\./,
          preset,
        );
      });
    });
  }
});

describe("arguments next to attributes on a dynamic tag", () => {
  const MESSAGE =
    "Tag does not support arguments when attributes or body present.";

  for (const preset of PRESETS) {
    describe(preset ?? "default rules", () => {
      it("blames the arguments, in stock's words", () => {
        expectRefused(
          "<${input.x}(§a, b¶) c=1/>\n",
          ARGUMENTS,
          MESSAGE,
          preset,
        );
      });

      it("one argument", () => {
        expectRefused("<${input.x}(§a¶) c=1/>\n", ARGUMENTS, MESSAGE, preset);
      });

      it("a line break inside the list", () => {
        expectRefused(
          "<${input.x}(\n  §a,\n  b¶\n) c=1/>\n",
          ARGUMENTS,
          MESSAGE,
          preset,
        );
      });
    });
  }
});
