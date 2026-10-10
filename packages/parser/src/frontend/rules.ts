/**
 * The front-end `MX_*` rules (ast §3.13, PR 2b).
 *
 * Each finished tag hands itself to `frontEndRules` (via the seam in
 * `parse.ts`), in document order: innermost first on close, then its
 * ancestors at `stopAll` in the same order. The rules reproduce the errors
 * today's path reports — Marko's own parse errors (`statementTagInHTMLMode`,
 * scriptlet `%`, attribute tag at root) with their message text and ranges,
 * and the sugar errors `@mxlang/core`'s lowering raises (name-sugar.ts) as
 * recorded errors, in the order that lowering checks them (head first, then
 * attributes), so the first recorded error is the one today's path throws.
 *
 * What is NOT here, on purpose (ast §3.13): a duplicate default value
 * (lowering's `MX_DUPLICATE_DEFAULT`), `MX_SUGAR_BOUND` for `#` (host
 * policy, lowering), and the decision-174 bracket/numeric shorthand errors
 * (also lowering's today).
 */

import { parseExpression } from "@mxlang/babel";
import type { MxErrorCode, MxParseError } from "@mxlang/babel/mx-ast";
import { createParser } from "../template/index.ts";
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

/** `[A-Za-z_$][\w$-]*`: the identifier-like word `:name` sugar takes (name-sugar.ts). */
const SUGAR_TOKEN = /^[A-Za-z_$][\w$-]*$/;

const SECOND_NAME =
  'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)';

const BOUND_ON_SUGAR =
  "a bound value is not supported on name sugar; write name=... value:=...";

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

const COLON_BEFORE_DYNAMIC =
  'a `:` before a `${…}` in a shorthand class or id is not allowed: a shorthand cannot contain `:` (write the value as `class="…"`)';

/** A zero-width or one-character error at a local offset. */
function point(
  ctx: RuleContext,
  code: MxErrorCode,
  message: string,
  local: number,
): MxParseError {
  return {
    type: "MxParseError",
    start: ctx.offset + local,
    end: ctx.offset + local + 1,
    code,
    origin: "front-end",
    message,
    context: null,
  };
}

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

function sliceSpan(ctx: RuleContext, start: number, end: number): string {
  return ctx.source.slice(localOf(ctx, start), localOf(ctx, end));
}

/** Is `word` something the template parser accepts as one shorthand token (name-sugar.ts's probe, over the port's own parser)? */
const shorthandProbe = new Map<string, boolean>();
function isShorthandWord(sigil: string, word: string): boolean {
  const key = `${sigil}${word}`;
  const known = shorthandProbe.get(key);
  if (known !== undefined) return known;
  const source = `<a${key}/>`;
  const seen: string[] = [];
  let failed = false;
  const part = (event: { quasis: { start: number; end: number }[] }) => {
    seen.push(source.slice(event.quasis[0]?.start, event.quasis[0]?.end));
  };
  try {
    createParser({
      // biome-ignore lint/suspicious/noExplicitAny: the parser's handlers are structural
      onTagShorthandClass: part as any,
      // biome-ignore lint/suspicious/noExplicitAny: the parser's handlers are structural
      onTagShorthandId: part as any,
      onError: () => {
        failed = true;
      },
      // biome-ignore lint/suspicious/noExplicitAny: the parser's handlers are structural
    } as any).parse(source);
  } catch {
    failed = true;
  }
  const answer = !failed && seen.length === 1 && seen[0] === word;
  if (shorthandProbe.size >= 1000) shorthandProbe.clear();
  shorthandProbe.set(key, answer);
  return answer;
}

