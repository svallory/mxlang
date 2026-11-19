import { contractDefaultTagProblems } from "./contract-default-tag.ts";
import { bodyChildren, type Ctx, isTagNode, type Node, raise } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type {
  DefaultTagContext,
  DefaultTagParent,
  HostDeclarations,
} from "./declarations.ts";
import {
  elementPredicate,
  judgingLookup,
  nativeElementPredicate,
} from "./default-tag-check.ts";
import type { DefaultTagScope } from "./default-tag-validate.ts";
import { INVALID_SHORTHAND_CODE } from "./diagnostic-codes.ts";
import { markoViewOf } from "./marko-view.ts";
import { voiceOfCtx } from "./message-vocabulary.ts";
import { isCoreTaglibTag, isNativeElementName } from "./native-element-name.ts";
import { rewriteShorthands } from "./shorthand.ts";
import {
  hasLiteralTagName,
  hasStaticName,
  resolveLiteralTagName,
  resolveUnnamedTag,
  tagNameExprOf,
  tagNameOf,
  tagNameSpanOf,
} from "./tag-fields.ts";
import { policyUnder, tagRulesPreset } from "./tag-presets.ts";
import {
  type ContractScope,
  matchWildcardChild,
  scopeForChildren,
} from "./wildcard-resolve.ts";

/**
 * An unnamed tag (`<#a>`, `<.a>`, concise `#a`) is `MxTagName` kind
 * `unnamed` in the MX AST. A Marko-shaped tag marks it with a `StringLiteral`
 * name over an *empty* source span, which no named tag has. That covers
 * Marko's own tree, where `@marko/compiler`'s parser writes `div` into the
 * name (`tagName.value ||= "div"`, because Marko has one host), and a view
 * (`marko-view.ts`).
 */
function isUnnamedTag(node: Node): boolean {
  // The MX AST says so itself (`MxTagName` kind `unnamed`).
  if (isTagNode(node) && node.name?.kind === "unnamed") return true;
  if (!isTagNode(node) || !hasStaticName(node)) {
    return false;
  }
  const loc = node.name.loc;
  return (
    !!loc &&
    loc.start.line === loc.end.line &&
    loc.start.column === loc.end.column
  );
}

/**
 * The native element a dynamic MX tag's one-quasi literal name with no
 * placeholder (`<${"div"}>`, `<${'div'}>`, `` <${`div`}> ``) names, when it
 * is one this compile lowers as an element: stock Marko (`normalizeTag`)
 * makes such a tag the static `<div>`. Not a core taglib tag (`style`,
 * `script`), a registered custom tag or a name the host delegates: those,
 * and every other literal, stay dynamic tags.
 */
function literalElementName(ctx: Ctx, node: Node): string | undefined {
  if (node?.type !== "MxTag" || node.name?.kind !== "dynamic") return;
  const literal = tagNameExprOf(node);
  if (
    literal?.type !== "TemplateLiteral" ||
    literal.expressions?.length !== 0 ||
    literal.quasis?.length !== 1
  ) {
    return;
  }
  const name = literal.quasis[0]?.value?.cooked;
  if (
    typeof name !== "string" ||
    !isNativeElementName(ctx, name) ||
    isCoreTaglibTag(ctx, name) ||
    !ctx.declarations.isElement(name, ctx) ||
    (ctx.customTags !== undefined && Object.hasOwn(ctx.customTags, name)) ||
    ctx.declarations.isDelegatedTag?.(name, ctx)
  ) {
    return;
  }
  return name;
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
  const lookup = judgingLookup(
    ctx.tagTable,
    ctx.declarations.nativeTags,
    ctx.tagRules,
  );
  return {
    ...(ctx.customTags ? { customTags: ctx.customTags } : {}),
    ...(lookup ? { lookup } : {}),
    isElement: elementPredicate(lookup, ctx.declarations),
    isNativeElement: nativeElementPredicate(lookup, ctx.declarations),
  };
}

/** Whether `declarations` are the ones this compile lowers under: the same object, or, under a preset, the object `policyUnder` made of them. */
function isCompileDeclarations(
  ctx: Ctx,
  declarations: HostDeclarations | undefined,
): boolean {
  if (!declarations) return false;
  if (declarations === ctx.declarations) return true;
  return (
    ctx.tagRules !== undefined &&
    policyUnder(
      tagRulesPreset(ctx.tagRules, declarations.nativeTags),
      declarations,
    ) === ctx.declarations
  );
}

/**
 * The registration check of a deferred contract's `defaultTag`s (a dialect
 * tag file's derived contract), run where its call reads it: the problems
 * `contractDefaultTagDiagnostics` reports for an eager contract at its
 * declaration, worded the same, judged in this compile's scope and refused
 * when this compile's declarations forbid the rung. The target is the one
 * whose declarations, default or strict, this compile runs under (else the
 * lookup's default), which names the host and adds its built-in tag names.
 */
