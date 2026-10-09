/**
 * Name sugar on the MX AST (decision 158 addendum, PR 4 slice 4): the MX
 * counterpart of `rewriteNameSugar`, run at the same spot.
 *
 * The MX front end already splits the sugar out (`MxTag.shorthands` for the
 * tag head, `MxShorthand` in the attribute list), but the rewrite's rules are
 * cross-attribute (class merging, the one default value, id ordering) and its
 * diagnostics are positioned on what Marko parsed. So this pass builds the
 * tag Marko's parser would have produced for the same source, as a stand-in
 * (sugar re-joined the way Marko spells it, the head's class shorthand merged
 * into an authored `class` as Marko's `onOpenTagEnd` does), runs
 * `rewriteSugarTag` on it, and records the result per tag. The MX tree is
 * never mutated: `tagAttributesOf` (`tag-fields.ts`) reads the record, in
 * which every authored attribute the rewrite left alone is the MX node
 * itself, and every record the rewrite built or changed is Marko-shaped, as
 * lowering's Marko branch reads it. The IR, the atom marker and every
 * diagnostic are therefore the Marko path's by construction.
 *
 * A check the MX front end makes at token level (a second name, a bad name, a
 * bound value or arguments on a sugar, a dynamic attribute shorthand, sugar
 * on a statement tag) fails there; lowering never sees that source.
 */

import { attrArgsOf, attrValueOf, methodFunctionOf } from "./attr-fields.ts";
import type { Ctx, Node } from "./core.ts";
import { rewriteSugarTag, sugarLoc } from "./name-sugar.ts";
import { payloadOf } from "./payload.ts";
import { recordSugarAttributes } from "./tag-fields.ts";
import { attributesWithTriggers } from "./triggers.ts";

const done = new WeakSet<Node>();

interface Located {
  start: number;
  end: number;
}

/** Marko's `templateElement` (`@marko/compiler` 5.42.10). */
function templateElement(value: string, tail: boolean): Node {
  return {
    type: "TemplateElement",
    value: { tail, raw: value, cooked: value },
    tail: false,
  };
}

/**
 * Offsets of the nodes this pass builds. Marko's parser leaves a shorthand
 * part with a line/column `loc` only (no `start`/`end`, no `index`), and the
 * IR carries the node, so the offsets live here.
 */
const ranges = new WeakMap<Node, Located>();

function rangeOf(node: Node): Located {
  return ranges.get(node) ?? { start: node.start, end: node.end };
}

