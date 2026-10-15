/**
 * Marko's `#id` / `.class` shorthand, at the IR core hands a host.
 *
 * The MX front end reads the tag-adjacent shorthand (`<div#a.b>`, concise
 * `div#a.b`) into `MxTag.shorthands`, and a syntax-table trigger can place an
 * `MxShorthand` in the attribute list (`ctx.shorthand`, position
 * `attribute`). Neither is an attribute yet: the shorthand's rules are
 * cross-attribute (the class parts merge into an authored `class`, the one
 * id, id ordering), and lowering reads attributes in Marko's shape. So this
 * pass builds, once per tag, the attribute list Marko's parser would have
 * produced for the same source (`onOpenTagEnd`: the head's class merged into
 * an authored `class`, the id pushed last), turns each trigger-placed run into
 * the `id` / `class` it sets, and records the result. The MX tree is never
 * mutated: `tagAttributesOf` (`tag-fields.ts`) reads the record, in which
 * every authored attribute the pass left alone is the MX node itself, and
 * every record the pass built or changed is Marko-shaped, as lowering's Marko
 * branch reads it.
 *
 * An authored attribute whose name starts with `#` or `.` (`<div #a>`) is not
 * a shorthand: it stays an attribute with that name, which lowering reports as
 * Marko's `Invalid attribute name.`.
 */

import { attrArgsOf, attrValueOf } from "./attr-fields.ts";
import { type Ctx, codedError, type Node } from "./core.ts";
import {
  INVALID_SHORTHAND_CODE,
  type MxDiagnosticCode,
} from "./diagnostic-codes.ts";
import { payloadOf } from "./payload.ts";
import { markoParser } from "./stock-parser.ts";
import { recordShorthandAttributes } from "./tag-fields.ts";
import { attributesWithTriggers } from "./triggers.ts";

const done = new WeakSet<Node>();

/** The attribute records built from a trigger-placed shorthand run. */
const fromShorthand = new WeakSet<Node>();

