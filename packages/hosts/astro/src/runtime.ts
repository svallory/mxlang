/**
 * The run-time surface an Astro project can import: the sink a fence passes to
 * a unit's `render(input, out)` (decision 155).
 *
 * A subpath, not the main entry: the main entry is the integration, build-time
 * code (the Vite plugin and the compiler) that cannot load inside the SSR
 * bundle a page is rendered from.
 */
export type { Out } from "@mxlang/target-html/runtime";
export { createOut } from "@mxlang/target-html/runtime";
