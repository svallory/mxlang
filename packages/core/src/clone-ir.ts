/**
 * A private, mutable copy of IR, for an emitter that rewrites what it emits.
 *
 * The IR is read-only to an emitter (ir-spec section 10.2, E21): one lowered
 * `Ir` may be emitted more than once, and a rewrite made in place would be
 * applied again on the next emit. An emitter that needs to rewrite `Expr.code`,
 * `For.bindings` or a parser node takes a copy with this function and rewrites
 * the copy.
 *
 * In IR, only plain objects and arrays are copied. Anything else (a class
 * instance, a `Map`, a function) is shared by reference. Sharing inside the
 * original is kept: two fields that pointed at one object point at one copied
 * object, so `rewriteCodes`' "visit each shared object once" holds on the copy
 * too.
 *
 * Parser nodes (`Expr.node`, `For.paramNodes`) are kept by reference unless
 * `nodes` is set, since most rewrites touch only `code`; a caller that edits
 * the parser node itself passes `{ nodes: true }`. Inside a parser node the
 * rule is different: a real `@babel/parser` node is a class instance (`Node`,
 * with `SourceLocation`/`Position` in `loc`), so every object there is copied
 * into `Object.create(prototype)` with its own enumerable properties, whatever
 * its prototype. Only built-in containers and values with internal slots
 * (`Map`, `Set`, `Date`, `RegExp`, typed arrays) and functions stay shared,
 * because a property copy of those is not a working copy.
 */
export function cloneIr<T>(value: T, options: { nodes?: boolean } = {}): T {
  type Mode = "ir" | "node" | "shared";
  const copies = new Map<object, unknown>();
  const copy = (input: unknown, mode: Mode): unknown => {
    if (!input || typeof input !== "object") return input;
    if (mode === "shared") return input;
    const seen = copies.get(input);
    if (seen !== undefined) return seen;
    if (Array.isArray(input)) {
      const out: unknown[] = [];
      copies.set(input, out);
      for (const item of input) out.push(copy(item, mode));
      return out;
    }
    const prototype = Object.getPrototypeOf(input);
    const plain = prototype === Object.prototype || prototype === null;
    if (!plain && (mode !== "node" || hasInternalSlots(input))) return input;
    const out: Record<string, unknown> = Object.create(prototype);
    copies.set(input, out);
    for (const [key, child] of Object.entries(input)) {
      const isParserNode =
        mode === "ir" && (key === "node" || key === "paramNodes");
      out[key] = copy(
        child,
        isParserNode ? (options.nodes === true ? "node" : "shared") : mode,
      );
    }
    return out;
  };
  return copy(value, "ir") as T;
}

function hasInternalSlots(value: object): boolean {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value)
  );
}
