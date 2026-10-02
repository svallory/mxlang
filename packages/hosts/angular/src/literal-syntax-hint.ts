/**
 * A positioned warning for Angular template syntax written as literal text in
 * an MX template (audit item 7, decision 126).
 *
 * Marko reads `{{ name }}` and `@if (x) {` as plain text (neither `{` nor `@`
 * means anything to its parser; only `${…}` and `<…>` do), so the template
 * compiles and the text reaches Angular escaped, rendered literally. The
 * author wrote Angular and got a page that "does nothing" with no error. This
 * lint lives in the angular host alone: core stays host-agnostic, and the
 * emitter already sees each `Text` node together with `ctx.source` and the
 * node's source position.
 *
 * Detection scans the *raw source* of the text run, not the normalized
 * `Text.value`, so a match's position is exact whatever whitespace Marko
 * collapsed. A run ends at the first `<` or `${`/`$!{` after its start, which
 * are the only things that end a text node. Nothing here sees an attribute
 * value, a `${…}` placeholder (so `${"{{"}` is the escape for a real literal),
 * a comment, or script/style content: those are never `Text` nodes.
 *
 * Only unambiguous shapes warn. `{{` needs its closing `}}`; `@name` needs
 * the block keyword *and* a following `(` or `{`, at a word start (so
 * `user@host` and `the @if keyword` stay silent); a lone `{`/`}` never warns.
 */

import type { MxWarning } from "@mxlang/core";
import { offsetAt } from "./mapping.ts";

/** Control-flow keywords Angular reads after `@`. */
const BLOCK_KEYWORDS =
  "else if|if|else|for|switch|case|default|empty|defer|placeholder|loading|error|let";

const BLOCK = new RegExp(
  `(?<![\\w@.$-])@(${BLOCK_KEYWORDS})(?![\\w$-])(?=\\s*[({]|\\s+\\w+\\s*=)`,
  "g",
);

/** The text run that starts at `start`: up to the next `<` or placeholder. */
function runEnd(source: string, start: number): number {
  const stop = /<|\$!?\{/g;
  stop.lastIndex = start;
  const m = stop.exec(source);
  return m ? m.index : source.length;
}

/** The text inside the balanced `(…)` opening at `open`, or `undefined`. */
function parenBody(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return undefined;
      i = close;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return undefined;
}

/** The condition after `@keyword`, when it is a parenthesised one. */
function conditionAfter(text: string, from: number): string | undefined {
  const at = /^\s*\(/.exec(text.slice(from));
  if (!at) return undefined;
  return parenBody(text, from + at[0].length - 1)?.trim();
}

function blockHint(keyword: string, cond: string | undefined): string {
  const c = cond || "…";
  switch (keyword) {
    case "if":
      return `\`<if=${c}>…</if>\``;
    case "else if":
      return `\`<else if=${c}>…</else>\``;
    case "else":
      return "`<else>…</else>`";
    case "for": {
      const m = /^(\S+)\s+of\s+([^;]+)/.exec(cond ?? "");
      return m
        ? `\`<for|${m[1]}| of=${m[2]?.trim()}>…</for>\``
        : "`<for|item| of=items>…</for>`";
    }
    case "switch":
      return `\`<if=${c} === …>\`/\`<else if=…>\` chains`;
    default:
      return "MX's own control-flow tags (`<if>`, `<else if>`, `<else>`, `<for>`)";
  }
}

function describe(keyword: string, cond: string | undefined): string {
  const c = cond === undefined ? "" : ` (${cond})`;
  const shape = keyword === "let" ? `@let` : `@${keyword}${c}`;
  return `\`${shape}…\``;
}

/** `line`/`column` of `offset` in `source`, in the convention of `node.loc`. */
function positionOf(
  source: string,
  offset: number,
  from: { line: number; column: number },
  fromOffset: number,
): { line: number; column: number } {
  let line = from.line;
  let lineStart = -1;
  for (let i = fromOffset; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i;
    }
  }
  return lineStart < 0
    ? { line, column: from.column + (offset - fromOffset) }
    : { line, column: offset - lineStart - 1 };
}

/**
 * The warnings for one `Text` node whose source starts at `loc`. `value` is
 * the normalized text, used only to skip a node that cannot hold a match.
 */
export function literalSyntaxWarnings(
  value: string,
  loc: { line: number; column: number },
  source: string,
): MxWarning[] {
  if (!value.includes("{{") && !value.includes("@")) return [];
  const start = offsetAt(source, loc);
  const run = source.slice(start, runEnd(source, start));
  const found: { index: number; message: string }[] = [];

  for (let i = run.indexOf("{{"); i >= 0; i = run.indexOf("{{", i + 2)) {
    const close = run.indexOf("}}", i + 2);
    if (close < 0) break;
    const expr = run.slice(i + 2, close).trim();
    found.push({
      index: i,
      message: expr
        ? `\`{{ ${expr} }}\` is literal text in an MX template, not an Angular interpolation. Write \`\${${expr}}\`.`
        : "`{{ }}` is literal text in an MX template, not an Angular interpolation. Write `${expr}`.",
    });
    i = close;
  }

  for (const m of run.matchAll(BLOCK)) {
    const keyword = m[1] as string;
    const cond = conditionAfter(run, m.index + m[0].length);
    found.push({
      index: m.index,
      message: `${describe(keyword, cond)} is literal text in an MX template, not Angular control flow. Use ${blockHint(keyword, cond)}.`,
    });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, message }) => ({
      message,
      ...positionOf(source, start + index, loc, start),
      code: LITERAL_SYNTAX_CODE,
    }));
}

/** Marks these warnings so a caller can tell them from the emitter's other advice. */
export const LITERAL_SYNTAX_CODE = "mx-angular-literal-syntax";
