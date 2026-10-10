// The opaque handle behind a host hook view (`host-view.ts`), in a module of
// its own: `core.ts` and `wildcard-resolve.ts` resolve handles, and importing
// `host-view.ts` from them would close a cycle through `lower.ts` that reaches
// `scan.ts` before `contract-fields.ts` has initialised. Imports types only.
import type { Node } from "./core.ts";

declare const handleBrand: unique symbol;

/**
 * The node behind a view, opaque: no fields, not serialisable, valid only
 * during the hook call. Core's helpers that take a view or a handle
 * (`rejectUnsupportedFields`, `bindingSpan`, `contractDefaultTag`) resolve
 * it; a host cannot read through it.
 *
 * @unstable the host hook view; its shape may change before the hooks receive it.
 */
export interface MxNodeHandle {
  readonly [handleBrand]: true;
}

const handles = new WeakMap<object, Node>();

/** The handle for `node`: a fresh frozen token, mapped back by `handleNode`. */
export function handleFor(node: Node): MxNodeHandle {
  const handle = Object.freeze(Object.create(null)) as MxNodeHandle;
  handles.set(handle, node);
  return handle;
}

/**
 * The node behind a handle, a view or an attribute entry; `undefined` for
 * anything else. Core only: not exported from the package.
 */
export function handleNode(value: unknown): Node | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const direct = handles.get(value);
  if (direct !== undefined) return direct;
  const handle = (value as { handle?: unknown }).handle;
  return handle && typeof handle === "object" ? handles.get(handle) : undefined;
}
