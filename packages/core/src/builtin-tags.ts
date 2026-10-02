/**
 * Core-owned custom tags (spec `custom-tags.md` §5 P4).
 *
 * `<try>` used to be five near-identical per-host implementations, each
 * re-deriving the same `<@catch>`/`<@placeholder>` shape checks by walking the
 * raw Marko node in its own `resolveDelegatedTag`. It is now one definition here,
 * expressed in terms of `ctx.build.delegatedTag("try", ...)` — the boundary the
 * spec draws between a tag (what) and a host (how): a host that claims `"try"`
 * still decides its own rendering (`packages/hosts/*` keep that), but the
 * shape of a `<try>` call — no params, no `/var`, at most one `<@catch>`, at
 * most one `<@placeholder>` with no params of its own — is asked and answered
 * exactly once.
 *
 * Registered in `BUILTIN_CUSTOM_TAGS`, consulted by `lower.ts` ahead of a
 * caller's own `ctx.customTags` so this map's entries can never be shadowed
 * at the call site (`lowerTag`'s custom-tag branch), and by
 * `rejectShadowedRegistration` below so a shadowing *registration* — before
 * any file using it is even parsed — fails the same way.
 */

import { TranslateError } from "./core.ts";
import {
  type CustomTag,
  shadowedBuiltinMessage,
  type TagCall,
  type TransformContext,
} from "./custom-tags.ts";
import type { IrNode } from "./ir.ts";

function tryTransform(call: TagCall, ctx: TransformContext): IrNode[] {
  if (call.params.length > 0) {
    ctx.fail("tag params (`|a, b|`) on `<try>`");
  }
  if (call.var !== null) {
    ctx.fail("tag variable (`/name`) on `<try>`");
  }

  // The declared `attributeTags` contract on this definition already rejects
  // an unknown or repeated `<@name>` before `transform` runs; only `<try>`'s
  // own additional shape rule — no params on `<@placeholder>` — is checked
  // here.
  const placeholder = call.attributeTags.find(
    (tag) => tag.name === "placeholder",
  );
  if (placeholder && placeholder.block.params.length > 0) {
    ctx.fail(
      "tag params (`|a, b|`) on `<@placeholder>`",
      placeholder.block.loc,
    );
  }

  return [
    ctx.build.delegatedTag("try", call.content?.children ?? [], call.attributeTags),
  ];
}

const tryTag: CustomTag = {
  // Declared empty rather than omitted: an omitted `attributes` skips the
  // generic check entirely (see `validateCustomTagCall`), which would let
  // `<try foo=1>` compile silently instead of failing on the unknown
  // attribute the same way it always has.
  attributes: {},
  attributeTags: {
    catch: {},
    placeholder: {},
  },
  transform: tryTransform,
};

/**
 * Core-owned tag definitions, keyed by name.
 *
 * `lower.ts` consults this before a caller's own `ctx.customTags`, so a name
 * listed here is never reachable through a user's registered map — see the
 * comment at the custom-tag branch of `lowerTag`.
 */
export const BUILTIN_CUSTOM_TAGS: Readonly<Record<string, CustomTag>> = {
  try: tryTag,
};

/**
 * Rejects a `customTags` registration that shadows a built-in, before any
 * file using it is parsed.
 *
 * Called from both `compile.ts` (whole-file compile) and `fragment.ts`
 * (`.solid.mx`/TS-plugin) ahead of `customTagTaglib`, which otherwise injects
 * a shadowing registration's own `parseOptions` into the parser — so a
 * shadow attempt that also set `parseOptions` (e.g. `try: { parseOptions: {
 * openTagOnly: true } }`) surfaced as an unrelated parser error instead of
 * this diagnostic. `lowerTag`'s call-site check stays too, for the ordinary
 * case where a name is registered without touching `parseOptions`.
 */
export function rejectShadowedRegistration(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): void {
  if (!customTags) return;
  for (const name of Object.keys(customTags)) {
    if (Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)) {
      throw new TranslateError(shadowedBuiltinMessage(name), 1, 0);
    }
  }
}
