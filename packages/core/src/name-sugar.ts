import { type Ctx, type Node, TranslateError } from "./core.ts";

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
 * Skipped when the host has an attribute syntax of its own
 * (`acceptsForeignAttrNames`): there `svg:rect` and `#ref` are not ours.
 */

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
      start: first.start - 1,
      end: last.end,
      loc: loc(ctx, first.start - 1, last.end),
    });
    return;
  }
  const value = existing.value;
  if (!existing.loc && value?.type === "StringLiteral") {
    // The shorthand-only class: one string, as `<a.c.x>` would have made it.
    value.value = `${value.value} ${text}`;
    value.end = sugar.end;
    value.loc = loc(ctx, startOf(ctx, value), sugar.end);
    if (value.extra) {
      value.extra.raw = JSON.stringify(value.value);
      value.extra.rawValue = value.value;
    }
    return;
  }
  // An authored class beside the sugar: Marko's own merge of a shorthand
  // class with a `class=` attribute.
  if (value?.type === "StringLiteral") {
    existing.value = {
      type: "TemplateLiteral",
      quasis: [
        {
          type: "TemplateElement",
          value: { raw: "", cooked: "" },
          tail: false,
        },
        {
          type: "TemplateElement",
          value: { raw: " ", cooked: " " },
          tail: false,
        },
        { type: "TemplateElement", value: { raw: "", cooked: "" }, tail: true },
      ],
      expressions: [sugar, value],
    };
    return;
  }
  existing.value = {
    type: "ArrayExpression",
    elements:
      value?.type === "ArrayExpression"
        ? [sugar, ...value.elements]
        : [sugar, value],
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

function rewriteAttributes(ctx: Ctx, node: Node): void {
  const attrs: Node[] = node.attributes;
  const classTokens: { value: string; start: number; end: number }[] = [];
  let classAt = -1;
  let sawId = false;
  const out: Node[] = [];

  for (const attr of attrs) {
    const kind = sugarKind(attr);
    if (!kind) {
      out.push(attr);
      continue;
    }
    const start = startOf(ctx, attr);
    const end = endOf(ctx, attr);
    const authored = ctx.source.slice(start, end);
    const form = `\`${authored}\``;
    // The sugar takes no value: `:x=1`, `#x=1`, `.x=1`.
    if (attr.value?.loc || attr.value?.type !== "BooleanLiteral") {
      failAt(
        ctx,
        `${form} is name sugar and takes no value; write \`${kind === ":" ? "name" : kind === "#" ? "id" : "class"}="…"\` to give one`,
        start,
      );
    }
    // `#x` and `.x` keep their sigil in the parser's attribute name; `:x` has
    // it in the modifier. A trailing `:y` (`.c:y`, `#d:y`) is a name too.
    const word: string = kind === ":" ? attr.modifier : attr.name.slice(1);
    const tail: string | undefined =
      kind !== ":" && typeof attr.modifier === "string"
        ? attr.modifier
        : undefined;
    if (!SUGAR_TOKEN.test(word)) {
      failAt(
        ctx,
        `${form} is not name sugar; \`${kind}name\` takes an identifier (\`${kind}main\`, \`${kind}first-name\`)`,
        start,
      );
    }
    const wordStart = start + 1;
    const wordEnd = wordStart + word.length;
    if (kind === ":") {
      out.push(sugarAttr(ctx, "name", { start, end }, wordStart, word));
    } else if (kind === "#") {
      out.push(sugarAttr(ctx, "id", { start, end: wordEnd }, wordStart, word));
      sawId = true;
    } else {
      if (classAt < 0) classAt = out.length;
      classTokens.push({ value: word, start: wordStart, end: wordEnd });
    }
    if (tail !== undefined) {
      const colon = wordEnd;
      checkToken(ctx, tail, colon, form);
      out.push(
        sugarAttr(
          ctx,
          "name",
          { start: colon, end: colon + 1 + tail.length },
          colon + 1,
          tail,
        ),
      );
    }
  }

  node.attributes = out;
  if (classTokens.length > 0) {
    mergeClassTokens(ctx, node.attributes, classTokens, classAt);
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
export function rewriteNameSugar(ctx: Ctx, node: Node): void {
  if (done.has(node) || node?.type !== "MarkoTag") return;
  done.add(node);
  if (ctx.declarations.acceptsForeignAttrNames) return;
  if (!Array.isArray(node.attributes)) return;
  rewriteHead(ctx, node);
  rewriteAttributes(ctx, node);
}
