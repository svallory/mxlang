/**
 * The one runtime this host ships: `<try>`'s error boundary and placeholder.
 *
 * Decision 82 says MX itself ships no runtime, and this does not contradict
 * it: nothing here is an MX runtime, it is *Preact* code an MX author would
 * otherwise have to write by hand, shipped so the `<try>` lowering has a
 * component to name. A template that never writes `<try>` imports none of it,
 * because the emitter only emits the import when it emits the lowering.
 *
 * ## Why a class component
 *
 * Preact has no built-in error boundary component. It does have the hook —
 * `componentDidCatch` on a class component is Preact's own supported way to
 * catch a render error in a subtree, the same contract React documents — but
 * no component wrapping it. `preact/compat`'s `Suspense` catches thrown
 * *promises* (that is what makes `lazy()` work) and not thrown errors, so it
 * covers `<@placeholder>` and not `<@catch>`. So this file ships both:
 *
 * - `MxErrorBoundary` — `componentDidCatch`, for `<@catch>`. A class, because
 *   that is the only form Preact gives the hook; there is no hook-based
 *   equivalent in Preact 10.
 * - `MxPlaceholder` — a thin alias of `preact/compat`'s `Suspense`, for
 *   `<@placeholder>`. Aliased rather than re-implemented so a body that
 *   suspends (a `lazy()` child, a thrown promise) behaves exactly as Preact
 *   documents, and so the emitter names one thing whichever target it is on.
 *
 * Both are ordinary Preact components with no MX-specific protocol, so a
 * consumer can use them directly or replace them with their own.
 */

import {
  Component,
  type ComponentChildren,
  createElement,
  options,
  type VNode,
} from "preact";
import { Suspense } from "preact/compat";

/**
 * Marko's structured `class` value, joined into the string Preact's `class`
 * prop takes.
 *
 * Marko accepts `class={a: true, b: false}` and `class=["x", {y: cond}]` and
 * renders the enabled names; Preact's `class` takes a string (or an object
 * only via third-party helpers, which this host does not require). Handing the
 * raw object through would render `[object Object]` — a silently wrong
 * attribute rather than a visible failure — so the emitter routes a structured
 * value through here.
 *
 * The rules are Marko's own: a string contributes itself, an array flattens
 * recursively, an object contributes each key whose value is truthy, and
 * `null`/`undefined`/`false` contribute nothing.
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

export interface MxErrorBoundaryProps {
  /**
   * Rendered instead of the children when the subtree throws.
   *
   * A function so `<@catch|error|>` can name the error — MX's own attribute
   * tag declares the param, and this is what receives it. A plain node is
   * accepted too, for `<@catch>` with no params.
   */
  fallback: ComponentChildren | ((error: unknown) => ComponentChildren);
  /**
   * The `<try>` body. The emitter passes a thunk, so a throw written directly
   * in the body is evaluated inside {@link MxTryBody} (under the boundary)
   * instead of in the parent's render, where nothing could catch it. Plain
   * children are still accepted for hand-written use.
   */
  children?: ComponentChildren | (() => ComponentChildren);
}

interface MxErrorBoundaryState {
  error: unknown;
  caught: boolean;
}

/**
 * Renders `fallback` when its subtree throws during render.
 *
 * `caught` is tracked separately from `error` because a subtree may throw a
 * falsy value (`throw undefined` is legal JavaScript, and a rejected promise
 * can carry one); keying off `error` alone would re-render the failed subtree
 * forever in that case.
 */
export class MxErrorBoundary extends Component<
  MxErrorBoundaryProps,
  MxErrorBoundaryState
> {
  state: MxErrorBoundaryState = { error: undefined, caught: false };

  constructor(props: MxErrorBoundaryProps) {
    super(props);
    // `preact-render-to-string` runs `getDerivedStateFromError` and
    // `componentDidCatch` only when this flag is truthy. It is a process-wide
    // setting of the consumer's `preact`: once a `<try>` with `<@catch>`
    // renders, every class component's error boundary works during SSR too.
    // Setting it again is harmless.
    (options as { errorBoundaries?: boolean }).errorBoundaries = true;
  }

  static getDerivedStateFromError(error: unknown): MxErrorBoundaryState {
    // `preact-render-to-string` hands a thrown promise (a suspension) to the
    // nearest class boundary too once `options.errorBoundaries` is set;
    // rethrow it so it reaches a `Suspense` instead of rendering `<@catch>`.
    if (isThenable(error)) throw error;
    return { error, caught: true };
  }

  componentDidCatch(error: unknown): void {
    this.setState({ error, caught: true });
  }

  render(): ComponentChildren {
    const { fallback, children } = this.props;
    if (this.state.caught) return callFallback(fallback, this.state.error);
    return typeof children === "function"
      ? createElement(MxTryBody, {
          render: children as () => ComponentChildren,
          fallback,
        })
      : children;
  }
}

function callFallback(
  fallback: MxErrorBoundaryProps["fallback"],
  error: unknown,
): ComponentChildren {
  return typeof fallback === "function"
    ? (fallback as (error: unknown) => ComponentChildren)(error)
    : fallback;
}

interface MxTryBodyProps {
  render: () => ComponentChildren;
  fallback: MxErrorBoundaryProps["fallback"];
}

/**
 * Evaluates the `<try>` body thunk inside its own component, so a throw
 * written directly in the body is caught here with the real error and none of
 * the partial body, as Marko discards the body's output and renders `<@catch>`.
 * A function component, so hooks written inline in the body stay legal.
 */
function MxTryBody({ render, fallback }: MxTryBodyProps): ComponentChildren {
  try {
    return render();
  } catch (error) {
    // A suspension is not an error: a thrown promise must reach the nearest
    // `Suspense` (`<@placeholder>`'s, or an outer one), not `<@catch>`.
    if (isThenable(error)) throw error;
    return callFallback(fallback, error);
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface MxPlaceholderProps {
  /** Rendered while the subtree is suspended. */
  fallback: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Renders `fallback` while its subtree is suspended.
 *
 * `preact/compat`'s `Suspense` under this package's own name, so the emitted
 * lowering imports one module and the same JSX text works on a React target
 * that maps the name to `react`'s `Suspense`.
 */
export function MxPlaceholder(props: MxPlaceholderProps): VNode {
  // `createElement` rather than JSX: this file is `.ts`, so that the package
  // needs no JSX build configuration of its own to ship two components.
  return createElement(
    Suspense,
    { fallback: props.fallback },
    props.children,
  ) as VNode;
}
