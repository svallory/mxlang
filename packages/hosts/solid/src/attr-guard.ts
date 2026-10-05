import { ATTRIBUTE_VALUE_EXPRESSION } from "@mxlang/core";

/** Module-scope bindings the emitted native-attribute guard calls. */
export const MX_ATTR_VALUE_BINDING = "__mxAttrValue";
export const MX_ATTR_SPREAD_BINDING = "__mxAttrSpread";

/**
 * Hoisted as function declarations (not `const`) so the parser bridge's
 * collision rename, which flips a hoisted declaration's `id.name`, applies.
 * Core's validation expression is reused verbatim, so the message and rules
 * match every other host.
 */
export const ATTR_VALUE_HELPER = `function ${MX_ATTR_VALUE_BINDING}<T,>(name: string, value: T, tag = ""): T { return ${ATTRIBUTE_VALUE_EXPRESSION}(name, value, tag); }`;

/**
 * Solid merges spreads lazily, so the helper must not snapshot the object: a
 * Proxy validates each key as Solid reads it, which keeps reactivity and means
 * a key a later source overwrites is never read, so never validated. Solid's
 * own prop namespaces (events, `use:`, `prop:`, `attr:`, `bool:`) and the
 * props with structured semantics are exempt.
 */
export const ATTR_SPREAD_HELPER = String.raw`function ${MX_ATTR_SPREAD_BINDING}<T extends object | null | undefined,>(attrs: T, tag = ""): T {
  if (attrs === null || typeof attrs !== "object") return attrs;
  return new Proxy(attrs, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof key === "string" && !/^(?:ref|children|class|style|classList|innerHTML|textContent|\$mxReturn|on[:A-Z]|oncapture:|use:|prop:|attr:|bool:)/.test(key)) ${MX_ATTR_VALUE_BINDING}(key, value, tag);
      return value;
    },
  });
}`;
