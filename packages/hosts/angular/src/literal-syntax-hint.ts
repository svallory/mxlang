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
 * the block keyword at a word start *and* real block syntax after it: a
 * balanced `(…)` then `{` (`@if`, `@for`, …), a bare `{` (`@else`, …), or
 * `name = …;` (`@let`). So `user@host`, `the @if keyword`, `Ping me @if (now)
 * only` and `@let me know` stay silent; a lone `{`/`}` never warns. Each
 * message also names the escape (`${"{{"}`, `${"@"}if`) for literal text.
 */

import type { MxWarning } from "@mxlang/core";
import { offsetAt } from "./mapping.ts";

/** Control-flow keywords Angular reads after `@`. */
const BLOCK_KEYWORDS =
  "else if|if|else|for|switch|case|default|empty|defer|placeholder|loading|error|let";

const BLOCK = new RegExp(`(?<![\\w@.$-])@(${BLOCK_KEYWORDS})(?![\\w$-])`, "g");

/** Keywords whose `(…)` is required / optional before the block's `{`. */
const NEEDS_PAREN = new Set(["if", "else if", "for", "switch", "case"]);
const MAY_PAREN = new Set(["defer", "placeholder", "loading"]);

/** A `{{ … }}` body of only bare words: prose, not an expression to suggest. */
const PROSE = /^[A-Za-z]+(\s+[A-Za-z]+)+$/;

const LET_DECL = /^\s+[A-Za-z_$][\w$]*\s*=[^;]*;/;

/**
 * Whether the text after `@keyword` is real block syntax: `(…)` then `{` (or a
 * bare `{`), or `name = …;` for `@let`. Returns the condition when it has one.
 */
function blockAfter(
  keyword: string,
  text: string,
  from: number,
): { cond: string | undefined } | undefined {
  if (keyword === "let")
    return LET_DECL.test(text.slice(from)) ? { cond: undefined } : undefined;
  let at = from;
  let cond: string | undefined;
  const paren = /^\s*\(/.exec(text.slice(from));
  if (paren) {
    if (!NEEDS_PAREN.has(keyword) && !MAY_PAREN.has(keyword)) return undefined;
    const group = parenBody(text, from + paren[0].length - 1);
    if (!group) return undefined;
    cond = group.body;
    at = group.end;
  } else if (NEEDS_PAREN.has(keyword)) return undefined;
  return /^\s*\{/.test(text.slice(at)) ? { cond } : undefined;
}

/** The text run that starts at `start`: up to the next `<` or placeholder. */
function runEnd(source: string, start: number): number {
  const stop = /<|\$!?\{/g;
  stop.lastIndex = start;
  const m = stop.exec(source);
  return m ? m.index : source.length;
}

/** The text inside the balanced `(…)` opening at `open`, and the index after its `)`. */
function parenBody(
  text: string,
  open: number,
): { body: string; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return undefined;
      i = close;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0)
      return { body: text.slice(open + 1, i).trim(), end: i + 1 };
  }
  return undefined;
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
    const write = PROSE.test(expr) || !expr ? "" : `Write \`\${${expr}}\`, or `;
    found.push({
      index: i,
      message: `\`{{ ${expr ? `${expr} ` : ""}}}\` is literal text in an MX template, not an Angular interpolation. ${write}${write ? "use" : "Use"} \`\${"{{"}\` for literal braces.`,
    });
    i = close;
  }

  for (const m of run.matchAll(BLOCK)) {
    const keyword = m[1] as string;
    const block = blockAfter(keyword, run, m.index + m[0].length);
    if (!block) continue;
    found.push({
      index: m.index,
      message: `${describe(keyword, block.cond)} is literal text in an MX template, not Angular control flow. Use ${blockHint(keyword, block.cond)}, or \`\${"@"}${keyword.split(" ")[0]}\` for literal text.`,
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
