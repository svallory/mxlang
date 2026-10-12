/**
 * What lowering records about custom tag calls for a dialect's `afterLower`
 * (`LoweredUnit`): the calls with their authored ancestors, the names an
 * `analyze` hook declared with `ctx.declare`, and the position of an offset.
 * Core records them and checks nothing about them; a dialect that claims
 * contract fields (`Dialect.contractFields`) reads them through the unit.
 */

import type { Ctx, Node } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { SourceSpan } from "./mapping.ts";

/** One custom tag call, with the authored tag instances around it. */
export interface ContractFact {
  definition: CustomTag;
  call: TagCall;
  /** Authored ancestors, outermost first, ending with the call's own node. */
  chain: Node[];
}

/** A name an `analyze` hook declared with `ctx.declare`. */
export interface DerivedDeclaration {
  kind: string;
  name: string;
  span: SourceSpan;
  scope?: string | string[];
}

/**
 * Where a warning on a call ends: `{ end }` at the end of its `<name`, when the
 * call is in this file and has a name span; nothing otherwise.
 */
export function callNameEnd(
  ctx: Ctx,
  call: Pick<TagCall, "loc" | "nameSpan">,
): { end?: { line: number; column: number } } {
  const to = call.nameSpan?.sourceEnd;
  if (call.loc.file !== undefined || to === undefined) return {};
  const at = positionAt(ctx, Math.max(to, 0));
  return { end: { line: at.line, column: at.column } };
}

/** The 1-based line and 0-based column of a source offset. */
export function positionAt(ctx: Ctx, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (const text of ctx.lines) {
    const lineEnd = lineStart + text.length;
    if (offset <= lineEnd) return { line, column: offset - lineStart };
    line++;
    lineStart = lineEnd + 1;
  }
  return {
    line: Math.max(1, ctx.lines.length),
    column: Math.max(0, offset - lineStart),
  };
}
