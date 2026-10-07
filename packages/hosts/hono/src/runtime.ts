import { ErrorBoundary, jsx, Suspense } from "hono/jsx";

export { Suspense };

/**
 * Joins Marko's recursive structured `class` value for Hono's string prop.
 *
 * Identical logic to `@mxlang/preact/runtime`'s and `@mxlang/react/runtime`'s
 * `mxClass` — kept as its own copy rather than a shared import so this
 * package has no runtime dependency beyond `hono` itself.
 */
export function mxClass(value: unknown): string {
  const parts: string[] = [];
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || item === false) return;
    if (typeof item === "string") {
      if (item !== "") parts.push(item);
      return;
    }
    if (typeof item === "number") {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
      return;
    }
    if (typeof item === "object") {
      for (const [key, enabled] of Object.entries(item)) {
        if (enabled) parts.push(key);
      }
    }
  };
  walk(value);
  return parts.join(" ");
}

type Fallback = ((error: Error) => unknown) | unknown;

interface MxErrorBoundaryProps {
  fallback: Fallback;
  /** The `<try>` body: the emitter passes a thunk. */
  children?: unknown;
}

/**
 * Evaluates the `<try>` body thunk as a child of `ErrorBoundary`, so a throw
 * written directly in the body is caught like a descendant's, and none of the
 * partial body is emitted.
 */
function MxTryBody({ render }: { render: () => unknown }): unknown {
  return render();
}

/**
 * `<try><@catch>`: Hono's own `ErrorBoundary` (which takes a `fallbackRender`
 * function) around the body thunk. `ErrorBoundary` is async, so render the
 * tree the way `c.html()` does, resolving callbacks.
 */
export function MxErrorBoundary({
  fallback,
  children,
}: MxErrorBoundaryProps): unknown {
  const body =
    typeof children === "function"
      ? jsx(MxTryBody as never, { render: children as () => unknown })
      : children;
  return jsx(
    ErrorBoundary as never,
    {
      fallbackRender: (error: Error) =>
        typeof fallback === "function"
          ? (fallback as (error: Error) => unknown)(error)
          : fallback,
    },
    body as never,
  );
}
