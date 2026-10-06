import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lookup } from "./test-targets.ts";

/**
 * Decision 174: a tag-adjacent class shorthand the parser itself cannot read
 * is rewritten to MX's class-shorthand diagnostic at the `.`, on both of
 * core's parse entries — `compileSource` (whole-file) and `parseFragment`
 * (a region). The shorthands that *parse* (`.bg-[#fff]`, `.w-1.5`) and the
 * region path's `.w-1/2` are lowering errors instead (name-sugar.test.ts).
 */

const host: HostDeclarations = {
  name: "shorthand-parse-error-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

function viaFragment(source: string): unknown {
  try {
    parseFragment(source);
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaCompile(source: string): unknown {
  try {
    compileSource(source, "/tmp/shorthand.mx", host, {
      targets: lookup,
      emitIr: () => "",
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

const ENTRIES = [
  ["parseFragment", viaFragment],
  ["compileSource", viaCompile],
] as const;

// [source, line (1-based), column (0-based) of the `.`, token in the message]
const BRACKETS: [string, number, number, string][] = [
  ["<div.bg-[url('/x.png')]/>", 1, 4, ".bg-[url('/x.png')]"],
  ["<div.data-[state=open]:flex/>", 1, 4, ".data-[state=open]:flex"],
  ["<div.w-[calc(100%-2rem)]/>", 1, 4, ".w-[calc(100%-2rem)]"],
  ["<div.[&>*]:p-4/>", 1, 4, ".[&"],
];

describe.each(ENTRIES)("a bracket shorthand through %s", (_name, run) => {
  it.each(BRACKETS)("%j is a positioned error with the class hint", (source, line, column, token) => {
    const error = run(source);
    expect(isTranslateError(error)).toBe(true);
    const { message } = error as { message: string };
    expect(message).toContain(`\`${token}\` cannot hold this class`);
    expect(message).toContain('write it as `class="..."`');
    expect(message).not.toContain("markojs.com");
    expect(error).toMatchObject({ line, column });
  });
});

describe("a `/` after a tag-adjacent shorthand through compileSource", () => {
  it("`<div.w-1/2/>` names the shorthand, not Marko's tag variable", () => {
    const error = viaCompile("<div.w-1/2/>");
    expect(isTranslateError(error)).toBe(true);
    const { message } = error as { message: string };
    expect(message).toContain("`.w-1/2` cannot hold this class");
    expect(message).toContain('write it as `class="..."`');
    expect(message).not.toContain("tag variable");
    expect(error).toMatchObject({ line: 1, column: 4 });
  });
});

describe("unrelated parse errors are not rewritten", () => {
  it.each(ENTRIES)("%s keeps Marko's missing-ending error", (_name, run) => {
    const error = run("<div>\n");
    expect(isTranslateError(error)).toBe(false);
    expect((error as { message: string }).message).not.toContain(
      'class="..."',
    );
  });

  it.each(ENTRIES)(
    "%s keeps an attribute-value bracket error Marko's",
    (_name, run) => {
      const error = run("<div title=a]b/>");
      expect(isTranslateError(error)).toBe(false);
      expect((error as { message: string }).message).not.toContain(
        "cannot hold this class",
      );
    },
  );
});
