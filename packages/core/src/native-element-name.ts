/**
 * Which tag names core reads as native elements and which as Marko's core
 * taglib tags: shared by the lowerer and the pre-pass that reads a literal
 * dynamic tag name (`<${"div"}>`) as its element (`default-tag.ts`).
 */

import type { Ctx } from "./core.ts";
import { CORE_TAG_NAMES, CORE_TAGLIB_ID } from "./core-taglib.ts";
import { coreNativeTags, ELEMENT_TAGLIB_IDS } from "./tag-table.ts";

/**
 * Whether `name` is one of Marko's core taglib tags (`<debug>`, `<log>`, ...):
 * by the tag table's id when it registered the full core taglib (only the
 * html target's table does), else by the core taglib's own name set - so
 * every target judges the same set. Stock Marko lets a core tag win over a
 * same-named lowercase import, so the local-variable rule must not fire for
 * one.
 */
export function isCoreTaglibTag(ctx: Ctx, name: string): boolean {
  if (ctx.tagTable?.getTag(name)?.taglibId === CORE_TAGLIB_ID) return true;
  return CORE_TAG_NAMES.has(name);
}

// HTML elements no native table lists (`@mxlang/web-elements` follows
// Marko's element taglibs, which have no `<slot>`), native in a region and a
// whole file alike.
const UNLISTED_NATIVE_ELEMENTS: ReadonlySet<string> = new Set(["slot"]);

/**
 * Whether `name` is a native HTML/SVG/MathML element: by the tag table's
 * taglib id when it knows the name, else by the elements the table was built
 * over (a region has no table): the host's `nativeTags`, or core's own when
 * it declares none.
 */
export function isNativeElementName(ctx: Ctx, name: string): boolean {
  const taglibId = ctx.tagTable?.getTag(name)?.taglibId;
  if (taglibId !== undefined) return ELEMENT_TAGLIB_IDS.has(taglibId);
  return (
    (ctx.declarations.nativeTags ?? coreNativeTags()).has(name) ||
    UNLISTED_NATIVE_ELEMENTS.has(name)
  );
}