interface Located {
  start: number;
  end: number;
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

/** A Babel `loc` (line, column and index) for a source range. */
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

/**
 * Offsets of the nodes this pass builds. Marko's parser leaves a shorthand
 * part with a line/column `loc` only (no `start`/`end`, no `index`), and the
 * IR carries the node, so the offsets live here.
 */
const ranges = new WeakMap<Node, Located>();

/** A node's source range; a template literal has none of its own, its quasis do. */
function rangeOf(ctx: Ctx, node: Node): Located {
  const built = ranges.get(node);
  if (built) return built;
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

function failAt(
  code: MxDiagnosticCode,
  ctx: Ctx,
  message: string,
  offset: number,
): never {
  const at = positionAt(ctx, offset);
  throw codedError(code, message, at.line, at.column);
}

/**
 * The first bracket in a shorthand part that does not pair up (`[` with no
 * later `]`, or a `]` with no `[` before it).
 */
function bracketOffense(word: string): string | undefined {
  let depth = 0;
  for (const char of word) {
    if (char === "[") depth++;
    else if (char === "]") {
      if (depth === 0) return "]";
      depth--;
    }
  }
  return depth > 0 ? "[" : undefined;
}

/**
 * A shorthand part cannot hold an unbalanced `[` or `]` (`.bg-[#fff]` would
 * read as the class `bg-[` and the id `fff]`), and a class part cannot hold a
 * purely numeric word (`.w-1.5` would read as the classes `w-1` and `5`). One
 * positioned error per part, with the `class="…"` hint; `.hover:bg-red`,
 * `.a.b#c` and `.w-1` stay valid.
 */
function checkShorthandWord(
  ctx: Ctx,
  sigil: string,
  word: string,
  at: number,
): void {
  const kind = sigil === "#" ? "id" : "class";
  const offense = bracketOffense(word);
  if (offense !== undefined) {
    failAt(
      INVALID_SHORTHAND_CODE,
      ctx,
      `\`${sigil}${word}\` is not a valid shorthand ${kind}: a ${kind} part cannot hold an unbalanced \`${offense}\` (a part ends at \`.\`, \`#\`, \`/\`, \`(\`, whitespace, \`=\` or \`>\`); use \`class="…"\` for this ${kind}`,
      at,
    );
  }
  if (sigil === "." && /^[0-9]+$/.test(word)) {
    failAt(
      INVALID_SHORTHAND_CODE,
      ctx,
      `\`.${word}\` is not a valid shorthand class: a split-off class part cannot be purely numeric; use \`class="…"\` for this class`,
      at,
    );
  }
}

/**
 * The same two checks over a tag-adjacent shorthand part (`<div.bg-[#fff]/>`):
 * the class parts are merged into one value whose words are joined with a
 * space exactly where the source had `.`. Find each word in the source, from
 * the previous word's end on.
 */
function checkShorthandPart(ctx: Ctx, part: Node, sigil: string): void {
  if (part?.type !== "StringLiteral" || typeof part.value !== "string") return;
  let cursor = startOf(ctx, part);
  if (!Number.isFinite(cursor)) return;
  for (const word of String(part.value).split(" ")) {
    const at = ctx.source.indexOf(word, cursor);
    if (at < 0) return;
    checkShorthandWord(ctx, sigil, word, at);
    cursor = at + word.length;
  }
}

function stringLiteral(ctx: Ctx, value: string, start: number, end: number) {
  const node = {
    type: "StringLiteral",
    value,
    extra: { raw: JSON.stringify(value), rawValue: value },
    start,
    end,
    loc: loc(ctx, start, end),
  };
  ranges.set(node, { start, end });
  return node;
}

/**
 * The `id` a trigger-placed `#x` sets. `sugarNameSpan` is the whole token,
 * which `lowerAttr` reads for the attribute's `nameSpan`, and `sugarLabel`
 * the token diagnostics name; the value is the word after the sigil.
 */
function shorthandIdAttr(ctx: Ctx, token: Located, word: string) {
  return {
    type: "MarkoAttribute",
    name: "id",
    value: stringLiteral(ctx, word, token.start + 1, token.end),
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

/** The tag-adjacent class parts of a `class` attribute, wherever they were merged. */
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

/** Merges trigger-placed `.x` words into the tag's `class`, as `<a.c.x>` would. */
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
  const shorthand = stringLiteral(ctx, text, first.start, last.end);
  const existing = attrs.find(
    (attr) => attr.type === "MarkoAttribute" && attr.name === "class",
  );
  if (!existing) {
    attrs.splice(at, 0, {
      type: "MarkoAttribute",
      name: "class",
      value: shorthand,
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
  // A diagnostic on the merged `class` names the shorthand the trigger
  // placed and sits on its first token (a shorthand-only attribute has no
  // source position of its own, so it would otherwise point at the tag).
  const mark = (words: string[]) => {
    existing.sugarLabel = [...words, ...tokens.map((token) => token.value)]
      .map((word) => `.${word}`)
      .join(" ");
    existing.sugarNameSpan = { start: first.start - 1, end: last.end };
    existing.sugarAt = positionAt(ctx, first.start - 1);
  };
  // The tag-adjacent part of the class, wherever it was merged: the words
  // are appended THERE, so `<div.c class="x">` plus a placed `.d` is
  // `<div.c.d class="x">`. The tokens are not contiguous, so no single span
  // is honest: the value keeps its first token's span.
  if (!existing.loc) {
    const shorthandWords =
      value?.type === "StringLiteral" ? String(value.value).split(" ") : [];
    if (value?.type === "StringLiteral") {
      append(value);
    } else if (value?.type === "ArrayExpression") {
      value.elements.push(shorthand);
    } else {
      existing.value = {
        type: "ArrayExpression",
        elements: [value, shorthand],
      };
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
        value.elements.splice(index + 1, 0, shorthand);
      }
    } else {
      // `${shorthand} ${class}`: the shorthand string grows.
      append(parts[0]);
    }
    mark(shorthandWords);
    return;
  }
  mark([]);
  // No tag-adjacent class and an authored literal: the value stays a literal
  // (so the contract checks judge what it is) and keeps its span; the words
  // go where they were placed, before or after the authored `class`.
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
  const shorthandFirst = first.start < startOf(ctx, existing);
  existing.value = {
    type: "ArrayExpression",
    elements:
      value?.type === "ArrayExpression"
        ? shorthandFirst
          ? [shorthand, ...value.elements]
          : [...value.elements, shorthand]
        : shorthandFirst
          ? [shorthand, value]
          : [value, shorthand],
  };
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

/** Marko's `templateElement` (`@marko/compiler` 5.42.10). */
function templateElement(value: string, tail: boolean): Node {
  return {
    type: "TemplateElement",
    value: { tail, raw: value, cooked: value },
    tail: false,
  };
}

/** Marko's `loc` for a parser-built node: line and column only. */
function markoLoc(ctx: Ctx, start: number, end: number) {
  const { start: from, end: to } = loc(ctx, start, end);
  return {
    start: { line: from.line, column: from.column },
    end: { line: to.line, column: to.column },
  };
}

function located(ctx: Ctx, node: Node, range: Located): Node {
  node.loc = markoLoc(ctx, range.start, range.end);
  ranges.set(node, range);
  return node;
}

function partLiteral(ctx: Ctx, value: string, range: Located): Node {
  return located(ctx, { type: "StringLiteral", value }, range);
}

/** A deep copy that keeps Babel's classes (`SourceLocation`, `Position`). */
function clone<T>(node: T): T {
  if (Array.isArray(node)) return node.map(clone) as T;
  if (!node || typeof node !== "object") return node;
  const copy = Object.create(Object.getPrototypeOf(node));
  for (const [key, value] of Object.entries(node)) copy[key] = clone(value);
  return copy;
}

/**
 * One shorthand part's value as Marko's `parseTemplateString` builds it: a
 * static word is a `StringLiteral` over the word, `${expr}` alone is the
 * expression (a string literal one becomes a one-quasi template), anything
 * else the template literal over the part.
 */
function partValue(ctx: Ctx, value: Node): Node {
  if (value.kind === "static") return partLiteral(ctx, value.value, value.span);
  const template = value.template;
  const node = clone(payloadOf(template));
  const bare =
    value.expressions?.length === 1 &&
    value.quasis.every((quasi: Located) => quasi.start === quasi.end);
  if (bare && node?.type === "StringLiteral") {
    return located(
      ctx,
      {
        type: "TemplateLiteral",
        quasis: [templateElement(node.value, true)],
        expressions: [],
      },
      template,
    );
  }
  // A payload's offsets: the front end's container, whatever the node holds.
  const range = { start: template.start, end: template.end };
  // A template literal over a word with a placeholder (`a${y}`) is built
  // here and has no position of its own: it takes the authored word, so the
  // IR value carries a span over the source it was made from. A node the
  // payload already positioned (`${y}` alone is the expression `y`) keeps its
  // own range. `${"lit"}` alone comes from the parser as a one-quasi template
  // whose `loc` has a start and no end (Marko's own `withLoc` shape): half a
  // position is no position, so it takes the authored expression's range too.
  if (!node.loc?.end) return located(ctx, node, range);
  ranges.set(node, range);
  return node;
}

/**
 * The tag head's class parts and id part, as Marko's parser read them, and
 * the range the class parts were written over: the word after the first class
 * sigil through the end of the last class word (an id between them is inside
 * it, as in the class attribute's name span).
 */
function headParts(ctx: Ctx, tag: Node) {
  let classParts: Node[] = [];
  let classRange: Located | undefined;
  let idPart: Node | undefined;
  for (const shorthand of tag.shorthands ?? []) {
    const part = partValue(ctx, shorthand.value);
    if (shorthand.sigil === "#") {
      idPart = part;
      continue;
    }
    classParts = [...classParts, part];
    const word = shorthand.value.span;
    if (typeof word?.start === "number" && typeof word?.end === "number") {
      classRange = { start: classRange?.start ?? word.start, end: word.end };
    }
  }
  return { classParts, classRange, idPart };
}

/** Marko's attribute for an authored MX attribute, value cloned. */
function markoAttribute(ctx: Ctx, attr: Node): Node {
  if (attr.type === "MxSpreadAttribute") {
    return {
      type: "MarkoSpreadAttribute",
      value: clone(payloadOf(attr.value)),
      start: attr.start,
      end: attr.end,
      loc: loc(ctx, attr.start, attr.end),
    };
  }
  const isDefault = attr.name === null;
  const bound = attr.operator === ":=";
  return {
    type: "MarkoAttribute",
    name: attr.name ?? "value",
    value: clone(attrValueOf(ctx, attr)),
    // Marko's `:=x` is the default attribute with an empty modifier.
    modifier: attr.modifier ?? (isDefault && bound ? "" : null),
    default: isDefault,
    bound,
    arguments: attrArgsOf(attr),
    start: attr.start,
    end: attr.end,
    loc: loc(ctx, attr.start, attr.end),
    // A dialect's authored attribute (`ctx.attribute(…, { authored })`)
    // keeps the token its trigger spelled.
    ...(attr.sugarLabel
      ? { sugarLabel: attr.sugarLabel, sugarNameSpan: attr.sugarNameSpan }
      : {}),
  };
}

/**
 * Marko's `onOpenTagEnd`: the head's class merges into an authored `class`
 * (string with string: `${shorthand} ${class}`; otherwise an array, head
 * first).
 */
function mergeHeadClass(
  ctx: Ctx,
  attributes: Node[],
  parts: Node[],
  range: Located | undefined,
): void {
  if (parts.length === 0) return;
  const first = parts[0] as Node;
  const last = parts[parts.length - 1] as Node;
  const shorthand =
    parts.length === 1
      ? first
      : parts.every((part) => part.type === "StringLiteral")
        ? partLiteral(ctx, parts.map((part) => part.value).join(" "), {
            start: rangeOf(ctx, first).start,
            end: rangeOf(ctx, last).end,
          })
        : // The array is the class value of a shorthand alone. Beside an
          // authored `class` its elements are spread into a value no single
          // source range covers, which stays without a span.
          range
          ? located(ctx, { type: "ArrayExpression", elements: parts }, range)
          : { type: "ArrayExpression", elements: parts };
  const authored = attributes.find((attr) => attr.name === "class");
  if (!authored) {
    attributes.push({
      type: "MarkoAttribute",
      name: "class",
      value: shorthand,
    });
    return;
  }
  const value = authored.value;
  if (value?.type === "StringLiteral" && shorthand.type === "StringLiteral") {
    authored.value = {
      type: "TemplateLiteral",
      quasis: [
        templateElement("", false),
        templateElement(" ", false),
        templateElement("", true),
      ],
      expressions: [shorthand, value],
    };
    return;
  }
  const head =
    shorthand.type === "ArrayExpression" ? shorthand.elements : [shorthand];
  const tail = value?.type === "ArrayExpression" ? value.elements : [value];
  authored.value = { type: "ArrayExpression", elements: [...head, ...tail] };
}

/** The tag-adjacent class and id parts: the bracket and numeric checks. */
function checkHead(ctx: Ctx, attrs: Node[]): void {
  // Tag-adjacent parts live before the first authored attribute.
  const firstAuthored = attrs
    .filter((attr) => attr.loc)
    .map((attr) => startOf(ctx, attr))
    .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
  const classAttr = attrs.find(
    (attr) => attr.type === "MarkoAttribute" && attr.name === "class",
  );
  if (classAttr) {
    for (const part of shorthandClassParts(ctx, classAttr, firstAuthored)) {
      checkShorthandPart(ctx, part, ".");
    }
  }
  const idAttr = attrs.find(
    (attr) =>
      attr.type === "MarkoAttribute" &&
      attr.name === "id" &&
      !attr.loc &&
      !attr.sugarNameSpan,
  );
  if (idAttr?.value) checkShorthandPart(ctx, idAttr.value, "#");
}

/**
 * Each trigger-placed run becomes the `id` / `class` it sets: `#x` an `id`
 * of its own, the `.x` words merged into the tag's `class`. The rest of the
 * list stays as it is.
 */
function placeTriggerShorthands(
  ctx: Ctx,
  attrs: Node[],
  runs: Map<Node, Node[]>,
): Node[] {
  const regionEnd = attrs
    .filter((attr) => attr.loc && !fromShorthand.has(attr))
    .map((attr) => startOf(ctx, attr))
    .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
  const classTokens: { value: string; start: number; end: number }[] = [];
  let classAt = -1;
  let sawId = false;
  const out: Node[] = [];
  for (const attr of attrs) {
    const run = runs.get(attr);
    if (!run) {
      out.push(attr);
      continue;
    }
    for (const token of run) {
      const sigil: string = token.sigil;
      const word: string = token.value.value;
      checkShorthandWord(ctx, sigil, word, token.start);
      if (word === "" || !isShorthandWord(sigil, word)) {
        failAt(
          INVALID_SHORTHAND_CODE,
          ctx,
          word === ""
            ? `\`${sigil}\` needs a name after it (\`${sigil}main\`)`
            : `\`${sigil}${word}\` is not a valid shorthand name`,
          token.start,
        );
      }
      if (sigil === "#") {
        out.push(
          shorthandIdAttr(
            ctx,
            { start: token.start, end: token.start + 1 + word.length },
            word,
          ),
        );
        sawId = true;
      } else {
        if (classAt < 0) classAt = out.length;
        classTokens.push({
          value: word,
          start: token.start + 1,
          end: token.start + 1 + word.length,
        });
      }
    }
  }
  if (classTokens.length > 0) {
    mergeClassTokens(ctx, out, classTokens, classAt, regionEnd);
  }
  // A placed `#m` before a placed `.b` must come out as `<div.b#m>` does:
  // the parser pushes the shorthand class before the shorthand id.
  const classIndex = out.findIndex(
    (attr: Node) =>
      attr.type === "MarkoAttribute" && attr.name === "class" && !attr.loc,
  );
  const firstPlacedId = out.findIndex(
    (attr: Node) =>
      attr.type === "MarkoAttribute" &&
      attr.name === "id" &&
      attr.sugarNameSpan,
  );
  if (classIndex >= 0 && firstPlacedId >= 0 && classIndex > firstPlacedId) {
    const [attr] = out.splice(classIndex, 1);
    out.splice(firstPlacedId, 0, attr);
  }
  if (sawId) {
    // `<a#d>` plus a placed `#e`: the placed one is the one written last.
    // Marko pushed the tag-adjacent id at the end; put it first.
    const headId = out.findIndex(
      (attr: Node) =>
        attr.type === "MarkoAttribute" &&
        attr.name === "id" &&
        !attr.loc &&
        !attr.sugarNameSpan,
    );
    if (headId >= 0) {
      const [attr] = out.splice(headId, 1);
      const value = attr.value;
      if (value && Number.isFinite(startOf(ctx, value))) {
        attr.start = startOf(ctx, value) - 1;
        attr.end = endOf(ctx, value);
        attr.loc = loc(ctx, attr.start, attr.end);
        attr.sugarNameSpan = { start: attr.start, end: attr.end };
      }
      out.unshift(attr);
    }
  }
  return out;
}

/**
 * Builds one MX tag's attribute list with its shorthand applied, once, into
 * `tagAttributesOf`'s record. A tag with no shorthand gets no record and
 * keeps its own attribute list.
 */
export function rewriteShorthands(ctx: Ctx, tag: Node): void {
  const type = tag?.type;
  if (done.has(tag)) return;
  // Marko's own tree (the IR differential lowers it) already holds the
  // shorthand as attributes: only the part checks apply.
  if (type === "MarkoTag") {
    done.add(tag);
    if (Array.isArray(tag.attributes)) checkHead(ctx, tag.attributes);
    return;
  }
  if (type !== "MxTag" && type !== "MxReturn" && type !== "MxAttributeTag") {
    return;
  }
  done.add(tag);
  const authored: Node[] = attributesWithTriggers(tag).filter(
    (attr: Node) => attr?.type !== "MxComment",
  );
  if (
    !tag.shorthands?.length &&
    !authored.some((attr) => attr.type === "MxShorthand")
  ) {
    return;
  }
  const { classParts, classRange, idPart } = headParts(ctx, tag);
  // The authored attribute and its shaped record as built, before the rewrite.
  const origin = new Map<Node, { attr: Node; shaped: string }>();
  const runs = new Map<Node, Node[]>();
  const attributes: Node[] = [];
  for (let i = 0; i < authored.length; i++) {
    const attr = authored[i] as Node;
    if (attr.type !== "MxShorthand") {
      const shaped = markoAttribute(ctx, attr);
      origin.set(shaped, { attr, shaped: JSON.stringify(shaped) });
      attributes.push(shaped);
      continue;
    }
    // A run is the placed tokens written with nothing between them (`#a.b`).
    const run = [attr];
    while (true) {
      const prev = run[run.length - 1] as Node;
      const next = authored[i + 1];
      if (next?.type !== "MxShorthand" || next.start !== prev.end) break;
      run.push(next);
      i++;
    }
    const last = run[run.length - 1] as Node;
    const record = {
      type: "MarkoAttribute",
      name: run.map((token) => `${token.sigil}${token.value.value}`).join(""),
      start: attr.start,
      end: last.end,
      loc: loc(ctx, attr.start, last.end),
    };
    fromShorthand.add(record);
    runs.set(record, run);
    attributes.push(record);
  }
  mergeHeadClass(ctx, attributes, classParts, classRange);
  if (idPart)
    attributes.push({ type: "MarkoAttribute", name: "id", value: idPart });
  checkHead(ctx, attributes);
  const rewritten =
    runs.size > 0 ? placeTriggerShorthands(ctx, attributes, runs) : attributes;
  recordShorthandAttributes(
    tag,
    rewritten.map((record: Node) => {
      // Untouched means the whole record is as built: a pass that set any
      // field on it (a `sugarLabel`, a changed value) keeps the record.
      const from = origin.get(record);
      return from && JSON.stringify(record) === from.shaped
        ? from.attr
        : record;
    }),
  );
}
