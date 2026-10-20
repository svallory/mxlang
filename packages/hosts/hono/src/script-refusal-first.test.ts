/**
 * Wiring spot-check: the `<script>` host refusal fires before the body is
 * read, through both doors, with Hono's dialect name in the message. The full
 * first-diagnostic matrix is pinned once in
 * `packages/hosts/preact/src/script-refusal-first.test.ts`.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { createTargetLookup } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compileHonoMx, compileHonoRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

interface Refusal {
  message: string;
  code?: string;
  line: number;
  column: number;
}

function refusal(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    const e = error as Refusal & { diagnosticCode?: string };
    return {
      message: stripAnsi(e.message),
      code: e.diagnosticCode,
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error");
}

const whole = (source: string) =>
  refusal(() => compileHonoMx(source, "/fixtures/whole.mx", { targets }));

// A region inside a module: file line 3 (0-based 2), column 4, offset 40.
const region = (source: string) =>
  refusal(() =>
    compileHonoRegion(source, {
      filename: "/fixtures/Panel.hono.mx",
      baseOffset: 40,
      baseLine: 2,
      baseColumn: 4,
      targets,
    }),
  );

const REFUSAL =
  "`<script>` is not supported in embedded MX on Hono. Write client code in a module the component imports.";
const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("Hono: a <script> is refused before its body is read", () => {
  it.each([
    ["a body that does not parse", "<script>const = 1;</script>"],
    ["a placeholder in the body", "<script>go(${x})</script>"],
  ])("%s: the host refusal is the only error", (_name, source) => {
    expect(whole(source)).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 1,
      column: 0,
    });
    expect(region(`<div/>\n${source}`)).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 4,
      column: 0,
    });
  });
});
