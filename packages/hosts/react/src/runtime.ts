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
  children?: ReactNode;
}

interface MxErrorBoundaryState {
  error: unknown;
  caught: boolean;
}

/** React class boundary used by `<try><@catch>`. */
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
    if (!this.state.caught) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function"
      ? fallback(this.state.error)
      : fallback;
  }
}

export interface MxPlaceholderProps {
  fallback: ReactNode;
  children?: ReactNode;
}

/** React's native Suspense under the dialect-independent emitter name. */
export function MxPlaceholder(props: MxPlaceholderProps): ReactNode {
  return createElement(Suspense, { fallback: props.fallback }, props.children);
}
