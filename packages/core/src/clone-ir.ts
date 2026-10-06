/**
 * A private, mutable copy of IR, for an emitter that rewrites what it emits.
 *
 * The IR is read-only to an emitter (ir-spec section 10.2, E21): one lowered
 * `Ir` may be emitted more than once, and a rewrite made in place would be
 * applied again on the next emit. An emitter that needs to rewrite `Expr.code`,
 * `For.bindings` or a parser node takes a copy with this function and rewrites
 * the copy.
 *
 * Only plain objects and arrays are copied. Anything else (a class instance, a
 * `Map`, a function) is shared by reference. Sharing inside the original is
 * kept: two fields that pointed at one object point at one copied object, so
 * `rewriteCodes`' "visit each shared object once" holds on the copy too.
 *
 * Parser nodes (`Expr.node`, `For.paramNodes`) are kept by reference unless
 * `nodes` is set, since most rewrites touch only `code`; a caller that edits
 * the parser node itself passes `{ nodes: true }`.
 */
export function cloneIr<T>(value: T, options: { nodes?: boolean } = {}): T {
  const copies = new Map<object, unknown>();
  const copy = (input: unknown, shared: boolean): unknown => {
    if (!input || typeof input !== "object") return input;
    if (shared) return input;
    const seen = copies.get(input);
    if (seen !== undefined) return seen;
    if (Array.isArray(input)) {
      const out: unknown[] = [];
      copies.set(input, out);
      for (const item of input) out.push(copy(item, false));
      return out;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return input;
    const out: Record<string, unknown> = {};
    copies.set(input, out);
    for (const [key, child] of Object.entries(input)) {
      const isParserNode = key === "node" || key === "paramNodes";
      out[key] = copy(child, isParserNode && options.nodes !== true);
    }
    return out;
  };
  return copy(value, false) as T;
}
