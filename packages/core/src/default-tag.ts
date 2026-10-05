import { dirname } from "node:path";
import {
  buildMarkoLookup,
  createTranslator,
  type Translator,
} from "./compile.ts";
import { type Ctx, type Node, TranslateError } from "./core.ts";
import type { DefaultTagParent } from "./declarations.ts";
import { elementPredicate } from "./default-tag-check.ts";
import type { DefaultTagScope } from "./default-tag-validate.ts";
import type { TargetLookup } from "./target-descriptor.ts";

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

const fallbackTranslators = new WeakMap<TargetLookup, Translator>();

/**
 * The lookup a default tag is judged in: the compile's own, or, for a host
 * that compiles without one (Solid, Astro templates), Marko's own element
 * taglibs, which a translator with no taglibs of its own still registers.
 * Elements and their parse shape are known; core and translator tags are not.
 */
function lookupOf(ctx: Ctx): Ctx["lookup"] {
  if (ctx.lookup) return ctx.lookup;
  let translator = fallbackTranslators.get(ctx.targets);
  if (!translator) {
    translator = createTranslator({
      taglibs: [],
      tagDiscoveryDirs: [],
      targets: ctx.targets,
    });
    fallbackTranslators.set(ctx.targets, translator);
  }
  return buildMarkoLookup(
    dirname(ctx.filename),
    translator,
  ) as unknown as Ctx["lookup"];
}

/** The scope this compile can judge a default tag in; a target adds its built-ins. */
function scopeOf(ctx: Ctx): DefaultTagScope {
  const lookup = lookupOf(ctx);
  return {
    ...(ctx.customTags ? { customTags: ctx.customTags } : {}),
    ...(lookup ? { lookup } : {}),
    isElement: elementPredicate(lookup, ctx.declarations),
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
        node.name.value = resolve.call(ctx.declarations, node, parents, {
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
        });
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