/** `:name` in the tag head or a shorthand value: the word must be an identifier-like token (name-sugar.ts `checkToken`). */
function checkToken(
  ctx: RuleContext,
  errs: MxParseError[],
  name: string,
  colon: number,
  form: string,
): void {
  if (!SUGAR_TOKEN.test(name)) {
    errs.push(
      point(
        ctx,
        name === "" ? "MX_SUGAR_NAME_MISSING" : "MX_SUGAR_NAME_INVALID",
        name === ""
          ? `\`:\` in ${form} needs a name after it (\`:email\`)`
          : `\`:${name}\` in ${form} is not a name; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
        colon,
      ),
    );
  }
}

type HeadName = { start: number; end: number };

/** The `:name` inside a shorthand part's value, as `headNamesIn` finds it (a space in the merged value is the source's next sigil). */
function headNamesInValue(
  ctx: RuleContext,
  errs: MxParseError[],
  text: string,
  textStart: number,
  found: HeadName[],
): void {
  const idx = text.indexOf(":");
  if (idx < 0) return;
  const stop = text.indexOf(" ", idx);
  const name = text.slice(idx + 1, stop < 0 ? text.length : stop);
  const rest = stop < 0 ? "" : text.slice(stop);
  const colon = textStart + idx;
  checkToken(ctx, errs, name, colon, "a shorthand class or id");
  found.push({ start: colon, end: colon + 1 + name.length });
  const again = rest.indexOf(":");
  if (again >= 0) {
    found.push({
      start: colon + 1 + name.length + again,
      end: colon + 1 + name.length + again + 1,
    });
  }
}

/**
 * The tag-position (tag-adjacent) shorthands, in source order: the `.`/`#`
 * events, then any `:` sugar the name split or a dynamic tail produced.
 * Events arrive name-first, so `shorthands` is already in source order.
 */
function tagShorthands(tag: TagBuilder): Any[] {
  return (tag.shorthands as Any[]).filter((s) => s.position === "tag");
}

/** RewriteHead: the tag name's `:` and every shorthand's `:`, then one `:name` per tag at most. */
function headRules(
  ctx: RuleContext,
  errs: MxParseError[],
  tag: TagBuilder,
): void {
  const name = tag.name as Any;
  const found: HeadName[] = [];

  // The name's own `:` (`a:b` — or the word after the last `:` of `a:b:c`,
  // whose second colon is a second name below).
  // `<div:=x/>`: the tag-adjacent `:` is the default attribute bound
  // (`:=`), not name sugar — the default-attr rule in `frontEndRules` owns it.
  const boundDefault = (tag.attributes as Any[]).some(
    (item) =>
      item.type === "MxAttribute" &&
      item.name === null &&
      item.start === name?.span?.end,
  );
  // `<:1/>` / `<:/>` / `<:b:c/>`: an unnamed tag whose head starts with
  // `:` — the colon is the name's sugar and its word is the tag's name.
  const unnamedColon =
    name?.kind === "unnamed" &&
    sliceSpan(ctx, name.span.start, name.span.start + 1) === ":";
  if (
    tag.type !== "MxAttributeTag" &&
    !boundDefault &&
    (name?.kind === "static" || unnamedColon)
  ) {
    const at = unnamedColon ? name.span.start : name.span.end;
    const colonSugar = tagShorthands(tag).find(
      (s) => s.sigil === ":" && s.start === at,
    );
    // `a:` (a trailing colon) never produced a sugar; its word is empty.
    const afterColon =
      colonSugar !== undefined
        ? String(colonSugar.value?.value ?? "")
        : sliceSpan(ctx, at, at + 1) === ":"
          ? ""
          : undefined;
    if (afterColon !== undefined) {
      const colon = localOf(ctx, at);
      const word = afterColon.split(":")[0] ?? "";
      checkToken(ctx, errs, word, colon, "a tag name");
      found.push({ start: colon, end: colon + 1 + word.length });
      const rest = afterColon.slice(word.length);
      const again = rest.indexOf(":");
      if (again >= 0) {
        found.push({
          start: colon + 1 + word.length + again,
          end: colon + 1 + word.length + again + 1,
        });
      }
    }
  }

  // The `.`/`#` shorthands' own `:` (`<a.c:x>`), and a `:` before a `${…}`.
  for (const s of tagShorthands(tag)) {
    if (s.sigil === ":") continue; // handled above (name) or below (dynamic tail)
    const value = s.value as Any;
    if (value?.kind === "dynamic") {
      // headNamesIn's template branch: a `:` in every quasi but the last…
      const quasis = (value.quasis ?? []) as { start: number; end: number }[];
      for (const quasi of quasis.slice(0, -1)) {
        const raw = sliceSpan(ctx, quasi.start, quasi.end);
        const at = raw.indexOf(":");
        if (at >= 0) {
          errs.push(
            point(
              ctx,
              "MX_COLON_BEFORE_DYNAMIC",
              COLON_BEFORE_DYNAMIC,
              localOf(ctx, quasi.start) + at,
            ),
          );
        }
      }
      // …and the static tail's `:` is the `:` sugar the split made: it joins
      // `found` with its word (handled with the `:` sugars below).
      continue;
    }
    const text = String(value?.value ?? "");
    headNamesInValue(ctx, errs, text, localOf(ctx, s.start) + 1, found);
  }

  // `<div.c:/>` / `<div.${x}:/>`: an empty word after a shorthand's `:`
  // makes no sugar (the split leaves it empty), so read the authored colon
  // off the source here — today reports it (`calibration` F4).
  for (const s of tagShorthands(tag)) {
    if (s.sigil === ":") continue;
    const at = s.end;
    if (
      sliceSpan(ctx, at, at + 1) === ":" &&
      !tagShorthands(tag).some((t) => t.start === at)
    ) {
      checkToken(ctx, errs, "", localOf(ctx, at), "a shorthand class or id");
    }
  }

  // A `:` sugar a dynamic tail or the name split produced (`<a.c${x}:y>`).
  for (const s of tagShorthands(tag)) {
    if (s.sigil !== ":") continue;
    if (s.start === (name?.span?.end ?? -1)) continue; // the name's own — done
    const value = s.value as Any;
    if (value?.kind === "static") {
      const colon = localOf(ctx, s.start);
      checkToken(
        ctx,
        errs,
        String(value.value ?? ""),
        colon,
        "a shorthand class or id",
      );
      found.push({
        start: colon,
        end: colon + 1 + String(value.value ?? "").length,
      });
    }
  }

  found.sort((a, b) => a.start - b.start);
  if (found.length > 1) {
    errs.push(point(ctx, "MX_SECOND_NAME", SECOND_NAME, found[1].start));
  }
}

/** One attribute-position sugar chain: the items one `onAttrName` produced (adjacent spans). */
function chainsOf(tag: TagBuilder): Any[][] {
  const chains: Any[][] = [];
  for (const item of tag.attributes as Any[]) {
    const last = chains.at(-1)?.at(-1);
    if (
      item.type === "MxShorthand" &&
      last?.type === "MxShorthand" &&
      item.start === last.end
    ) {
      chains.at(-1)?.push(item);
    } else {
      chains.push(item.type === "MxShorthand" ? [item] : []);
    }
  }
  return chains.filter((chain) => chain.length > 0);
}

/** Marko's split of an attribute's authored name: at the last `:` (name-sugar.ts `checkNearSugar`, `rewriteAttributes`). */
function attrChainRules(
  ctx: RuleContext,
  errs: MxParseError[],
  tag: TagBuilder,
  chain: Any[],
): void {
  const first = chain[0];
  const textStart = localOf(ctx, first.start);
  const textEnd = localOf(ctx, chain.at(-1)?.end ?? first.end);
  const text = ctx.source.slice(textStart, textEnd);
  const lastColon = text.lastIndexOf(":");
  // Today's `authored` covers a value or arguments after the sugar; the
  // operator and the value attach to the LAST split item (parse.ts
  // `onAttrValue`), so every item's args/default counts toward the end.
  const fullEnd = localOf(
    ctx,
    Math.max(
      chain.at(-1)?.end ?? first.end,
      ...chain.flatMap((item) => [
        (item.args as Any | null)?.end ?? 0,
        (item.default as Any | null)?.end ?? 0,
      ]),
    ),
  );
  const authored = `\`${ctx.source.slice(textStart, Math.max(fullEnd, textEnd))}\``;

  // `:n:=y` / `.c:=y` / `#x:=y`: `:=` is not a sugar value separator. The
  // operator attaches to the last split item, but the rule reads the
  // chain's authored sigil (its first character) — today's dot-sugar rule
  // fires regardless of whether the value is bindable.
  const bound = chain.find((item) => item.operator === ":=");
  if (bound) {
    const startChar = text[0];
    if (startChar === "#") {
      return; // `#` is host policy: lowering raises it (ast §3.6 rule 7)
    }
    if (startChar === ".") {
      errs.push(point(ctx, "MX_SUGAR_BOUND", BOUND_ON_SUGAR, textStart));
      return;
    }
    // `:n:=y` and `<div:=x/>` (an empty `:name`): BOUND. `:n:=1` binds a
    // non-identifier: Marko's own binding error fires there first today,
    // lowering's to raise — decided by parsing the value, exactly as
    // today's lowering decides it (a real expression node-kind check).
    if (isBindableValue((bound.default as Any)?.source)) {
      errs.push(point(ctx, "MX_SUGAR_BOUND", BOUND_ON_SUGAR, textStart));
      return;
    }
    return; // Marko's own binding error is lowering's to raise
  }

  // Arguments with no body (`:b(x)`, `.c(p)`, `.c:x(p)`): today the attr is
  // not sugar at all (an attr with arguments never is), so `checkNearSugar`
  // raises this before any name or word check.
  if (chain.some((item) => item.args) && !chain.some((item) => item.default)) {
    if (text.startsWith(":")) {
      // Today's text literally says `:name` here (name-sugar.ts), not the
      // authored name — calibrated byte-for-byte, so it stays.
      const name = text.slice(1).split(":")[0].split("(")[0];
      errs.push(
        point(
          ctx,
          "MX_SUGAR_ARGUMENTS",
          `arguments are not allowed on \`:name\`: \`:${name}(\u2026)\` is name sugar, not an attribute method`,
          textStart,
        ),
      );
    } else {
      const authored = lastColon > 0 ? text.slice(0, lastColon) : text;
      errs.push(
        point(
          ctx,
          "MX_SUGAR_ARGUMENTS",
          `arguments are not allowed on \`${authored}\`: it is name sugar; a \`(params) { body }\` after it sets the default value`,
          textStart,
        ),
      );
    }
    return;
  }

  if (text.startsWith(":")) {
    // `:b:c`: Marko's name/modifier split keeps `:b` as the name — two names.
    if (lastColon > 0) {
      errs.push(
        point(ctx, "MX_SECOND_NAME", SECOND_NAME, textStart + lastColon),
      );
      return;
    }
    const word = text.slice(1);
    if (word === "") {
      errs.push(
        point(
          ctx,
          "MX_SUGAR_NAME_MISSING",
          "`:` is name sugar and needs a name (`:email`); write `value:` for the `value` attribute",
          textStart,
        ),
      );
      return;
    }
    if (!SUGAR_TOKEN.test(word)) {
      errs.push(
        point(
          ctx,
          "MX_SUGAR_NAME_INVALID",
          `${authored} is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
          textStart,
        ),
      );
      return;
    }
    return;
  }

  // A `.`/`#` chain, split as Marko's `splitShorthandChain` splits it.
  // `.c:x:y` is TWO names in today's split (the chain word `c:x` holds the
  // colon): one `MX_SECOND_NAME` at the first colon, before any word check.
  const firstColon = text.indexOf(":", 1);
  if (firstColon > 0 && lastColon > firstColon) {
    errs.push(
      point(ctx, "MX_SECOND_NAME", SECOND_NAME, textStart + firstColon),
    );
    return;
  }
  for (const item of chain) {
    const sigil = item.sigil;
    if (sigil === ":") continue; // the trailing `:y` — handled below
    const value = item.value as Any;
    const word = String(value?.value ?? "");
    const partStart = localOf(ctx, item.start);
    if (word.includes("${")) {
      // The word ends at a `:` inside the placeholder (Marko's name/modifier
      // split takes the tail as the modifier).
      let cut = word.length;
      let depth = 0;
      for (let i = 0; i < word.length; i++) {
        if (word[i] === "$" && word[i + 1] === "{") depth++;
        else if (depth > 0 && word[i] === "}") depth--;
        else if (depth > 0 && word[i] === ":") {
          cut = i;
          break;
        }
      }
      const shown = word.slice(0, cut);
      // Today's fallback (`checkNearSugar`): the tag's static name, else
      // `"div"` — a dynamic or unnamed tag has no string name to show.
      const name = tag.name as Any;
      const nodeName = name?.kind === "static" ? (name.value ?? "div") : "div";
      errs.push(
        point(
          ctx,
          "MX_SUGAR_DYNAMIC",
          `a dynamic shorthand works only tag-adjacent (\`<${nodeName || "div"}${sigil}${shown}>\`), not as \`${sigil}${shown}\` after the tag name`,
          partStart,
        ),
      );
      continue;
    }
    if (word === "" || !isShorthandWord(sigil, word)) {
      errs.push(
        point(
          ctx,
          word === "" ? "MX_SUGAR_NAME_MISSING" : "MX_SHORTHAND_INVALID",
          word === ""
            ? `\`${sigil}\` needs a name after it (\`${sigil}main\`)`
            : `\`${sigil}${word}\` is not a valid shorthand name`,
          partStart,
        ),
      );
    }
  }

  // A trailing `:y` (`.c:y`, `#d:y`): the word follows the chain's cursor.
  const tail = chain.find((item) => item.sigil === ":");
  if (tail) {
    const colon = localOf(ctx, tail.start);
    const word = String((tail.value as Any)?.value ?? "");
    checkToken(ctx, errs, word, colon, authored);
  }
}

/** A value a sugar may bind: an identifier or member expression, exactly as today's lowering decides it — by parsing the value and looking at the Babel node kind (name-sugar.ts `checkNearSugar`). */
function isBindableValue(source: string | undefined): boolean {
  if (!source) return false;
  try {
    const node = parseExpression(source);
    return node.type === "Identifier" || node.type === "MemberExpression";
  } catch {
    return false;
  }
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
    if (
      !tag.concise &&
      ctx.statementKeywords.has(name.value) &&
      ctx.source[localOf(ctx, name.span.end)] !== ":"
    ) {
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

  // `import:x` — a `:name` on a statement tag, wherever it sits.
  if (name?.kind === "static" && ctx.statementKeywords.has(name.value)) {
    const colon =
      tagShorthands(tag).find(
        (s) => s.sigil === ":" && s.start === name.span.end,
      ) ??
      // `<import:/>`: an empty trailing word makes no sugar — read the
      // authored colon off the source (today reports it, `calibration` F4).
      (sliceSpan(ctx, name.span.end, name.span.end + 1) === ":"
        ? { start: name.span.end }
        : undefined);
    if (colon) {
      errs.push(
        point(
          ctx,
          "MX_SUGAR_ON_STATEMENT",
          `a \`:name\` is not supported on the statement tag \`${name.value}\`: its text is code, not attributes — write \`${name.value} …\` at the root of the template instead`,
          localOf(ctx, colon.start),
        ),
      );
      return errs;
    }
  }

  headRules(ctx, errs, tag);
  // `<div:=x/>`: the default attribute bound (`:=` after a tag-adjacent `:`).
  // The value being a non-identifier (`:=1`) is Marko's own binding error,
  // lowering's to raise; the sugar rule fires either way (ast §3.6). An
  // attribute-position `:=x` (`<div :=x/>`) is not sugar: it is Marko's own
  // `value:=x`, bound (name-sugar.ts `checkNearSugar`: an empty modifier),
  // and a value that cannot be bound keeps Marko's own binding error.
  const headEnd = Math.max(
    name?.span?.end ?? -1,
    ...tagShorthands(tag).map((shorthand) => shorthand.end as number),
  );
  for (const item of tag.attributes as Any[]) {
    if (
      item.type === "MxAttribute" &&
      item.name === null &&
      item.operator === ":=" &&
      item.start === headEnd
    ) {
      errs.push(
        point(ctx, "MX_SUGAR_BOUND", BOUND_ON_SUGAR, localOf(ctx, item.start)),
      );
    }
  }
  for (const chain of chainsOf(tag)) {
    attrChainRules(ctx, errs, tag, chain);
  }
  errs.sort((a, b) => a.start - b.start);
  return errs;
}

/** Test-only: forget the shorthand probe cache. */
export function clearShorthandProbe(): void {
  shorthandProbe.clear();
}
