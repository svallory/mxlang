import { dirname } from "node:path";
import { declaredContractDefaultTag } from "./contract-default-tag.ts";
import { type Ctx, type Node, TranslateError } from "./core.ts";
import type { DefaultTagContext, DefaultTagParent } from "./declarations.ts";
import {
  elementPredicate,
  judgingLookup,
  nativeElementPredicate,
} from "./default-tag-check.ts";
import type { DefaultTagScope } from "./default-tag-validate.ts";

/**
 * Marko's parser writes `div` into the name of every tag that has only a
 * shorthand (`<#a>`, `<.a>`, concise `#a`) — `tagName.value ||= "div"` in
 * `@marko/compiler`'s parser, because Marko has one host. The name node it
 * leaves is a `StringLiteral` with an *empty* source span, which no named tag
 * has; that is the one reliable mark of the unnamed tag.
 */
function isUnnamedTag(node: Node): boolean {
  if (node?.type !== "MarkoTag" || node.name?.type !== "StringLiteral") {
    return false;
  }
  const loc = node.name.loc;
  return (
    !!loc &&
    loc.start.line === loc.end.line &&
    loc.start.column === loc.end.column
  );
}

const resolved = new WeakSet<Node>();
const hints = new WeakMap<Node, string>();

/**
 * Why an unnamed tag is not what its parent's contract asked for, when that
 * contract's `defaultTag` was invalid and the next rung answered: the use-site
 * error then says so instead of naming a tag the author never wrote.
 */
export function invalidDefaultTagHint(node: Node): string | undefined {
  return hints.get(node);
}

/** The scope this compile can judge a default tag in; a target adds its built-ins. */
function scopeOf(ctx: Ctx): DefaultTagScope {
  const lookup = judgingLookup(ctx.lookup, dirname(ctx.filename));
  return {
    ...(ctx.customTags ? { customTags: ctx.customTags } : {}),
    ...(lookup ? { lookup } : {}),
    isElement: elementPredicate(lookup, ctx.declarations),
    isNativeElement: nativeElementPredicate(lookup, ctx.declarations),
  };
}

/**
 * Replaces every unnamed tag's name with what the host's `resolveDefaultTag`
 * answers, so the rest of the lowerer sees an ordinary authored tag.
 *
 * Runs on the parsed tree (never the source), top-down, so an unnamed
 * ancestor is already resolved when it shows up in a descendant's `parents`.
 */
export function resolveUnnamedTags(ctx: Ctx, body: readonly Node[]): void {
  const walk = (nodes: readonly Node[], parents: DefaultTagParent[]): void => {
    for (const node of new Set(nodes)) {
      if (node?.type !== "MarkoTag") continue;
      if (!resolved.has(node) && isUnnamedTag(node)) {
        resolved.add(node);
        const resolve = ctx.declarations.resolveDefaultTag;
        if (!resolve) {
          const at = node.name.loc.start;
          throw new TranslateError(
            "no default tag is declared, so `#id`/`.class` cannot be used without a tag name; write the tag name explicitly",
            at.line,
            at.column,
          );
        }
        const context: DefaultTagContext = {
          ...(ctx.declarations.allowContractDefaultTag === false
            ? { contractRung: false }
            : {}),
          scope: scopeOf(ctx),
          ...(ctx.defaultTag === undefined
            ? {}
            : { configured: ctx.defaultTag }),
          ...(ctx.customTags === undefined
            ? {}
            : { customTags: ctx.customTags }),
        };
        const answer = resolve.call(ctx.declarations, node, parents, context);
        node.name.value = answer;
        // A contract value that was not taken (invalid) is remembered for the
        // use-site error; one the resolver answered (valid) needs no hint.
        const declared =
          context.contractRung === false
            ? undefined
            : declaredContractDefaultTag(parents, ctx.customTags);
        if (declared !== undefined && declared !== answer)
          hints.set(
            node,
            `(the parent's \`defaultTag\` \`${declared}\` is invalid; see the declaration)`,
          );
      }
      const name = String(node.name?.value ?? "");
      const attributeTag = name.startsWith("@");
      const tagDef = attributeTag ? undefined : ctx.lookup?.getTag(name);
      const self: DefaultTagParent = {
        name,
        attributeTag,
        node,
        ...(tagDef ? { tagDef } : {}),
      };
      walk(
        [...(node.body?.body ?? []), ...(node.attributeTags ?? [])],
        [self, ...parents],
      );
    }
  };
  walk(body, []);
}
