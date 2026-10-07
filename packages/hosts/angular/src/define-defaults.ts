/**
 * Rewritten default expressions of a `<define>`'s destructured first param.
 *
 * `Define.params` is source text, so a default inside `|{ n = input.n }|` is
 * not an `Expr` the tag-module `input` rewrite can reach. That pass parses the
 * pattern, rewrites each default, and records the result here, keyed by the
 * `Define` node and then by the binding name; the emitter reads it when it
 * writes the `@let` for that binding. A binding with no entry keeps its
 * authored default.
 */
export const defineDefaultRewrites = new WeakMap<object, Map<string, string>>();
