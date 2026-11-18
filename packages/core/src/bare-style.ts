/**
 * The bare `<style>` attribute refusal's text, shared by the authored check
 * (`rejectBareStyleAttributes` in `lower.ts`) and the custom-tag builder's
 * `ctx.build.delegatedTag("style", …, attrs)` (`custom-tags.ts`), so a built
 * `<style>` is refused in the same words as an authored one.
 */

import type { Ctx } from "./core.ts";
import { voiceOfCtx } from "./message-vocabulary.ts";

/**
 * Stock Marko 6.4.4's message (`assertNoStyleAttributes`). A host's
 * `bareStyleAttributesHint` replaces stock's second sentence (the route to
 * `<html-style>`); stock's first sentence is kept.
 */
export function bareStyleAttributesMessage(ctx: Ctx): string {
  const hint =
    ctx.declarations.bareStyleAttributesHint ??
    "For a native html [`<style>` tag](https://markojs.com/docs/reference/core-tag#style) use the `html-style` core tag instead.";
  return `The \`style\` does not support html ${voiceOfCtx(ctx).attributes}. ${hint}`;
}
