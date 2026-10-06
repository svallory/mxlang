declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}
