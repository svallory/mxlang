/**
 * Objects already proven deep-frozen. A deep-frozen object cannot change, so
 * a positive answer is final and is asked once per object.
 */
const deepFrozen = new WeakSet<object>();

/** Whether `value` is a plain object or an array: the shapes core walks and validates. */
function isWalked(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether `value` is frozen all the way down, over what core validates: the
 * plain objects and arrays in it. RegExps, functions, Maps, Sets and class
 * instances are opaque: they are not walked and need not be frozen (a `g` or
 * `y` RegExp cannot be frozen safely). The top `value` itself must be frozen.
 * An accessor property counts as not frozen (its result can change).
 *
 * This is the gate of every cache keyed on a table or dialect object:
 * `Object.isFrozen` alone is shallow, and a nested object left unfrozen could
 * change after the cache was filled. The answer is remembered per object, so
 * a deep-frozen dialect is walked once.
 */
export function isDeepFrozen(value: object): boolean {
  if (deepFrozen.has(value)) return true;
  const seen = new Set<object>();
  const walk = (node: object): boolean => {
    if (deepFrozen.has(node) || seen.has(node)) return true;
    if (!isWalked(node)) return true;
    if (!Object.isFrozen(node)) return false;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !("value" in descriptor)) return false;
      const field: unknown = descriptor.value;
      if (field && typeof field === "object" && !walk(field)) return false;
    }
    return true;
  };
  if (!Object.isFrozen(value) || !walk(value)) return false;
  for (const node of seen) deepFrozen.add(node);
  return true;
}