/** Marko's `loc` for a parser-built node: line and column only. */
function markoLoc(ctx: Ctx, start: number, end: number) {
  const { start: from, end: to } = sugarLoc(ctx, start, end);
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

function stringLiteral(ctx: Ctx, value: string, range: Located): Node {
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
  if (value.kind === "static")
    return stringLiteral(ctx, value.value, value.span);
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
  ranges.set(node, { start: template.start, end: template.end });
  return node;
}

/**
 * Appends a `:name` the source wrote right after a part (`.c:b` is Marko's
 * class `c:b`): a static part's text grows, a template's last quasi does.
 */
function appendName(ctx: Ctx, part: Node, shorthand: Node): Node {
  const text = `:${shorthand.value.value}`;
  const end = shorthand.end;
  const { start } = rangeOf(part);
  if (part.type === "StringLiteral") {
    return stringLiteral(ctx, part.value + text, { start, end });
  }
  if (part.type === "TemplateLiteral") {
    const tail = part.quasis[part.quasis.length - 1];
    tail.value.raw += text;
    tail.value.cooked += text;
    tail.loc = sugarLoc(ctx, offsetOf(tail), end);
    ranges.set(part, { start, end });
    return part;
  }
  // `${x}:b`: the bare expression becomes the template Marko parses
  // (`parseTemplateLiteral`: Babel's quasis, no `loc` on the literal).
  const quasi = (raw: string, tail: boolean, from: number, to: number) => ({
    type: "TemplateElement",
    value: { raw, cooked: raw },
    tail,
    loc: sugarLoc(ctx, from, to),
  });
  const template = {
    type: "TemplateLiteral",
    quasis: [
      quasi("", false, start - 2, start - 2),
      quasi(text, true, rangeOf(part).end + 1, end),
    ],
    expressions: [part],
  };
  ranges.set(template, { start: start - 2, end });
  return template;
}

/** Where a Babel node starts (its `loc` carries the offset). */
function offsetOf(node: Node): number {
  return node.loc.start.index;
}

/**
 * The tag head as Marko parsed it: the name with every `:name` written right
 * after it (`input:email`), then the class parts and the id part, each with
 * the `:name` that followed it (`.c:b#d` is the class `c:b` and the id `d`).
 */
function markoHead(ctx: Ctx, tag: Node) {
  const name = tag.name;
  let nameNode: Node;
  let classParts: Node[] = [];
  let idPart: Node | undefined;
  let current: { node: Node; sigil: string } | undefined;
  if (tag.type === "MxAttributeTag") {
    const start = name.span.start - 1;
    nameNode = stringLiteral(ctx, `@${name.value}`, {
      start,
      end: name.span.end,
    });
  } else if (name.kind === "dynamic") {
    nameNode = payloadOf(name.expression);
  } else {
    nameNode = stringLiteral(ctx, name.kind === "static" ? name.value : "", {
      start: name.span.start,
      end: name.span.end,
    });
  }
  for (const shorthand of tag.shorthands ?? []) {
    if (shorthand.sigil === ":") {
      if (current) {
        current.node = appendName(ctx, current.node, shorthand);
        if (current.sigil === "#") idPart = current.node;
        else classParts[classParts.length - 1] = current.node;
      } else {
        // Joins the static or unnamed name only: the front end folds a `:b`
        // after a dynamic name into its expression (`<${x}:b>`, pinned in
        // `@mxlang/parser`'s parse.test.ts), so none reaches here.
        nameNode = stringLiteral(
          ctx,
          `${nameNode.value}:${shorthand.value.value}`,
          { start: rangeOf(nameNode).start, end: shorthand.end },
        );
      }
      continue;
    }
    current = { node: partValue(ctx, shorthand.value), sigil: shorthand.sigil };
    if (shorthand.sigil === "#") idPart = current.node;
    else classParts = [...classParts, current.node];
  }
  return { nameNode, classParts, idPart };
}

/** Marko's attribute for an authored MX attribute, value cloned. */
function markoAttribute(ctx: Ctx, attr: Node): Node {
  if (attr.type === "MxSpreadAttribute") {
    return {
      type: "MarkoSpreadAttribute",
      value: clone(payloadOf(attr.value)),
      start: attr.start,
      end: attr.end,
      loc: sugarLoc(ctx, attr.start, attr.end),
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
    loc: sugarLoc(ctx, attr.start, attr.end),
    // A syntax module's authored attribute (`ctx.attribute(…, { authored })`)
    // keeps the token its trigger spelled.
    ...(attr.sugarLabel
      ? { sugarLabel: attr.sugarLabel, sugarNameSpan: attr.sugarNameSpan }
      : {}),
  };
}

/**
 * One run of attribute-position sugar written with nothing between the
 * tokens (`.c#m.d=1`, `.b:c`, `:x`), as Marko's one attribute: `#`/`.`
 * chains keep the sigils in the name and a trailing `:y` is the modifier;
 * a leading `:x` is the default attribute with the modifier `x`. The value
 * is the last token's.
 */
function markoSugarAttribute(ctx: Ctx, run: Node[]): Node {
  const first = run[0] as Node;
  const last = run[run.length - 1] as Node;
  const value = last.default;
  const end = value ? value.end : last.end;
  const words = (tokens: Node[]) =>
    tokens.map((token) => `${token.sigil}${token.value.value}`).join("");
  const named = first.sigil !== ":";
  const modifierToken = named && last.sigil === ":" ? last : undefined;
  return {
    type: "MarkoAttribute",
    name: named ? words(modifierToken ? run.slice(0, -1) : run) : "value",
    value:
      value == null
        ? { type: "BooleanLiteral", value: true }
        : value.type === "MxMethod"
          ? methodFunctionOf(ctx, value)
          : clone(payloadOf(value)),
    modifier: named
      ? modifierToken
        ? modifierToken.value.value
        : null
      : words(run).slice(1),
    default: !named,
    bound: last.operator === ":=",
    arguments: last.args ? payloadOf(last.args) : undefined,
    start: first.start,
    end,
    loc: sugarLoc(ctx, first.start, end),
  };
}

/** Marko's `onOpenTagEnd`: the head's class merges into an authored `class`. */
function mergeHeadClass(ctx: Ctx, attributes: Node[], parts: Node[]): void {
  if (parts.length === 0) return;
  const first = parts[0] as Node;
  const last = parts[parts.length - 1] as Node;
  const shorthand =
    parts.length === 1
      ? first
      : parts.every((part) => part.type === "StringLiteral")
        ? stringLiteral(ctx, parts.map((part) => part.value).join(" "), {
            start: rangeOf(first).start,
            end: rangeOf(last).end,
          })
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

/**
 * Rewrites one MX tag's name sugar, once, into `sugarAttributesOf`. A tag
 * with no sugar gets no record and keeps its own attribute list.
 */
export function rewriteMxSugar(ctx: Ctx, tag: Node): void {
  const type = tag?.type;
  if (
    done.has(tag) ||
    (type !== "MxTag" && type !== "MxReturn" && type !== "MxAttributeTag")
  ) {
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
  const { nameNode, classParts, idPart } = markoHead(ctx, tag);
  // The authored attribute and its shaped record as built, before the rewrite.
  const origin = new Map<Node, { attr: Node; shaped: string }>();
  const attributes: Node[] = [];
  for (let i = 0; i < authored.length; i++) {
    const attr = authored[i] as Node;
    if (attr.type !== "MxShorthand") {
      const shaped = markoAttribute(ctx, attr);
      origin.set(shaped, { attr, shaped: JSON.stringify(shaped) });
      attributes.push(shaped);
      continue;
    }
    // A run ends at a gap, at a value, or before a second `:`.
    const run = [attr];
    while (true) {
      const prev = run[run.length - 1] as Node;
      const next = authored[i + 1];
      if (
        prev.default ||
        next?.type !== "MxShorthand" ||
        next.start !== prev.end ||
        (next.sigil === ":" && run.some((token) => token.sigil === ":"))
      ) {
        break;
      }
      run.push(next);
      i++;
    }
    attributes.push(markoSugarAttribute(ctx, run));
  }
  mergeHeadClass(ctx, attributes, classParts);
  if (idPart)
    attributes.push({ type: "MarkoAttribute", name: "id", value: idPart });
  const stand = { type: "MarkoTag", name: nameNode, attributes };
  rewriteSugarTag(ctx, stand);
  recordSugarAttributes(
    tag,
    stand.attributes.map((record: Node) => {
      // Untouched means the whole record is as built: a rewrite that set any
      // field on it (a `sugarLabel`, a changed value) keeps the record.
      const from = origin.get(record);
      return from && JSON.stringify(record) === from.shaped
        ? from.attr
        : record;
    }),
  );
}
