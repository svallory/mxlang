import { Component, createElement, type ReactNode, Suspense } from "react";

/** Joins Marko's recursive structured `class` value for React's string prop. */
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

export interface MxErrorBoundaryProps {
  fallback: ReactNode | ((error: unknown) => ReactNode);
  /**
   * The `<try>` body. The emitter passes a thunk, so a throw written directly
   * in the body is evaluated inside {@link MxTryBody} (under the boundary)
   * instead of in the parent's render, where nothing could catch it.
   */
  children?: ReactNode | (() => ReactNode);
}

interface MxErrorBoundaryState {
  error: unknown;
  caught: boolean;
}

/**
 * React class boundary used by `<try><@catch>`.
 *
 * React's server renderer never runs error boundaries: a throw below the
 * boundary is sent to the nearest `Suspense`, and the client re-renders that
 * subtree, where this class catches it. So the body sits inside an internal
 * `Suspense` whose fallback is `<@catch>` ({@link MxServerCatch}), which makes
 * a descendant's throw render `<@catch>` in the server HTML. See the
 * divergence rows R1-R3 in `divergences.md`.
 */
export class MxErrorBoundary extends Component<
  MxErrorBoundaryProps,
  MxErrorBoundaryState
> {
  state: MxErrorBoundaryState = { error: undefined, caught: false };

  static getDerivedStateFromError(error: unknown): MxErrorBoundaryState {
    return { error, caught: true };
  }

  componentDidCatch(error: unknown): void {
    this.setState({ error, caught: true });
  }

  render(): ReactNode {
    const { fallback, children } = this.props;
    if (this.state.caught) return callFallback(fallback, this.state.error);
    const body =
      typeof children === "function"
        ? createElement(MxTryBody, { render: children, fallback })
        : children;
    return createElement(
      Suspense,
      { fallback: createElement(MxServerCatch, { fallback }) },
      body,
    );
  }
}

function callFallback(
  fallback: MxErrorBoundaryProps["fallback"],
  error: unknown,
): ReactNode {
  return typeof fallback === "function" ? fallback(error) : fallback;
}

interface MxTryBodyProps {
  render: () => ReactNode;
  fallback: MxErrorBoundaryProps["fallback"];
}

/**
 * Evaluates the `<try>` body thunk inside its own component, so a throw
 * written directly in the body is caught here with the real error and none of
 * the partial body. A function component, so hooks written inline in the body
 * stay legal.
 */
function MxTryBody({ render, fallback }: MxTryBodyProps): ReactNode {
  try {
    return render();
  } catch (error) {
    // A suspension is not an error: it must reach the nearest `Suspense`
    // (`<@placeholder>`'s, the internal one, or an outer one), not `<@catch>`.
    if (isSuspension(error)) throw error;
    return callFallback(fallback, error);
  }
}

/**
 * A thrown thenable (the classic Suspense protocol), or React's
 * `SuspenseException`, which `use(promise)` throws. React does not export that
 * class, so match its message. Development builds: `"Suspense Exception: This
 * is not a real error! …"` (`react-dom@19.3.0`,
 * `cjs/react-dom-server.node.development.js`). Production builds minify it:
 * `SuspenseException` is `formatProdErrorMessage(460)` and
 * `SuspenseActionException` is `(542)`, i.e. `"Minified React error #460; …"`
 * (`react-dom@19.3.0`, `cjs/react-dom-client.production.js`).
 */
const SUSPENSE_EXCEPTION_MESSAGE =
  // React error #474 (SuspenseyCommitException) is thrown in the commit phase,
  // never inside a render that MxTryBody wraps, so it is not matched on purpose.
  /^(Suspense Exception:|Minified React error #(460|542);)/;

function isSuspension(value: unknown): boolean {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    return true;
  }
  return (
    value instanceof Error && SUSPENSE_EXCEPTION_MESSAGE.test(value.message)
  );
}

/**
 * `<@catch>` for a server render whose body threw below the boundary. React
 * does not expose that error to the tree, so `<@catch|e|>` receives a
 * stand-in; the client render passes the real one.
 */
function MxServerCatch({
  fallback,
}: {
  fallback: MxErrorBoundaryProps["fallback"];
}): ReactNode {
  return callFallback(
    fallback,
    new Error(
      "an error was thrown during a React server render below this <try>; the error itself is only available after the client renders",
    ),
  );
}

export interface MxPlaceholderProps {
  fallback: ReactNode;
  children?: ReactNode;
}

/** React's native Suspense under the dialect-independent emitter name. */
export function MxPlaceholder(props: MxPlaceholderProps): ReactNode {
  return createElement(Suspense, { fallback: props.fallback }, props.children);
}
