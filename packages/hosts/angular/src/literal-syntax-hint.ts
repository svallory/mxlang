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
 * The index of the quote closing the string opened at `open`, skipping `\x`
 * escapes; -1 if unclosed. A backtick string's `${…}` interpolations are
 * *code*, not text: each is scanned to its matching `}` (strings inside it,
 * backticks included, are skipped the same way), so a backtick or quote
 * inside `${…}` never masquerades as the string's end.
 */
function closingQuote(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (quote === "`" && c === "$" && text[i + 1] === "{") {
      const close = closingBrace(text, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === quote) return i;
  }
  return -1;
}

/** The index of the `}` matching the `{` at `open`, skipping strings; -1 if unclosed. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = closingQuote(text, i);
      if (close < 0) return -1;
      i = close;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Whether `expr` has an Angular pipe: any single `|` outside a string literal,
 * at any depth. Angular has no bitwise OR, so only `||` is not a pipe. A
 * template literal's text runs are string content, but each `${…}` region is
 * code and is scanned for a pipe too (`hasPipe` recurses).
 */
function hasPipe(expr: string): boolean {
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const close = closingQuote(expr, i);
      if (close < 0) return false;
      i = close;
    } else if (c === "`") {
      const close = closingQuote(expr, i);
      if (close < 0) return false;
      for (let j = i + 1; j < close; j++) {
        if (expr[j] === "$" && expr[j + 1] === "{") {
          const end = closingBrace(expr, j + 1);
          if (end < 0) return false;
          if (hasPipe(expr.slice(j + 2, end))) return true;
          j = end;
        }
      }
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

/**
 * Entities that decode to a string-literal quote char, as a raw-source
 * spelling -> quote map. `letDecl` scans the raw span (Marko decodes the
 * entities in the Text *value*, but the span keeps `&#96;`), so a quoted
 * value can be entity-wrapped; without this, the entity's own `;` would cut
 * the value (`@let z = &#96;a;b&#96;;` -> `&#96`). Numeric forms accept any
 * zero-padding and case (`&#x60;`, `&#X60;`, `&#096;`).
 */
const ENTITY_QUOTES: [RegExp, string][] = [
  [/&#0*96;/i, "`"],
  [/&#0*34;/i, '"'],
  [/&#0*39;/i, "'"],
  [/&quot;/i, '"'],
  [/&apos;/i, "'"],
  [/&#x0*60;/i, "`"],
  [/&#x0*22;/i, '"'],
  [/&#x0*27;/i, "'"],
];

/** The quote an entity at `text[i]` decodes to, or `undefined`. */
function entityQuote(text: string, i: number): string | undefined {
  for (const [entity, quote] of ENTITY_QUOTES) {
    entity.lastIndex = 0;
    if (entity.test(text.slice(i, i + 12))) return quote;
  }
  return undefined;
}

/**
 * The `name` and `value` of a `@let name = value;` whose head starts at the
 * beginning of `text`. The value ends at the first `;` *outside* a string
 * literal — a `;` inside `'x;y'` does not cut it — and a template literal's
 * `${…}` regions count as code, so quotes inside them don't either. A value
 * whose quotes are entity-encoded (`&#96;…&#96;`) is skipped as a pair; a
 * lone entity-quote with no pair falls back to the `…` placeholder rather
 * than inlining a truncated value.
 */
function letDecl(text: string): { name: string; value: string } | undefined {
  const m = /^\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(text);
  if (!m) return undefined;
  const start = m[0].length;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "&") {
      const quote = entityQuote(text, i);
      if (!quote) continue;
      // The same entity spelling closes the pair; content between is opaque.
      const entity = text.slice(i, i + 12).match(/^&[^;]*;/)?.[0];
      const close = text.indexOf(entity ?? "", i + (entity?.length ?? 0));
      if (close < 0) return { name: m[1] ?? "", value: "…" };
      i = close + (entity?.length ?? 1) - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const close = closingQuote(text, i);
      if (close < 0) return undefined;
      i = close;
    } else if (c === ";") {
      return { name: m[1] ?? "", value: text.slice(start, i).trim() };
    }
  }
  return undefined;
}

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
      const close = closingQuote(text, i);
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
    const decl = letDecl(text.slice(from));
    if (!decl) return undefined;
    const value = decl.value;
    // A pipe in the value has no MX form: keep the placeholder, not the expression.
    return {
      cond: undefined,
      decl: `${decl.name}=${hasPipe(value) ? "…" : value}`,
    };
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
