/**
 * Today's lowering pass (`core/src/lower.ts` behind `@marko/compiler`'s
 * Program:exit), as `name-sugar.test`'s `lowerSource` runs it: the first
 * error it throws on one input, message and offset — the oracle for the
 * front end's `MX_*` rules (ast §3.13), which keep today's text and
 * position. Lowering-owned errors (duplicate defaults, host policy, tag
 * discovery) also surface here; the differential names what it skips.
 */

import type { Policy } from "@mxlang/core";
import {
  CORE_TAGLIB,
  lower,
  markoCompiler,
  newCtx,
  printExpression,
} from "@mxlang/core";
import { lineStartsOf } from "./rules.ts";

const policy: Policy = {
  tags: {},
  isElement: () => true,
  // `name-sugar.test`'s harness: a tag is a component when the file defines it.
  isComponent: (name: string, ctx: unknown) =>
    (ctx as { defines: Set<string> }).defines.has(name),
  resolveDefaultTag: () => "input",
};

export interface LowerOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly start: number;
}

/** The first error today's lowering throws on `source`, or `ok`. */
export function lowerToday(source: string): LowerOutcome {
  let thrown: unknown = null;
  const translator = {
    taglibs: [["mx-translator-core", CORE_TAGLIB]],
    tagDiscoveryDirs: [],
    translate: {
      Program: {
        exit(path: unknown) {
          try {
            const ctx = newCtx(
              source,
              printExpression,
              policy as never,
              undefined,
              "/differential/s.mx",
              undefined as never,
            );
            lower(ctx, (path as { node: { body: unknown[] } }).node.body);
          } catch (error) {
            thrown = error;
          }
          (path as { node: { body: unknown[] } }).node.body = [];
        },
      },
    },
  };
  try {
    (
      markoCompiler() as { compileSync: (...args: unknown[]) => unknown }
    ).compileSync(source, "/differential/s.mx", {
      translator,
      output: "html",
      writeVersionComment: false,
    });
  } catch (error) {
    thrown = thrown ?? error;
  }
  if (thrown === null) return { ok: true, message: "", start: -1 };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes needs the escape byte
  const ansi = /\u001b\[[0-9;]*m/g;
  const plain = String((thrown as Error)?.message ?? thrown)
    .replace(ansi, "")
    // Babel parse errors lead with the compile file's location, rendered
    // relative to the process cwd (../../…/differential/s.mx locally,
    // ../../differential/s.mx from the repo root). Normalize the prefix so
    // today-first reason pins are cwd-independent.
    .replace(/(?:\.\.\/)+differential\/s\.mx/g, "s.mx");
  const message = plain.split("\n").find((l) => l.trim()) ?? "";
  const loc = (thrown as { loc?: unknown }).loc;
  const line =
    (loc as { start?: { line?: number } })?.start?.line ??
    (thrown as { line?: number }).line;
  const column =
    (loc as { start?: { column?: number } })?.start?.column ??
    (thrown as { column?: number }).column;
  const starts = lineStartsOf(source);
  const start =
    line === undefined || line === null
      ? -1
      : (starts[line - 1] ?? 0) + (column ?? 0);
  return { ok: false, message: message.trim(), start };
}
