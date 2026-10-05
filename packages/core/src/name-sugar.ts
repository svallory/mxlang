import { type Ctx, type Node, TranslateError } from "./core.ts";
import { CORE_TAGLIB } from "./core-taglib.ts";
import { markoParser } from "./stock-parser.ts";

/**
 * Decision 146: `:name`, `#id` and `.class` sugar.
 *
 * `:val` sets `name="val"`, as `#val` sets `id` and `.val` sets `class`. They
 * work tag-adjacent (`<input:email>`, `<a.c:b#d>`), first in the attribute
 * list and after any attribute (`<input type="email" :email>`).
 *
 * Marko's parser has no notion of any of it: `:` is a tag-name character
 * (`<a:b>` is the tag `a:b`), a shorthand `.c:b` is the class `c:b`, a `#b`
 * attribute is named `#b`, and a first-position `:b` is the default attribute
 * with the modifier `b`. So the sugar is a rewrite of the parsed tree, run
 * once per tag before anything reads a tag name (`resolveUnnamedTags` calls
 * it, and so every path that lowers a tree sees the rewritten one):
 *
 * - a static tag name splits at its first `:` into the tag and a `name`
 *   attribute (an empty tag is unnamed and goes to the default-tag resolver);
 * - the static part of the shorthand `class`/`id` values splits the same way
 *   (a dynamic shorthand splits only its static tail);
 * - attributes named `#x`, `.x` and `:x` become `id`, class and `name`.
 *
 * After the rewrite the tag is what the author would have written without
 * the sugar, so every later rule (contracts, duplicate attributes, the
 * default-tag ladder) applies unchanged. A second `:` in the tag head is an
 * error: one name only.
 *
 * Every host applies it (decision 146, addendum 3). The one host-owned
 * exception is attribute-position `#x` on a host that declares
 * `claimsAttributeHash` (Angular's template reference).
 */

/**
 * What a tag name written in source means after the split: `resource:post` is
 * the tag `resource` (plus `name="post"`), `:title` is an unnamed tag. Pure, so
 * a parse-only pass (the data target's unknown-tag scan) applies the same rule
 * as the rewrite without running it. A name that starts with `@` (an attribute
 * tag) is a property key and is never split.
 */
export function sugarTagName(raw: string): { tag: string; unnamed: boolean } {
  if (raw.startsWith("@")) return { tag: raw, unnamed: false };
  const colon = raw.indexOf(":");
  if (colon < 0) return { tag: raw, unnamed: false };
  const tag = raw.slice(0, colon);
  return { tag, unnamed: tag === "" };
}

/** An identifier-like token, as Marko's own shorthand allows. */
const SUGAR_TOKEN = /^[A-Za-z_$][\w$-]*$/;

const done = new WeakSet<Node>();

interface Located {
  start: number;
  end: number;
}

/** One `:name` found in the tag head, before anything is rewritten. */
interface HeadName extends Located {
  name: string;
  /** Takes the colon (and the name) out of the node it was found in. */
  strip(): void;
}

function positionAt(ctx: Ctx, offset: number) {
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

function loc(ctx: Ctx, start: number, end: number) {
  return {
    start: { ...positionAt(ctx, start), index: start },
    end: { ...positionAt(ctx, end), index: end },
  };
}

function offsetOfPosition(
  ctx: Ctx,
  position: { line: number; column: number; index?: number },
): number {
  if (typeof position.index === "number") return position.index;
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    offset += (ctx.lines[line - 1]?.length ?? 0) + 1;
  }
  return Math.min(ctx.source.length, offset + position.column);
}

/** A node's source range; a template literal has none of its own, its quasis do. */
function rangeOf(ctx: Ctx, node: Node): Located {
  if (node?.loc) {
    return {
      start: offsetOfPosition(ctx, node.loc.start),
      end: offsetOfPosition(ctx, node.loc.end),
    };
  }
  if (typeof node?.start === "number" && typeof node?.end === "number") {
    return { start: node.start, end: node.end };
  }
  const quasis = node?.quasis;
  if (Array.isArray(quasis) && quasis.length > 0) {
    return {
      start: offsetOfPosition(ctx, quasis[0].loc.start),
      end: offsetOfPosition(ctx, quasis[quasis.length - 1].loc.end),
    };
  }
  return { start: Number.NaN, end: Number.NaN };
}

function startOf(ctx: Ctx, node: Node): number {
  return rangeOf(ctx, node).start;
}

