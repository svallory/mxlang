import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * A parse failure inside a tag's `|params|` (an empty default in a destructured
 * param: `<define/Foo|{a=}|>`) threw Marko's `CompileError` with `line` and
 * `column` 0 and a message that opens with an empty line. It is a positioned
 * error now, carrying Babel's reason, on both of core's parse entries.
 */

const host: HostDeclarations = {
  name: "tag-param-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

/** A region's route: Marko recovers the bad param, `lower` reports it. */
function viaFragment(source: string): unknown {
  try {
    const ctx = newCtx(
      source,
      printExpression,
      host,
      undefined,
      "/tmp/tag-param.mx",
      lookup,
    );
    lower(ctx, parseFragment(source).body);
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaCompile(source: string): unknown {
  try {
    compileSource(source, "/tmp/tag-param.mx", host, {
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

// [source, line (1-based), column (0-based) of the token Babel rejects]
const BAD: [string, number, number][] = [
  ["<define/Foo|{a=}|><b/></define>", 1, 15],
  ["<define/Foo|{a=}|/>", 1, 15],
  ["<for|{a=}| of=x><b/></for>", 1, 8],
  ["<div>\n  <define/Foo|{a=}|/>\n</div>", 2, 17],
  ["<define/Foo|{a=, b}|/>", 1, 15],
  ["<define/Foo|a b|><b/></define>", 1, 14],
];

describe.each(ENTRIES)(
  "%s: a parse failure inside tag params",
  (_name, run) => {
    it.each(BAD)("%j is positioned at the param", (source, line, column) => {
      const error = run(source);
      expect(error).toMatchObject({ name: "TranslateError", line, column });
      const { message } = error as Error;
      expect(message).not.toBe("");
      expect(message.split("\n")).toHaveLength(1);
      expect(message).toMatch(/^[A-Z]/);
    });

    it("carries Babel's own reason", () => {
      expect((run("<define/Foo|{a=}|/>") as Error).message).toBe(
        "Unexpected token",
      );
    });

    it.each([
      "<define/Foo|{a}|><b/></define>",
      "<define/Foo|{a = 1}|><b/></define>",
      "<for|x, i| of=y><b/></for>",
    ])("%j still compiles", (source) => {
      expect(run(source)).toBeUndefined();
    });

    it("leaves a failure outside any params alone", () => {
      const error = run("<div x=(a/>") as Error & { loc?: unknown };
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("EOF reached");
    });
  },
);
