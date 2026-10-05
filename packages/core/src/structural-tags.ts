/**
 * The control-flow tags core lowers itself (`<if>` with its `<else-if>` and
 * `<else>` branches, and `<for>`). One source for the lowerer's own checks and
 * for the contract-parent lookup, which must see through them on every target
 * whatever its Marko lookup knows.
 */
export const CONTROL_FLOW_TAGS: readonly string[] = [
  "if",
  "else-if",
  "else",
  "for",
];
