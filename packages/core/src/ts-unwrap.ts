/**
 * The expression under any TypeScript wrappers (`x as T`, `x satisfies T`,
 * `x!`, `<T>x`), however deeply nested. The default lowering erases them
 * before core's checks read a value; with `stripTypes: false` they stay, and
 * a check that reads a value's node type looks through them so the result
 * does not depend on the option. Internal: not exported from the package.
 */
export function withoutTsWrappers<
  N extends { type?: string } | null | undefined,
>(node: N): N {
  let current = node as
    | { type?: string; expression?: unknown }
    | null
    | undefined;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion") &&
    current.expression
  ) {
    current = current.expression as typeof current;
  }
  return current as N;
}
