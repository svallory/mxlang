/**
 * `@mxlang/targets/html`: the html target's full entry (`@mxlang/target-html`),
 * re-exported so the umbrella alone gives a consumer the target (decision
 * 201). Kept off the main entry: that one must stay light (see
 * `light-import.test.ts`).
 */
export * from "@mxlang/target-html";
