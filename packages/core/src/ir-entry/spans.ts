/**
 * The IR the entry point hands out (decision 204): the lowered `Ir` with the
 * span guarantee in its type, and the copy `lowerSource` returns.
 */

import { cloneIr } from "../clone-ir.ts";
import type {
  Attr,
  AttributeTag,
  DelegatedTag,
  Expr,
  ImportName,
  Ir,
  IrNode,
} from "../ir.ts";
import type { SourceSpan } from "../mapping.ts";

/**
 * Keys `Spanned` leaves as declared: parser nodes (core's `Node` is `any`),
 * a host's own data, positions, and the template metadata.
 */
type Opaque =
  | "node"
  | "paramNodes"
  | "declaration"
  | "data"
  | "loc"
  | "end"
  | "tagMetadata";

type Primitive = string | number | boolean | bigint | symbol;

type SpannedObject<T> = {
  [K in keyof T]: K extends Opaque
    ? T[K]
    : K extends "span"
      ? SourceSpan
      : Spanned<T[K]>;
} & ("span" extends keyof T ? { span: SourceSpan } : unknown);

type StaticAttr = Extract<Attr, { kind: "static" }>;
type ImportNode = Extract<IrNode, { kind: "Import" }>;

/**
 * `T` with every `span` required, at every depth: what `checks.ts` verified
 * before `lowerSource` returned the IR. A `DelegatedTag` and an
 * `AttributeTag` also carry their `nameSpan`, and a `DelegatedTag` its
 * `args` (`[]` without arguments; `finishIr`). A static attribute carries its
 * `valueSpan` (an atom's and a member's included; an empty value's is
 * zero-width), and an `Import` its `from` and `names`. Other optional spans
 * (`bodySpan`, `paramSpans`) stay optional. @unstable
 */
export type Spanned<T> = T extends SourceSpan
  ? T
  : T extends Primitive | null | undefined
    ? T
    : // biome-ignore lint/complexity/noBannedTypes: any function passes through untouched
      T extends Function
      ? T
      : T extends readonly (infer U)[]
        ? Spanned<U>[]
        : T extends DelegatedTag<unknown>
          ? SpannedObject<T> & { nameSpan: SourceSpan; args: Spanned<Expr>[] }
          : T extends AttributeTag
            ? SpannedObject<T> & { nameSpan: SourceSpan }
            : T extends StaticAttr
              ? SpannedObject<T> & { valueSpan: SourceSpan }
              : T extends ImportNode
                ? SpannedObject<T> & {
                    from: string;
                    names: Spanned<ImportName>[];
                  }
                : T extends object
                  ? SpannedObject<T>
                  : T;

/** The IR `lowerSource` returns: every node, attribute and expression spanned. @unstable */
export type SpannedIr = Spanned<Ir>;

/**
 * A tag's span without the line terminator that follows it.
 *
 * In concise mode core measures a tag through the end of the line it ends
 * on, so `b` + `  c` arrives as `"b\\n  c\\n"`. A `<tag/>` span never carries
 * the terminator, and a tag's span is "opening tag, body and closing tag":
 * the line terminator is neither. Every trailing `\r`/`\n` goes; a blank line
 * between the tag and the next one is not part of it either way, and
 * trimming is idempotent.
 */
function withoutTrailingNewline(span: SourceSpan, source: string): SourceSpan {
  let end = span.sourceEnd;
  while (end > span.sourceStart) {
    const code = source.charCodeAt(end - 1);
    if (code !== 10 && code !== 13) break;
    end -= 1;
  }
  return end === span.sourceEnd
    ? span
    : { sourceStart: span.sourceStart, sourceEnd: end };
}

/**
 * The IR `lowerSource` returns: a copy of the checked `ir` (the lowered one
 * may be frozen, and is core's), with each `DelegatedTag`'s and
 * `AttributeTag`'s span trimmed of its trailing line terminator and every
 * `DelegatedTag.args` present (`[]` when the tag has none).
 */
export function finishIr(ir: Ir, source: string): SpannedIr {
  const copy = cloneIr(ir);
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "DelegatedTag" || record.kind === "AttributeTag") {
      const tag = record.tag as DelegatedTag<unknown> | AttributeTag;
      if (tag.span) tag.span = withoutTrailingNewline(tag.span, source);
      if (record.kind === "DelegatedTag") {
        (tag as DelegatedTag<unknown>).args ??= [];
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "node" || key === "paramNodes" || key === "data") continue;
      visit(child);
    }
  };
  visit(copy);
  return copy as unknown as SpannedIr;
}
