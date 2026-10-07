import type { Child } from "hono/jsx";
import { ErrorBoundary, jsx, Suspense } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";

/** Hono's `JSX.Element` (its `JSX` namespace does not re-export it). */
type HonoJsxElement = HtmlEscapedString | Promise<HtmlEscapedString>;

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

/**
 * A plain node, or a `<@catch|error|>` thunk. The function member must stay
 * visible in the union so the generated `fallback={(error) => ...}` arrow gets
 * `error: Error` contextually — a `((error: Error) => unknown) | unknown`
 * union collapses to `unknown` and the arrow's parameter goes implicit-any.
 */
type Fallback = Child | ((error: Error) => Child);

interface MxErrorBoundaryProps {
  fallback: Fallback;
  /**
   * The `<try>` body: the emitter passes a thunk, plain children are accepted
   * for hand-written use.
   */
  children?: Child | (() => Child);
}

/**
 * Evaluates the `<try>` body thunk as a child of `ErrorBoundary`, so a throw
 * written directly in the body is caught like a descendant's, and none of the
 * partial body is emitted.
 */
function MxTryBody({ render }: { render: () => Child }): HonoJsxElement {
  // SAFETY: the thunk's return is plain `Child`, but this component must
  // satisfy Hono's `JSX.Element` (`HtmlEscapedString |
  // Promise<HtmlEscapedString>`) to stay usable as a JSX component; the
  // renderer accepts everything `Child` can hold.
  return render() as unknown as HonoJsxElement;
}

/**
 * `<try><@catch>`: Hono's own `ErrorBoundary` (which takes a `fallbackRender`
 * function) around the body thunk. `ErrorBoundary` is async, so render the
 * tree the way `c.html()` does, resolving callbacks.
 */
export function MxErrorBoundary({
  fallback,
  children,
}: MxErrorBoundaryProps): HonoJsxElement {
  const body =
    typeof children === "function"
      ? jsx(MxTryBody, { render: children })
      : children;
  // SAFETY: as above — `jsx` returns `JSXNode` statically while the runtime
  // value is what Hono's renderer treats as its `JSX.Element`.
  return jsx(
    ErrorBoundary,
    {
      fallbackRender: (error: Error) =>
        typeof fallback === "function" ? fallback(error) : (fallback as Child),
    },
    body as never,
  ) as unknown as HonoJsxElement;
}