export function deferredDefaultTagProblems(
  ctx: Ctx,
  name: string,
  definition: CustomTag,
): string[] {
  const targets = ctx.targets;
  const names = targets.allTargetNames?.() ?? targets.targetNames();
  const own =
    names.find((each) => {
      const declarations = targets.target(each)?.declarations;
      return (
        isCompileDeclarations(ctx, declarations?.default) ||
        isCompileDeclarations(ctx, declarations?.strict)
      );
    }) ?? targets.defaultTarget();
  const descriptor = targets.target(own);
  const hostName = descriptor?.host?.name;
  const builtins = [
    descriptor?.defaultTag,
    descriptor?.host?.defaultTag,
    ...(ctx.declarations.builtinTags ?? []),
  ].filter((value): value is string => value !== undefined);
  const scope = scopeOf(ctx);
  return contractDefaultTagProblems(
    name,
    definition,
    { ...scope, builtins: [...(scope.builtins ?? []), ...builtins] },
    {
      name: hostName ?? own,
      kind: hostName ? "host" : "target",
      ...(ctx.declarations.allowContractDefaultTag === false
        ? { allowContractDefaultTag: false }
        : {}),
    },
  );
}

/**
 * Replaces every unnamed tag's name with what the host's `resolveDefaultTag`
 * answers, and a literal dynamic name that names a native element
 * (`<${"div"}>`) with that element's, so the rest of the lowerer sees an
 * ordinary authored tag.
 *
 * Runs on the parsed tree (never the source), top-down, so an unnamed
 * ancestor is already resolved when it shows up in a descendant's `parents`.
 * The same walk records which tags a parent's `children["*"]` claims, so an
 * unnamed tag inside a wildcard child reads the matched contract's
 * `defaultTag`.
 */
export function resolveUnnamedTags(ctx: Ctx, body: readonly Node[]): void {
  const walk = (
    nodes: readonly Node[],
    parents: DefaultTagParent[],
    scope: ContractScope | undefined,
  ): void => {
    for (const node of new Set(nodes)) {
      // An MX attribute tag is its own kind (Marko's is a `MarkoTag` named
      // `@…`); it carries sugar and tags of its own all the same.
      if (!isTagNode(node) && node?.type !== "MxAttributeTag") continue;
      // Marko's `#id`/`.class` shorthand becomes the attributes it sets,
      // before the name is read.
      rewriteShorthands(ctx, node);
      // A literal naming an element is that element before anything reads
      // the name, as in stock Marko: routing, the wildcard claim below and
      // every sibling pre-scan see `<div>`.
      if (!hasLiteralTagName(node)) {
        const literal = literalElementName(ctx, node);
        if (literal !== undefined) resolveLiteralTagName(node, literal);
      }
      const unnamed = resolved.has(node) || isUnnamedTag(node);
      if (!resolved.has(node) && isUnnamedTag(node)) {
        resolved.add(node);
        const resolve = ctx.declarations.resolveDefaultTag;
        if (!resolve) {
          raise(
            INVALID_SHORTHAND_CODE,
            "no default tag is declared, so `#id`/`.class` cannot be used without a tag name; write the tag name explicitly",
            tagNameSpanOf(node),
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
        const resolvedName = resolve.call(
          ctx.declarations,
          markoViewOf(ctx, node),
          parents,
          context,
        );
        // The MX tree stays as parsed; Marko's name node is rewritten.
        if (node.name?.kind === "unnamed")
          resolveUnnamedTag(node, resolvedName);
        else node.name.value = resolvedName;
      }
      const named = hasStaticName(node);
      const authored = String(tagNameOf(node) ?? "");
      // An unnamed tag has no authored spelling to alias, and a dynamic name
      // no spelling at all: neither is a wildcard child.
      const match =
        named && !unnamed
          ? matchWildcardChild(node, authored, scope, ctx)
          : undefined;
      const name = match?.canonical ?? authored;
      const attributeTag = name.startsWith("@");
      const tagDef =
        attributeTag || match ? undefined : ctx.tagTable?.getTag(name);
      const self: DefaultTagParent = {
        name,
        attributeTag,
        node: markoViewOf(ctx, node),
        ...(tagDef ? { tagDef } : {}),
      };
      walk(
        [...bodyChildren(node), ...(node.attributeTags ?? [])],
        [self, ...parents],
        named
          ? scopeForChildren(node, name, scope, ctx.customTags, voiceOfCtx(ctx))
          : undefined,
      );
    }
  };
  walk(body, [], undefined);
}