function endOf(ctx: Ctx, node: Node): number {
  return rangeOf(ctx, node).end;
}

/** `line:column` of an offset, 1-based like the duplicate-attribute warning. */
function lineColumn(ctx: Ctx, offset: number): string {
  const at = positionAt(ctx, offset);
  return `${at.line}:${at.column + 1}`;
}

function failAt(ctx: Ctx, message: string, offset: number): never {
  const at = positionAt(ctx, offset);
  throw new TranslateError(message, at.line, at.column);
}

const SECOND_NAME =
  'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)';

function stringLiteral(ctx: Ctx, value: string, start: number, end: number) {
  return {
    type: "StringLiteral",
    value,
    extra: { raw: JSON.stringify(value), rawValue: value },
    start,
    end,
    loc: loc(ctx, start, end),
  };
}

/**
 * The attribute a sugar token becomes. `sugarNameSpan` is the whole authored
 * token (`:b`, `#b`, `.c`), which `lowerAttr` reads for the attribute's
 * `nameSpan`; the value is the identifier after the sigil.
 */
function sugarAttr(
  ctx: Ctx,
  name: string,
  token: Located,
  valueStart: number,
  value: string,
) {
  return {
    type: "MarkoAttribute",
    name,
    value: stringLiteral(ctx, value, valueStart, token.end),
    modifier: null,
    default: false,
    bound: false,
    arguments: undefined,
    sugarNameSpan: { start: token.start, end: token.end },
    sugarLabel: ctx.source.slice(token.start, token.end),
    start: token.start,
    end: token.end,
    loc: loc(ctx, token.start, token.end),
  };
}

