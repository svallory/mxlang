/**
 * Reference syntax module (lang-ext-move-sugars-to-mesh, slice a1; decisions
 * 183 and 196): MX's atoms (decision 156) and name sugars (decision 146) as
 * layer-2 triggers, reproducing what core does for them today:
 *
 * - `:name` in an expression is an atom: a `StringLiteral` of the name
 *   marked `extra.mxAtom = { span }`. It is a name, not a value to operate
 *   on: member access, calls, unary operators, spreading and use as an
 *   object key are refused. `::name` is reserved.
 * - `:name` in an attribute list sets `name` to the atom, spelled by its
 *   token (`authored`), once per tag. Followed by `=value` or
 *   `(params) { body }` it also sets the tag's default value.
 * - Spaced `#id` and `.class` (chains such as `#main.big` included) are
 *   shorthands, exactly as Marko's tag-adjacent `#id` / `.class`. They take
 *   no value: the table refuses `=`, `:=` and `(` after them (decision 183).
 * - All three attribute rows end a preceding attribute value
 *   (`terminatesValue`): `x=a.b .c` is `x=a.b` and class `c`.
 *
 * Self-contained: it imports types only, so a manifest's `mx.syntax` can
 * `require` it, and Mesh can copy it (`mesh.ts` combines it with the
 * member module).
 */
import type {
  SourceSpan,
  SyntaxModule,
  Trigger,
  TriggerAttribute,
  TriggerContext,
  TriggerResult,
  TriggerShorthand,
} from "../index.ts";

/** An atom's name: an identifier, `-` between words (`:rename-all`). */
const NAME = "[A-Za-z_$][\\w$]*(?:-[\\w$]+)*";

/** `:name` in an expression; `::` (with or without a name) is matched so the hook can name it reserved. */
export const ATOM: Trigger = Object.freeze({
  id: "atom",
  chars: ":",
  match: `::(?:${NAME})?|:${NAME}`,
  standIn: "number",
  node: Object.freeze({ call: "atom" }),
});

/**
 * One item of a sugar token, as the attribute-name lexer reads it: a plain
 * character, a `/` that is no comment, a bracket run (`.bg-[#fff]`), or `:`
 * / `::` before a plain character (`#id:name`, `::x`).
 */
const PLAIN = "[^\\x00-\\x20,=()<>/:;\"'`[\\]{}]";
const SLASH = "/[^\\x00-\\x20,=()<>/:;\"'`[\\]{}*]";
const BRACKETS = "\\[[^\\x00-\\x20\"'`[\\]{}]{0,64}\\]";
const ITEM = `(?:${PLAIN}|${SLASH}|${BRACKETS}|:{1,2}${PLAIN})`;
/** A class starts with a name character, so `x=a .5` stays one value. */
const NAME_START = "[A-Za-z_$\\u200c\\u200d\\p{ID_Start}\\p{Mn}\\p{Mc}\\p{Pc}]";

/** `:name` in an attribute list (`uuid :id`). */
export const NAME_SUGAR: Trigger = Object.freeze({
  id: "name",
  chars: ":",
  match: `::?[A-Za-z_$]${ITEM}*`,
  standIn: "keep",
  node: Object.freeze({ call: "name" }),
  terminatesValue: true,
});

/** Spaced `#id` (a chain: `#main.big`). */
export const ID_SUGAR: Trigger = Object.freeze({
  id: "id",
  chars: "#",
  match: `#${ITEM}+`,
  standIn: "keep",
  node: Object.freeze({ call: "shorthand" }),
  terminatesValue: true,
  value: "refuse",
});

/** Spaced `.class` (a chain: `.big#main`). */
export const CLASS_SUGAR: Trigger = Object.freeze({
  id: "class",
  chars: ".",
  match: `\\.${NAME_START}${ITEM}*`,
  standIn: "keep",
  node: Object.freeze({ call: "shorthand" }),
  terminatesValue: true,
  value: "refuse",
});

const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;

const SECOND_NAME =
  'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)';

const SECOND_DEFAULT =
  "a `:name` followed by `=value` or `(params) { body }` sets the default attribute (`value`), but the tag already has a default value; write `value=…` once";

