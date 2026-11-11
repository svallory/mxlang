/**
 * A cache entry's weak record of one object it was derived under, and the
 * comparison that decides whether a later compile may reuse the entry.
 *
 * "No object" (`null`) is recorded apart from "an object that has since been
 * collected" (a ref whose `deref()` is `undefined`): the second never matches,
 * so a collected scope can neither equal a compile that has none nor any other.
 * Internal.
 */
export type ScopeRef = WeakRef<object> | null;

export function scopeRefOf(object: object | undefined): ScopeRef {
  return object === undefined ? null : new WeakRef(object);
}

export function sameScopeRef(
  stored: ScopeRef,
  current: object | undefined,
): boolean {
  if (stored === null) return current === undefined;
  const target = stored.deref();
  return target !== undefined && target === current;
}
