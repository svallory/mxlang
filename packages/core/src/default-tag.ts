import { dirname } from "node:path";
import { type Ctx, type Node, TranslateError } from "./core.ts";
import type { DefaultTagContext, DefaultTagParent } from "./declarations.ts";
import {
  elementPredicate,
  judgingLookup,
  nativeElementPredicate,
} from "./default-tag-check.ts";
import type { DefaultTagScope } from "./default-tag-validate.ts";
import { rewriteNameSugar } from "./name-sugar.ts";
import {
  type ContractScope,
  matchWildcardChild,
  scopeForChildren,
} from "./wildcard-resolve.ts";

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
 * The same walk records which tags a parent's `children["*"]` claims
 * (decision 147), so an unnamed tag inside a wildcard child reads the matched
 * contract's `defaultTag`.
 */
export function resolveUnnamedTags(ctx: Ctx, body: readonly Node[]): void {
  const walk = (
    nodes: readonly Node[],
    parents: DefaultTagParent[],
    scope: ContractScope | undefined,
  ): void => {
    for (const node of new Set(nodes)) {
      if (node?.type !== "MarkoTag") continue;
      // Decision 146: `:name`/`#id`/`.class` sugar turns into the tag the
      // author would have written without it, before the name is read.
      rewriteNameSugar(ctx, node);
      const unnamed = resolved.has(node) || isUnnamedTag(node);
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
          // Only a value validateDefaultTag rejected earns the use-site hint.
          onContractRejected: (declared) =>
            hints.set(
              node,
              `(the parent's \`defaultTag\` \`${declared}\` is invalid; see the declaration)`,
            ),
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
        node.name.value = resolve.call(
          ctx.declarations,
          node,
          parents,
          context,
        );
      }
      const named = node.name?.type === "StringLiteral";
      const authored = String(node.name?.value ?? "");
      // An unnamed tag has no authored spelling to alias, and a dynamic name
      // no spelling at all: neither is a wildcard child.
      const match =
        named && !unnamed
          ? matchWildcardChild(node, authored, scope, ctx)
          : undefined;
      const name = match?.canonical ?? authored;
      const attributeTag = name.startsWith("@");
      const tagDef =
        attributeTag || match ? undefined : ctx.lookup?.getTag(name);
      const self: DefaultTagParent = {
        name,
        attributeTag,
        node,
        ...(tagDef ? { tagDef } : {}),
      };
      walk(
        [...(node.body?.body ?? []), ...(node.attributeTags ?? [])],
        [self, ...parents],
        named ? scopeForChildren(node, name, scope, ctx.customTags) : undefined,
      );
    }
  };
  walk(body, [], undefined);
}
