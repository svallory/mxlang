declare namespace JSX {
  // Anything, as `unknown` would be, except that TypeScript rejects a
  // component whose return type is `unknown` (TS2786 on every `<Field>`).
  type Element = NonNullable<unknown> | null | undefined;
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}
