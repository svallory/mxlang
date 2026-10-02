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
 * Detection scans the *raw source* of the node's own span, not the normalized
 * `Text.value`, so a match's position is exact whatever whitespace Marko
 * collapsed. The span is found by walking the source against `value` and
 * stops at the first mismatch, so in concise mode (where a text node ends at
 * its line, with no `<`) the scan never reaches the next lines' attributes.
 * Nothing here sees an attribute value, a `${…}` placeholder (so `${"{{"}` is
 * the escape for a real literal), a comment, or script/style content: those
 * are never `Text` nodes.
 *
 * Only unambiguous shapes warn. `{{` needs its closing `}}`; `@name` needs
 * the block keyword at a word start *and* real block syntax after it: a
 * balanced `(…)` then `{` (`@if`, `@for`, …), a bare `{` (`@else`, …), or
 * `name = …;` (`@let`). So `user@host`, `the @if keyword`, `Ping me @if (now)
 * only` and `@let me know` stay silent; a lone `{`/`}` never warns. Each
 * message also names the escape (`${"{{"}`, `${"@"}if`) for literal text.
 */

import type { MxWarning } from "@mxlang/core";
import { parse } from "@mxlang/parser";
import { offsetAt } from "./mapping.ts";

/** Control-flow keywords Angular reads after `@`. */
const BLOCK_KEYWORDS =
  "else\\s+if|if|else|for|switch|case|default|empty|defer|placeholder|loading|error|let";

const BLOCK = new RegExp(`(?<![\\w@.$-])@(${BLOCK_KEYWORDS})(?![\\w$-])`, "g");

/** Keywords whose `(…)` is required / optional before the block's `{`. */
const NEEDS_PAREN = new Set(["if", "else if", "for", "switch", "case"]);
const MAY_PAREN = new Set(["defer", "placeholder", "loading"]);

/**
 * Whether `expr` has an Angular pipe: any single `|` outside a string literal,
 * at any depth. Angular has no bitwise OR, so only `||` is not a pipe.
 */
function hasPipe(expr: string): boolean {
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = expr.indexOf(c, i + 1);
      if (close < 0) return false;
      i = close;
    } else if (c === "|") {
      if (expr[i + 1] === "|") i++;
      else return true;
    }
  }
  return false;
}

/** Whether `${expr}` is a valid, same-meaning MX rewrite of `{{ expr }}`. */
function isRewritable(expr: string): boolean {
  if (!expr || hasPipe(expr)) return false;
  try {
    parse(`(${expr});`, "x.ts");
    return true;
  } catch {
    return false;
  }
}

const LET_DECL = /^\s+([A-Za-z_$][\w$]*)\s*=([^;]*);/;

/**
 * The end of the `Text` node's own source span, found by walking the source
 * from `start` while it matches the node's normalized `value` (whitespace runs
 * match whitespace runs; an `&…;` entity matches the one character it decodes
 * to). Stops at the first mismatch.
 */
function runEnd(source: string, start: number, value: string): number {
  const blank = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let i = start;
  let j = 0;
  while (j < value.length) {
    const c = source[i];
    if (c === undefined) break;
    if (blank(value[j])) {
      while (blank(value[j])) j++;
      while (blank(source[i])) i++;
    } else if (c === value[j]) {
      i++;
      j++;
    } else if (blank(c)) i++;
    else if (c === "&") {
      const entity = /^&(#\d+|#x[\da-f]+|\w+);/i.exec(source.slice(i, i + 12));
      if (!entity) break;
      i += entity[0].length;
      j += (value.codePointAt(j) ?? 0) > 0xffff ? 2 : 1;
    } else break;
  }
  return i;
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

/**
 * Whether the text after `@keyword` is real block syntax: `(…)` then `{` (or a
 * bare `{`), or `name = …;` for `@let`. Returns the condition when it has one.
 */
function blockAfter(
  keyword: string,
  text: string,
  from: number,
): { cond: string | undefined; decl?: string } | undefined {
  if (keyword === "let") {
    const m = LET_DECL.exec(text.slice(from));
    return m ? { cond: undefined, decl: `${m[1]}=${m[2]?.trim()}` } : undefined;
  }
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

/** The MX form of a block, or `undefined` when MX has none (Angular-only blocks). */
function blockHint(
  keyword: string,
  cond: string | undefined,
  decl: string | undefined,
): string | undefined {
  // A pipe or a `;` (`as x`, `track …`, `let i = …`) has no MX form: don't inline it.
  const plain = cond !== undefined && !hasPipe(cond) && !cond.includes(";");
  const c = cond && plain ? cond : "…";
  switch (keyword) {
    case "if":
      return `\`<if=${c}>…</if>\``;
    case "else if":
      return `\`<else if=${c}>…</else>\``;
    case "else":
      return "`<else>…</else>`";
    case "for": {
      const m = plain ? /^(\S+)\s+of\s+(.+)$/.exec(cond ?? "") : null;
      return m
        ? `\`<for|${m[1]}| of=${m[2]?.trim()}>…</for>\``
        : "`<for|…| of=…>…</for>`";
    }
    case "switch":
    case "case":
    case "default":
      return "an `<if>`/`<else if>` chain";
    case "let":
      return `\`<const/${decl ?? "name=…"}>\``;
    default:
      return undefined;
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
 * the normalized text: it bounds the scan to the node's own span.
 */
export function literalSyntaxWarnings(
  value: string,
  loc: { line: number; column: number },
  source: string,
): MxWarning[] {
  if (!value.includes("{{") && !value.includes("@")) return [];
  const start = offsetAt(source, loc);
  const run = source.slice(start, runEnd(source, start, value));
  const found: { index: number; message: string }[] = [];

  for (let i = run.indexOf("{{"); i >= 0; i = run.indexOf("{{", i + 2)) {
    const close = run.indexOf("}}", i + 2);
    if (close < 0) break;
    const expr = run.slice(i + 2, close).trim();
    const advice = isRewritable(expr)
      ? `Write \`\${${expr}}\`, or use`
      : hasPipe(expr)
        ? "Pipes have no MX form (call the function in `${…}`), or use"
        : "Use";
    found.push({
      index: i,
      message: `\`{{ ${expr ? `${expr} ` : ""}}}\` is literal text in an MX template, not an Angular interpolation. ${advice} \`\${"{{"}\` for literal braces.`,
    });
    i = close;
  }

  for (const m of run.matchAll(BLOCK)) {
    const keyword = (m[1] as string).replace(/\s+/g, " ");
    const block = blockAfter(keyword, run, m.index + m[0].length);
    if (!block) continue;
    const hint = blockHint(keyword, block.cond, block.decl);
    const literal = `\`\${"@"}${keyword.split(" ")[0]}\``;
    found.push({
      index: m.index,
      message: hint
        ? `${describe(keyword, block.cond)} is literal text in an MX template, not Angular control flow. Use ${hint}, or ${literal} for literal text.`
        : `${describe(keyword, block.cond)} is literal text in an MX template; MX has no equivalent of this Angular block. Use ${literal} for literal text.`,
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