function reserved(name: string): string {
  return `\`::${name}\` is reserved (decision 156): \`::\` will be the Symbol.for sugar; write \`:${name || "name"}\` for an atom`;
}

function misuse(name: string, what: string): string {
  return `\`:${name}\` is an atom (decision 156), a name and not a value to operate on: ${what} is not allowed on it; write \`"${name}"\` for a string you mean to operate on`;
}

/** `:name` in an expression: the atom, or the module's refusal of its use. */
function atom(
  text: string,
  span: SourceSpan,
  ctx: TriggerContext,
): TriggerResult {
  if (text.startsWith("::")) ctx.fail(reserved(text.slice(2)));
  const name = text.slice(1);
  switch (ctx.use) {
    case "member-object":
      ctx.fail(misuse(name, "member access"));
      break;
    case "callee":
      ctx.fail(misuse(name, "a call"));
      break;
    case "unary":
      ctx.fail(misuse(name, `the unary operator \`${ctx.operator}\``));
      break;
    case "spread":
      ctx.fail(misuse(name, "spreading"));
      break;
    case "key":
      ctx.fail(
        `\`:${name}\` cannot be an object key: an atom is a value (decision 156); write \`${name}:\` for the key, or \`[:${name}]\` to compute it from the atom`,
      );
  }
  return ctx.expression({
    type: "StringLiteral",
    value: name,
    extra: { raw: JSON.stringify(name), rawValue: name, mxAtom: { span } },
  });
}

/** `:name` in an attribute list: `name` set to the atom, and the default value when one follows. */
function nameSugar(
  name: string,
  ctx: TriggerContext,
  at?: SourceSpan,
): TriggerAttribute[] {
  if (name.startsWith(":")) ctx.fail(reserved(name.slice(1)));
  if (name.includes(":")) ctx.fail(SECOND_NAME);
  if (!IDENTIFIER.test(name)) {
    ctx.fail(
      `\`:${name}\` is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
    );
  }
  // A second spaced `:name` follows the duplicate rule (last wins, with a
  // warning), as any attribute; only `:a:b` in one token is refused above.
  const attrs = [
    ctx.attribute(
      "name",
      { kind: "atom", name },
      { authored: true, ...(at ? { at } : {}) },
    ),
  ];
  if (ctx.value) {
    attrs.push(
      ctx.attribute(null, ctx.value, { authored: true, once: SECOND_DEFAULT }),
    );
  }
  return attrs;
}

/** `#a.b:c`: its shorthands in order, and a trailing `:name`. */
function shorthands(
  text: string,
  span: SourceSpan,
  ctx: TriggerContext,
): (TriggerAttribute | TriggerShorthand)[] {
  const colon = text.indexOf(":");
  const chain = colon < 0 ? text : text.slice(0, colon);
  const parts: (TriggerAttribute | TriggerShorthand)[] = [];
  for (const [, sigil, word] of chain.matchAll(/([#.])([^#.]*)/g)) {
    if (word === "") {
      ctx.fail(
        `\`${sigil}\` is shorthand for ${sigil === "#" ? "`id`" : "`class`"} and needs a name after it`,
      );
    }
    parts.push(ctx.shorthand(sigil === "#" ? "id" : "class", word as string));
  }
  if (colon >= 0) {
    const at = {
      sourceStart: span.sourceStart + colon,
      sourceEnd: span.sourceEnd,
    };
    parts.push(...nameSugar(text.slice(colon + 1), ctx, at));
  }
  return parts;
}

const atomsSugars = {
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM]),
    attributeTriggers: Object.freeze([NAME_SUGAR, ID_SUGAR, CLASS_SUGAR]),
  }),
  lowerTrigger(id, text, span, ctx) {
    switch (id) {
      case "atom":
        return atom(text, span, ctx);
      case "name":
        return nameSugar(text.slice(1), ctx);
      default:
        return shorthands(text, span, ctx);
    }
  },
} satisfies SyntaxModule;

export default Object.freeze(atomsSugars) as SyntaxModule;
