/**
 * The front-end `MX_*` rules (ast §3.13, PR 2b).
 *
 * Each finished tag hands itself to `frontEndRules` (via the seam in
 * `parse.ts`), in document order: innermost first on close, then its
 * ancestors at `stopAll` in the same order. The rules reproduce Marko's own
 * parse errors (`statementTagInHTMLMode`, scriptlet `%`, attribute tag at
 * root) with their message text and ranges, and the nameless concise tag.
 *
 * What is NOT here, on purpose (ast §3.13): a duplicate default value
 * (lowering's `MX_DUPLICATE_DEFAULT`) and the decision-174 bracket/numeric
 * shorthand errors (lowering's).
 */

import type { MxErrorCode, MxParseError } from "@mxlang/babel/mx-ast";
import type { TagBuilder } from "./parse.ts";

/** A builder in untyped form, as `parse.ts`'s builders are (copied, not typed). */
interface Any {
  // biome-ignore lint/suspicious/noExplicitAny: builders are deliberately untyped (see parse.ts)
  [key: string]: any;
}

/** What the rules may read of the parse: the local source, its base offset, and the statement keywords. */
export interface RuleContext {
  readonly source: string;
  readonly offset: number;
  readonly statementKeywords: ReadonlySet<string>;
}

/** Marko's own example of each statement keyword written correctly (chunk-src.js `statementTagExample`). */
const STATEMENT_EXAMPLE: Readonly<Record<string, string>> = {
  class: "class { … }",
  client: 'client console.log("…")',
  export: "export const value = …",
  import: 'import Tag from "<tag>"',
  server: 'server console.log("…")',
  static: "static const value = …",
};

/** `/tagVar` right after the tag name (Marko's `tagVarAfterNameReg`). */
const TAG_VAR_AFTER_NAME = /^\/([A-Za-z_$][\w$]*)/;

function error(
  _ctx: RuleContext,
  code: MxErrorCode,
  message: string,
  start: number,
  end: number,
): MxParseError {
  return {
    type: "MxParseError",
    start,
    end,
    code,
    origin: "front-end",
    message,
    context: null,
  };
}
// Local (parse-relative) offsets of a builder's absolute span.
function localOf(ctx: RuleContext, at: number): number {
  return at - ctx.offset;
}

/**
 * Marko's own parse errors the front end reproduces (ast §3.2 A20/A21, and
 * the attribute tag at root): same message text, same range.
 */
function markoFrontRules(
  ctx: RuleContext,
  errs: MxParseError[],
  tag: TagBuilder,
  parent: TagBuilder | undefined,
): void {
  const name = tag.name as Any;
  if (name?.kind === "static") {
    if (name.value === "%") {
      errs.push(
        error(
          ctx,
          "MX_RESERVED_TAG_NAME",
          "<% scriptlets %> are no longer supported.",
          name.span.start,
          name.span.end,
        ),
      );
      return;
    }
    if (!tag.concise && ctx.statementKeywords.has(name.value)) {
      const tagName = name.value;
      const after = ctx.source.slice(localOf(ctx, name.span.end));
      const message =
        tagName === "export" && TAG_VAR_AFTER_NAME.test(after)
          ? `The \`export\` statement does not support a tag variable. To publish a value to the parent template, use a \`<return>\` tag instead — \`<return=${TAG_VAR_AFTER_NAME.exec(after)?.[1]}>\` — and the parent names it with its own tag variable on this template's tag.`
          : `\`${tagName}\` is a statement, not an html tag: write it at the root of the template without angle brackets, eg \`${STATEMENT_EXAMPLE[tagName] ?? `${tagName} …`}\`.`;
      errs.push(
        error(
          ctx,
          "MX_STATEMENT_IN_HTML_MODE",
          message,
          name.span.start,
          name.span.end,
        ),
      );
      return;
    }
  }
  if (tag.type === "MxAttributeTag" && parent === undefined) {
    errs.push(
      error(
        ctx,
        "MX_ATTRIBUTE_TAG_AT_ROOT",
        "@tags must be nested within another element.",
        name.span.start,
        name.span.end,
      ),
    );
  }
}

/** The front-end rules over one finished tag (ast §3.13), in the order lowering checks them. */
export function frontEndRules(
  tag: TagBuilder,
  parent: TagBuilder | undefined,
  ctx: RuleContext,
): readonly MxParseError[] {
  const errs: MxParseError[] = [];
  const name = tag.name as Any;

  // A concise `,` line or `<,/>`: no tag was ever named (decision 163
  // addendum 13). The nameless node stays in the tree beside the error.
  if (tag._phantom) {
    errs.push(
      error(
        ctx,
        "MX_TAG_NAME_MISSING",
        "a `,` continues the attributes of the tag above; there is no tag here",
        name.span.start,
        name.span.end,
      ),
    );
    return errs;
  }

  markoFrontRules(ctx, errs, tag, parent);
  return errs;
}