/** `:name` in a tag head: the name must be an identifier-like token. */
function checkToken(ctx: Ctx, name: string, colon: number, form: string) {
  if (!SUGAR_TOKEN.test(name)) {
    failAt(
      ctx,
      name === ""
        ? `\`:\` in ${form} needs a name after it (\`:email\`)`
        : `\`:${name}\` in ${form} is not a name; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
      colon,
    );
  }
}

/**
 * The `:name` inside one shorthand value, if any, for the tag head.
 *
 * A `StringLiteral` is the static text (joined tokens, `c:b d`), a template
 * literal's static tail is its last quasi, anything else is dynamic and left
 * alone. Positions line up with the source one to one: the parser joins
 * tokens with a space where the source has a dot.
 */
function headNamesIn(ctx: Ctx, part: Node, found: HeadName[]): void {
  if (part?.type === "StringLiteral" && typeof part.value === "string") {
    const text: string = part.value;
    const idx = text.indexOf(":");
    if (idx < 0) return;
    const start = startOf(ctx, part);
    const stop = text.indexOf(" ", idx);
    const name = text.slice(idx + 1, stop < 0 ? text.length : stop);
    const rest = stop < 0 ? "" : text.slice(stop);
    const colon = start + idx;
    checkToken(ctx, name, colon, "a shorthand class or id");
    found.push({
      name,
      start: colon,
      end: colon + 1 + name.length,
      strip() {
        // The value's span stops before the colon, so it does not overlap the
        // `name`'s. (Tokens joined with a space keep the first token's span.)
        part.end = colon;
        part.loc = loc(ctx, start, colon);
        part.value = text.slice(0, idx) + rest;
        if (part.extra) {
          part.extra.raw = JSON.stringify(part.value);
          part.extra.rawValue = part.value;
        }
      },
    });
    // Anything after the name that holds a `:` is a second one.
    const again = rest.indexOf(":");
    if (again >= 0) {
      found.push({
        name: "",
        start: colon + 1 + name.length + again,
        end: colon + 1 + name.length + again + 1,
        strip() {},
      });
    }
    return;
  }
  if (part?.type === "TemplateLiteral" && Array.isArray(part.quasis)) {
    // A `:` before a `${…}` is neither a name nor a class character: a
    // shorthand class or id cannot contain `:` (divergences.md, row 4).
    for (const quasi of part.quasis.slice(0, -1)) {
      const before: string = quasi?.value?.raw ?? "";
      const at = before.indexOf(":");
      if (at >= 0) {
        failAt(
          ctx,
          'a `:` before a `${…}` in a shorthand class or id is not allowed: a shorthand cannot contain `:` (write the value as `class="…"`)',
          offsetOfPosition(ctx, quasi.loc.start) + at,
        );
      }
    }
    const tail = part.quasis[part.quasis.length - 1];
    const raw: string = tail?.value?.raw ?? "";
    const idx = raw.indexOf(":");
    if (idx < 0) return;
    const name = raw.slice(idx + 1);
    const colon = offsetOfPosition(ctx, tail.loc.start) + idx;
    checkToken(ctx, name, colon, "a shorthand class or id");
    found.push({
      name,
      start: colon,
      end: colon + 1 + name.length,
      strip() {
        tail.loc = loc(ctx, offsetOfPosition(ctx, tail.loc.start), colon);
        tail.value.raw = raw.slice(0, idx);
        if (typeof tail.value.cooked === "string") {
          tail.value.cooked = tail.value.cooked.slice(
            0,
            tail.value.cooked.indexOf(":"),
          );
        }
      },
    });
  }
}

/** The shorthand parts of a `class` attribute, whatever Marko merged them into. */
function shorthandClassParts(ctx: Ctx, attr: Node, regionEnd: number): Node[] {
  const value = attr.value;
  if (!attr.loc) {
    return value?.type === "ArrayExpression" ? [...value.elements] : [value];
  }
  const inRegion = (node: Node) => startOf(ctx, node) < regionEnd;
  // `<a.c class="z">`: Marko merges a string shorthand with a string class
  // into `${shorthand} ${class}`.
  if (
    value?.type === "TemplateLiteral" &&
    value.expressions?.length === 2 &&
    value.quasis?.length === 3 &&
    value.quasis[0].value.raw === "" &&
    value.quasis[1].value.raw === " " &&
    value.quasis[2].value.raw === "" &&
    inRegion(value.expressions[0])
  ) {
    return [value.expressions[0]];
  }
  if (value?.type === "ArrayExpression") {
    return value.elements.filter(inRegion);
  }
  return [];
}

/** Merges `.x` tokens into the tag's `class`, as the parser would have for `<a.c.x>`. */
function mergeClassTokens(
  ctx: Ctx,
  attrs: Node[],
  tokens: { value: string; start: number; end: number }[],
  at: number,
  regionEnd: number,
): void {
  if (tokens.length === 0) return;
  const first = tokens[0] as { start: number };
  const last = tokens[tokens.length - 1] as { end: number };
  const text = tokens.map((token) => token.value).join(" ");
  const sugar = stringLiteral(ctx, text, first.start, last.end);
  const existing = attrs.find(
    (attr) => attr.type === "MarkoAttribute" && attr.name === "class",
  );
  if (!existing) {
    attrs.splice(at, 0, {
      type: "MarkoAttribute",
      name: "class",
      value: sugar,
      modifier: null,
      default: false,
      bound: false,
      arguments: undefined,
      sugarNameSpan: { start: first.start - 1, end: last.end },
      sugarLabel: tokens.map((token) => `.${token.value}`).join(" "),
      start: first.start - 1,
      end: last.end,
      loc: loc(ctx, first.start - 1, last.end),
    });
    return;
  }
  const value = existing.value;
  const append = (node: Node, before = false) => {
    node.value = before ? `${text} ${node.value}` : `${node.value} ${text}`;
    if (node.extra) {
      node.extra.raw = JSON.stringify(node.value);
      node.extra.rawValue = node.value;
    }
  };
  // A diagnostic on the merged `class` names the sugar the author wrote and
  // sits on the first sugar token (a shorthand-only attribute has no source
  // position of its own, so it would otherwise point at the tag).
  const mark = (words: string[]) => {
    existing.sugarLabel = [...words, ...tokens.map((token) => token.value)]
      .map((word) => `.${word}`)
      .join(" ");
    existing.sugarNameSpan = { start: first.start - 1, end: last.end };
    existing.sugarAt = positionAt(ctx, first.start - 1);
  };
  // The shorthand part of the class, wherever Marko merged it: the sugar is
  // appended THERE, so `<div.c class="x" .d>` is `<div.c.d class="x">`. The
  // tokens are not contiguous (`<a.c #m .b>`), so no single span is honest:
  // the value keeps its first token's span.
  if (!existing.loc) {
    const shorthandWords =
      value?.type === "StringLiteral" ? String(value.value).split(" ") : [];
    if (value?.type === "StringLiteral") {
      append(value);
    } else if (value?.type === "ArrayExpression") {
      value.elements.push(sugar);
    } else {
      existing.value = { type: "ArrayExpression", elements: [value, sugar] };
    }
    mark(shorthandWords);
    return;
  }
  const parts = shorthandClassParts(ctx, existing, regionEnd);
  if (parts.length > 0) {
    const shorthandWords =
      parts[0]?.type === "StringLiteral"
        ? String(parts[0].value).split(" ")
        : [];
    if (value?.type === "ArrayExpression") {
      const lastPart = parts[parts.length - 1];
      const index = value.elements.indexOf(lastPart);
      if (lastPart?.type === "StringLiteral" && parts.length === 1) {
        append(lastPart);
      } else {
        value.elements.splice(index + 1, 0, sugar);
      }
    } else {
      // `${shorthand} ${class}`: the shorthand string grows.
      append(parts[0]);
    }
    mark(shorthandWords);
    return;
  }
  mark([]);
  // No shorthand and an authored literal: the value stays a literal (so the
  // contract checks judge what it is) and keeps its span; the sugar goes where
  // it was written, before or after the authored `class`.
  if (value?.type === "StringLiteral") {
    append(value, first.start < startOf(ctx, existing));
    return;
  }
  // A non-string literal folds the way Marko's class value does: `false`,
  // `0`, `null` and `undefined` drop out; other numbers and `true` stringify.
  const dropped =
    (value?.type === "BooleanLiteral" && !value.value) ||
    (value?.type === "NumericLiteral" && value.value === 0) ||
    value?.type === "NullLiteral" ||
    (value?.type === "Identifier" && value.name === "undefined");
  if (dropped) {
    existing.value = stringLiteral(ctx, text, first.start, last.end);
    return;
  }
  if (value?.type === "NumericLiteral" || value?.type === "BooleanLiteral") {
    const joined =
      first.start < startOf(ctx, existing)
        ? `${text} ${value.value}`
        : `${value.value} ${text}`;
    existing.value = stringLiteral(
      ctx,
      joined,
      startOf(ctx, value),
      endOf(ctx, value),
    );
    return;
  }
  // A dynamic authored class keeps the expression form, in written order.
  const sugarFirst = first.start < startOf(ctx, existing);
  existing.value = {
    type: "ArrayExpression",
    elements:
      value?.type === "ArrayExpression"
        ? sugarFirst
          ? [sugar, ...value.elements]
          : [...value.elements, sugar]
        : sugarFirst
          ? [sugar, value]
          : [value, sugar],
  };
}

/**
 * Does this attribute carry a sugar token: `#x`, `.x`, or the default
 * attribute with a modifier (`:x`)? A bound attribute, an attribute with
 * arguments or a method is never sugar (`value:fn:=x` stays what it is).
 */
function sugarKind(attr: Node): "#" | "." | ":" | undefined {
  if (attr?.type !== "MarkoAttribute" || attr.bound || attr.arguments) {
    return undefined;
  }
  if (
    attr.default === true &&
    attr.name === "value" &&
    typeof attr.modifier === "string" &&
    attr.modifier !== ""
  ) {
    return ":";
  }
  if (typeof attr.name !== "string") return undefined;
  if (attr.name.startsWith("#")) return "#";
  if (attr.name.startsWith(".")) return ".";
  return undefined;
}

/**
 * Splits `.c#m.d` into its `.`/`#` parts, outside any `${…}`: a placeholder's
 * own dots (`.a${input.s}`) are not separators.
 */
function splitShorthandChain(
  name: string,
): { sigil: string; word: string; index: number }[] {
  const parts: { sigil: string; word: string; index: number }[] = [];
  let depth = 0;
  let current: { sigil: string; word: string; index: number } | undefined;
  for (let at = 0; at < name.length; at++) {
    const char = name[at] as string;
    if (depth === 0 && (char === "." || char === "#")) {
      current = { sigil: char, word: "", index: at };
      parts.push(current);
      continue;
    }
    if (char === "$" && name[at + 1] === "{") {
      depth++;
      if (current) current.word += "${";
      at++;
      continue;
    }
    if (depth > 0 && char === "{") depth++;
    if (depth > 0 && char === "}") depth--;
    if (current) current.word += char;
  }
  return parts;
}

const ALREADY_HAS_DEFAULT = (form: string, first: string): string =>
  `${form} would set the default attribute (\`value\`), but the tag already has a default value (at ${first}); a sugar followed by \`=value\` or \`(params) { body }\` sets it (decision 146 addendum 4), so write \`value=…\` once`;

/** How many source characters the sugar token itself takes (`#x`, `:x`, `.c#d`, `.c:y`). */
function authoredTokenLength(attr: Node, kind: "#" | "." | ":"): number {
  if (kind === ":") return 1 + String(attr.modifier).length;
  const name = String(attr.name);
  return typeof attr.modifier === "string"
    ? name.length + 1 + attr.modifier.length
    : name.length;
}

const shorthandProbe = new Map<string, boolean>();

/** The probe cache is cleared past this many words (a long-lived server). */
export const SHORTHAND_CACHE_LIMIT = 1000;

/** Test seam: how many words the probe has cached. */
export function shorthandCacheSize(): number {
  return shorthandProbe.size;
}

/**
 * Is `word` something Marko's shorthand (`<a.word>`, `<a#word>`) accepts as
 * one token? Decided by the parser itself: the `htmljs-parser` that
 * `@marko/compiler` resolves parses `<a{sigil}{word}/>` and the word counts when
 * it comes back as exactly one shorthand part, with no error and no
 * placeholder. Its rule (`TAG_NAME` state, `htmljs-parser` 5.15.0): a shorthand
 * runs to whitespace, `=`, `:=`, `(`, `/`, `|`, `<`, `,` or `>`, and `.`/`#`
 * start the next part, so `1a`, `2xl`, `é`, `a@b` and `a+b` are all fine. The
 * pure fallback below mirrors that list for a probe that cannot run.
 */
export function isShorthandWord(sigil: string, word: string): boolean {
  const key = `${sigil}${word}`;
  const known = shorthandProbe.get(key);
  if (known !== undefined) return known;
  let answer: boolean;
  const parser = markoParser();
  if (parser) {
    const source = `<a${key}/>`;
    const seen: string[] = [];
    let failed = false;
    const part = (text: {
      quasis: { start: number; end: number }[];
      expressions?: unknown[];
    }) =>
      seen.push(
        text.expressions?.length
          ? "\u0000"
          : source.slice(text.quasis[0]?.start, text.quasis[0]?.end),
      );
    try {
      parser
        .createParser({
          onTagShorthandClass: part,
          onTagShorthandId: part,
          onError: () => {
            failed = true;
          },
        })
        .parse(source);
    } catch {
      failed = true;
    }
    answer = !failed && seen.length === 1 && seen[0] === word;
  } else {
    answer = !/[\s=(/|<,>.#]|:=|\$\{/.test(word);
  }
  // The answer is one cheap parse, so a full cache is simply emptied.
  if (shorthandProbe.size >= SHORTHAND_CACHE_LIMIT) shorthandProbe.clear();
  shorthandProbe.set(key, answer);
  return answer;
}

/**
 * Names Marko's split turns into something that is not the sugar the author
 * wrote: `:b:c` (name `:b`, modifier `c`) is two names, and `:b(x)` carries
 * arguments. Say so in the sugar's words (the generic message would name
 * `:b` or `value:b`, which the author never wrote).
 */
function checkNearSugar(ctx: Ctx, attr: Node): void {
  if (attr?.type !== "MarkoAttribute" || attr.bound) return;
  const start = startOf(ctx, attr);
  if (
    typeof attr.name === "string" &&
    attr.name.startsWith(":") &&
    typeof attr.modifier === "string"
  ) {
    failAt(ctx, SECOND_NAME, start + attr.name.length);
  }
  // A bare `:` (no name): Marko would read it as `value:` (divergences.md,
  // row 2); here it is sugar with nothing to name, like a bare `#` or `.`.
  if (attr.default === true && attr.name === "value" && attr.modifier === "") {
    failAt(
      ctx,
      "`:` is name sugar and needs a name (`:email`); write `value:` for Marko's attribute of that name",
      start,
    );
  }
  if (
    attr.arguments &&
    typeof attr.name === "string" &&
    /^[#.][^#.]/.test(attr.name)
  ) {
    failAt(
      ctx,
      `arguments are not allowed on \`${attr.name}\`: it is name sugar; a \`(params) { body }\` after it sets the default value`,
      start,
    );
  }
  if (
    attr.default === true &&
    attr.name === "value" &&
    typeof attr.modifier === "string" &&
    attr.modifier !== "" &&
    attr.arguments
  ) {
    failAt(
      ctx,
      `arguments are not allowed on \`:name\`: \`:${attr.modifier}(…)\` is name sugar, not an attribute method`,
      start,
    );
  }
}

function rewriteAttributes(ctx: Ctx, node: Node): void {
  const attrs: Node[] = node.attributes;
  // Where the shorthand ends: before the first authored attribute.
  const regionEnd = attrs
    .filter((attr) => attr.loc)
    .map((attr) => startOf(ctx, attr))
    .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
  const classTokens: { value: string; start: number; end: number }[] = [];
  let classAt = -1;
  let sawId = false;
  const out: Node[] = [];
  // The offsets of the tag's default values so far (an authored default value,
  // or a sugar's `=value` / `(params) { body }`): a second one is an error.
  const defaults: number[] = [];
  const sawSugarValue = attrs.some((attr) => {
    const kind = sugarKind(attr);
    // Attribute-position `#x` is the host's own on a host that claims it
    // (Angular's `#ref=x`): not a sugar, so it brings no default value.
    if (!kind || (kind === "#" && ctx.declarations.claimsAttributeHash)) {
      return false;
    }
    return !(attr.value?.type === "BooleanLiteral" && !attr.value?.loc);
  });

  for (const attr of attrs) {
    const kind = sugarKind(attr);
    if (!kind) {
      checkNearSugar(ctx, attr);
      // An authored default value counts only when a sugar also brings one:
      // two authored `value=` stay decision 135's duplicate warning.
      if (
        sawSugarValue &&
        attr?.type === "MarkoAttribute" &&
        attr.name === "value" &&
        // An authored `value=`, or a bound `value:=` (modifier "" in Marko).
        (attr.modifier == null || (attr.bound && attr.modifier === ""))
      ) {
        const at = startOf(ctx, attr);
        if (defaults.length > 0) {
          failAt(
            ctx,
            ALREADY_HAS_DEFAULT(
              `\`${ctx.source.slice(at, endOf(ctx, attr))}\``,
              lineColumn(ctx, defaults[0] as number),
            ),
            at,
          );
        }
        defaults.push(at);
      }
      out.push(attr);
      continue;
    }
    // Attribute-position `#x` is the host's own on a host that declares it
    // (Angular's template reference); tag-adjacent `<div#x>` is never skipped.
    if (kind === "#" && ctx.declarations.claimsAttributeHash) {
      out.push(attr);
      continue;
    }
    const start = startOf(ctx, attr);
    const end = endOf(ctx, attr);
    const authored = ctx.source.slice(start, end);
    const form = `\`${authored}\``;
    // Decision 146 addendum 4: `(` and `=` cannot be part of a sugar, so a
    // sugar followed directly by `=value` or `(params) { body }` sets the
    // tag's default attribute (`value`). Marko already parsed it as the value
    // of the sugar attribute; it moves to a default attribute of its own.
    const hasValue = !(
      attr.value?.type === "BooleanLiteral" && !attr.value?.loc
    );
    let defaultAttr: Node | undefined;
    if (hasValue) {
      const tokenEnd = start + authoredTokenLength(attr, kind);
      let at = tokenEnd;
      while (/\s/.test(ctx.source[at] ?? "")) at++;
      const valueSeparator = ctx.source[at] === "=" ? "=" : "(";
      if (ctx.source[at] === "=") {
        at++;
        while (/\s/.test(ctx.source[at] ?? "")) at++;
      }
      if (defaults.length > 0) {
        failAt(
          ctx,
          ALREADY_HAS_DEFAULT(form, lineColumn(ctx, defaults[0] as number)),
          at,
        );
      }
      defaults.push(at);
      defaultAttr = {
        type: "MarkoAttribute",
        name: "value",
        value: attr.value,
        modifier: null,
        default: true,
        bound: false,
        arguments: undefined,
        // A contract that rejects this `value` says which sugar set it.
        sugarValueOf:
          `${ctx.source.slice(start, tokenEnd)}${valueSeparator}…`.replace(
            /\(…$/,
            "(…)",
          ),
        start: at,
        end,
        loc: loc(ctx, at, end),
      };
    }
    if (kind === ":") {
      // `:x` has its word in the modifier and follows the identifier rule.
      const word: string = attr.modifier;
      if (!SUGAR_TOKEN.test(word)) {
        failAt(
          ctx,
          `${form} is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
          start,
        );
      }
      // The token is `:x`; the attribute's end also covers a value after it.
      const tokenEnd = start + authoredTokenLength(attr, kind);
      out.push(
        sugarAttr(ctx, "name", { start, end: tokenEnd }, start + 1, word),
      );
      if (defaultAttr) out.push(defaultAttr);
      continue;
    }
    // `#x` and `.x` keep the sigil in the parser's attribute name, and a
    // chain (`.c#m.d`) is split as the tag-adjacent shorthand splits it. Each
    // part is exactly what Marko's shorthand accepts (probed against its own
    // parser); a trailing `:y` (`.c:y`, `#d:y`) is a name too.
    let cursor = start;
    for (const part of splitShorthandChain(attr.name)) {
      const sigil = part.sigil;
      const word = part.word;
      const partStart = start + part.index;
      cursor = partStart + 1 + word.length;
      if (word.includes(":")) {
        failAt(ctx, SECOND_NAME, partStart + 1 + word.indexOf(":"));
      }
      if (word.includes("${")) {
        failAt(
          ctx,
          `a dynamic shorthand works only tag-adjacent (\`<${node.name?.value || "div"}${sigil}${word}>\`), not as \`${sigil}${word}\` after the tag name`,
          partStart,
        );
      }
      if (word === "" || !isShorthandWord(sigil, word)) {
        failAt(
          ctx,
          word === ""
            ? `\`${sigil}\` needs a name after it (\`${sigil}main\`)`
            : `\`${sigil}${word}\` is not a valid shorthand name`,
          partStart,
        );
      }
      if (sigil === "#") {
        out.push(
          sugarAttr(
            ctx,
            "id",
            { start: partStart, end: partStart + 1 + word.length },
            partStart + 1,
            word,
          ),
        );
        sawId = true;
      } else {
        if (classAt < 0) classAt = out.length;
        classTokens.push({
          value: word,
          start: partStart + 1,
          end: partStart + 1 + word.length,
        });
      }
    }
    if (typeof attr.modifier === "string") {
      const colon = cursor;
      checkToken(ctx, attr.modifier, colon, form);
      out.push(
        sugarAttr(
          ctx,
          "name",
          { start: colon, end: colon + 1 + attr.modifier.length },
          colon + 1,
          attr.modifier,
        ),
      );
    }
    if (defaultAttr) out.push(defaultAttr);
  }

  node.attributes = out;
  if (classTokens.length > 0) {
    mergeClassTokens(ctx, node.attributes, classTokens, classAt, regionEnd);
  }
  // `<div.a #m .b>` must come out as `<div.a.b#m>` does: the parser pushes
  // the shorthand class before the shorthand id.
  const classIndex = node.attributes.findIndex(
    (attr: Node) =>
      attr.type === "MarkoAttribute" && attr.name === "class" && !attr.loc,
  );
  const firstSugarId = node.attributes.findIndex(
    (attr: Node) =>
      attr.type === "MarkoAttribute" &&
      attr.name === "id" &&
      attr.sugarNameSpan,
  );
  if (classIndex >= 0 && firstSugarId >= 0 && classIndex > firstSugarId) {
    const [attr] = node.attributes.splice(classIndex, 1);
    node.attributes.splice(firstSugarId, 0, attr);
  }
  if (sawId) {
    // `<a#d #e>`: the later one is the one the author wrote last. Marko
    // pushed the shorthand id at the end; put it first.
    const shorthand = node.attributes.findIndex(
      (attr: Node) =>
        attr.type === "MarkoAttribute" &&
        attr.name === "id" &&
        !attr.loc &&
        !attr.sugarNameSpan,
    );
    if (shorthand >= 0) {
      const [attr] = node.attributes.splice(shorthand, 1);
      const value = attr.value;
      if (value && Number.isFinite(startOf(ctx, value))) {
        attr.start = startOf(ctx, value) - 1;
        attr.end = endOf(ctx, value);
        attr.loc = loc(ctx, attr.start, attr.end);
        attr.sugarNameSpan = { start: attr.start, end: attr.end };
      }
      node.attributes.unshift(attr);
    }
  }
}

/** The tag head: the tag name and the shorthand `class`/`id` right after it. */
function rewriteHead(ctx: Ctx, node: Node): void {
  const attrs: Node[] = node.attributes;
  const found: HeadName[] = [];
  const nameNode = node.name;
  let nameStart = -1;
  let nameColon = -1;
  if (
    nameNode?.type === "StringLiteral" &&
    typeof nameNode.value === "string" &&
    nameNode.loc &&
    // An attribute tag's name is a key (`<@svg:rect>`), not an element.
    !nameNode.value.startsWith("@") &&
    nameNode.value.includes(":")
  ) {
    nameStart = startOf(ctx, nameNode);
    const text: string = nameNode.value;
    nameColon = nameStart + text.indexOf(":");
    const after = text.slice(text.indexOf(":") + 1);
    const colons = [...text].flatMap((char, index) =>
      char === ":" ? [index] : [],
    );
    checkToken(ctx, after.split(":")[0] ?? "", nameColon, "a tag name");
    found.push({
      name: after.split(":")[0] ?? "",
      start: nameColon,
      end: nameColon + 1 + (after.split(":")[0] ?? "").length,
      strip() {},
    });
    // `<a:b:c>`: the tag name itself holds two.
    if (colons.length > 1) {
      const at = nameStart + (colons[1] as number);
      found.push({ name: "", start: at, end: at + 1, strip() {} });
    }
  }

  // Shorthand parts live before the first authored attribute.
  const firstAuthored = attrs
    .filter((attr) => attr.loc)
    .map((attr) => startOf(ctx, attr))
    .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
  const parts: Node[] = [];
  const classAttr = attrs.find(
    (attr) => attr.type === "MarkoAttribute" && attr.name === "class",
  );
  if (classAttr)
    parts.push(...shorthandClassParts(ctx, classAttr, firstAuthored));
  const idAttr = attrs.find(
    (attr) =>
      attr.type === "MarkoAttribute" &&
      attr.name === "id" &&
      !attr.loc &&
      !attr.sugarNameSpan,
  );
  if (idAttr?.value) parts.push(idAttr.value);
  for (const part of parts) headNamesIn(ctx, part, found);

  if (found.length === 0) return;
  found.sort((a, b) => a.start - b.start);
  const [first, second] = found as [HeadName, HeadName | undefined];
  if (second) failAt(ctx, SECOND_NAME, second.start);

  first.strip();
  if (nameColon >= 0) {
    // The tag name keeps what is before the colon. An empty one is an
    // unnamed tag (empty source span), which the default-tag resolver reads.
    const before = (nameNode.value as string).slice(
      0,
      (nameNode.value as string).indexOf(":"),
    );
    nameNode.value = before;
    if (nameNode.extra) {
      nameNode.extra.raw = JSON.stringify(before);
      nameNode.extra.rawValue = before;
    }
    const end = nameStart + before.length;
    nameNode.end = end;
    nameNode.loc = loc(ctx, nameStart, end);
  }

  // A shorthand left empty by the split (`<a.:b>`) is no class at all.
  for (const attr of [classAttr, idAttr]) {
    if (
      attr &&
      !attr.loc &&
      attr.value?.type === "StringLiteral" &&
      attr.value.value.trim() === ""
    ) {
      attrs.splice(attrs.indexOf(attr), 1);
    }
  }

  // The name goes first, where the tag-adjacent sugar was written.
  node.attributes.unshift(
    sugarAttr(
      ctx,
      "name",
      { start: first.start, end: first.end },
      first.start + 1,
      first.name,
    ),
  );
}

/** Rewrites one tag's name sugar, once. */
/**
 * The tags whose text is code, not attributes (`static`, `import`, ...), read
 * from the core taglib's own `statement` parse options: the one place Marko's
 * statement tags are listed. Used only when the compile has no lookup to ask.
 */
const CORE_STATEMENT_TAGS: ReadonlySet<string> = new Set(
  Object.entries(
    CORE_TAGLIB as Record<string, { parseOptions?: { statement?: boolean } }>,
  )
    .filter(([key, tag]) => key.startsWith("<") && tag?.parseOptions?.statement)
    .map(([key]) => key.slice(1, -1)),
);

/**
 * Is `name` a statement tag in THIS parse? A parse without the core taglib
 * (`parseFragment`, the TS plugin's mapping pass) reads `static function f(a:
 * number): string {}` as a tag with attributes, where a bare `:` is a
 * TypeScript return type. The lookup decides when there is one
 * (`getTag(name).parseOptions.statement`: a data taglib that makes `class` an
 * ordinary tag keeps the sugar, and a custom tag with `parseOptions.statement`
 * is left alone); otherwise the core taglib's statement entries do.
 */
function isStatementTag(ctx: Ctx, name: string): boolean {
  if (ctx.lookup) return !!ctx.lookup.getTag(name)?.parseOptions?.statement;
  return CORE_STATEMENT_TAGS.has(name);
}

export function rewriteNameSugar(ctx: Ctx, node: Node): void {
  if (done.has(node) || node?.type !== "MarkoTag") return;
  done.add(node);
  if (
    node.name?.type === "StringLiteral" &&
    isStatementTag(ctx, node.name.value)
  ) {
    return;
  }
  if (!Array.isArray(node.attributes)) return;
  rewriteHead(ctx, node);
  rewriteAttributes(ctx, node);
}
