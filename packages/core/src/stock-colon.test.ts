import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { compileSource, parseMxDocument, printExpression } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * `:name` in a `.mx` file is plain JavaScript, as in Marko: core has no atom
 * syntax (a dialect builds atoms through its triggers). Each row is stock
 * `@marko/compiler` 5.42.11 on stock `htmljs-parser` 5.18.0, probed with
 * `bun run --cwd packages/stock-marko probe '<src>'`: the message and the
 * position of Marko's error (`line` 1-based, `column` 0-based, the probe's
 * "index"). The template-parser event streams are pinned equal to stock's in
 * `packages/stock-marko/src/divergence.cases.ts` (`colon-*`,
 * `double-colon-*`).
 */
const UNEXPECTED = "Unexpected token";
const SINGLE = "Expected a single expression, but found `:` after it.";

/** Marko's exact label, ending its line (no trailing period added). */
const label = (message: string) =>
  expect.stringMatching(
    new RegExp(
      `(^|[ ^])${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "m",
    ),
  );

const host: HostDeclarations = {
  name: "stock-colon-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

const FILE = "/tmp/stock-colon.mx";

function viaCompile(source: string): unknown {
  try {
    compileSource(source, FILE, host, { targets: lookup, emitIr: () => "" });
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Marko's parse error carries its position on `loc.start`. Its message is a
 * code frame that Babel colours when the terminal allows it (CI does), so the
 * colour codes are stripped before the label is matched.
 */
function located(error: unknown) {
  type Located = { message: string; loc?: { start?: object } };
  // A `CompileErrors` aggregate carries the failure on its first error.
  const first =
    (error as { errors?: Located[] } | undefined)?.errors?.[0] ??
    (error as Located | undefined);
  const message =
    first?.message === undefined
      ? undefined
      : stripVTControlCharacters(first.message);
  return { message, ...first?.loc?.start };
}

// [source, message, line, column]
const ERRORS: [string, string, number, number][] = [
  ["<a b=:x/>", UNEXPECTED, 1, 5],
  ["<a b=(f(:x))/>", UNEXPECTED, 1, 8],
  ["<a b=:x c=1/>", UNEXPECTED, 1, 5],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX source, not a JS template
  ["${:x}", UNEXPECTED, 1, 2],
  ["<a b=x::y/>", SINGLE, 1, 6],
  ["a b=:x", UNEXPECTED, 1, 4],
  ["a b=(f(:x))", UNEXPECTED, 1, 7],
  ["a b=:x c=1", UNEXPECTED, 1, 4],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX source, not a JS template
  ["div -- ${:x}", UNEXPECTED, 1, 9],
  ["a b=x::y", SINGLE, 1, 5],
];

describe("`:name` is plain JavaScript, as in Marko", () => {
  it.each([
    "<a b=x/>",
    "<a b=(f(x))/>",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX source, not a JS template
    "${x}",
  ])("control %j compiles", (source) => {
    expect(viaCompile(source)).toBeUndefined();
  });

  it.each(ERRORS)(
    "compileSource: %j is Marko's %j at %i:%i",
    (source, message, line, column) => {
      expect(located(viaCompile(source))).toMatchObject({
        message: label(message),
        line,
        column,
      });
    },
  );

  // With no template error the fragment's container keeps the parse error
  // and lowering raises it at the same place.
  it.each(ERRORS)(
    "parseFragment + lower: %j is Marko's %j at %i:%i",
    (source, message, line, column) => {
      let error: unknown;
      try {
        const ctx = newCtx(
          source,
          printExpression,
          host,
          undefined,
          FILE,
          lookup,
        );
        lower(ctx, parseFragment(source).body);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TranslateError);
      const caught = error as TranslateError;
      expect({
        message: stripVTControlCharacters(caught.message),
        line: caught.line,
        column: caught.column,
      }).toMatchObject({ message: label(message), line, column });
    },
  );
});

describe("`::` in a name is part of the name, as in Marko", () => {
  /** The first tag of the parsed document. */
  const firstTag = (source: string) =>
    (
      parseMxDocument(source, "page.mx", undefined) as {
        body: {
          name: { value: string };
          attributes: { name: string; modifier: string | null }[];
        }[];
      }
    ).body[0];

  it("`<a::b/>` is the tag `a::b`", () => {
    // Stock Marko parses it the same way and then fails only to resolve the
    // custom tag `<a::b>` (a tag lookup, not the grammar).
    expect(firstTag("<a::b/>")?.name.value).toBe("a::b");
    expect(viaCompile("<a::b/>")).toBeUndefined();
  });

  it("concise `a::b` is the tag `a::b`", () => {
    expect(firstTag("a::b")?.name.value).toBe("a::b");
    expect(viaCompile("a::b")).toBeUndefined();
  });

  it("concise `a x::y=1` is the attribute `x:` with the modifier `y`", () => {
    expect(firstTag("a x::y=1")?.attributes).toMatchObject([
      { name: "x:", modifier: "y" },
    ]);
    expect(viaCompile("a x::y=1")).toBeUndefined();
  });

  it("`<a x::y=1/>` is the attribute `x:` with the modifier `y`", () => {
    // Marko splits a name at its last `:` (`onAttrName`).
    expect(firstTag("<a x::y=1/>")?.attributes).toMatchObject([
      { name: "x:", modifier: "y" },
    ]);
    expect(viaCompile("<a x::y=1/>")).toBeUndefined();
  });
});
