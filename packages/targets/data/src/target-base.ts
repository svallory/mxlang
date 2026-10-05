/**
 * The data target's descriptor without `load`: a leaf that imports
 * `declarations.ts` only. `parse.ts` builds its own lookup from this, so it
 * never imports `descriptor.ts`. `descriptor.ts` requires `compile.ts`, which
 * requires `parse.ts`; a `parse.ts` that imported the descriptor back would
 * close an entry-point cycle, which Bun's multi-entry build answers by
 * silently dropping `dist/parse.js` with exit 0 (the html target hit the same
 * with `dist/index.js`, see `targets/html/src/descriptor.ts`).
 */
import type { TargetDescriptor } from "@mxlang/core";
import { DEFAULT_TAG, dataDeclarations } from "./declarations.ts";

export const dataTargetBase: TargetDescriptor = {
  descriptorVersion: 0,
  name: "data",
  packageName: "@mxlang/data",
  defaultTag: DEFAULT_TAG,
  declarations: { default: dataDeclarations },
};
