/**
 * Attribute field reads for both ASTs `lower()` takes until PR 5 (PR 4 slice
 * 4, family 2). Marko keeps an attribute's value as the bare Babel node (a
 * synthesized `true` for a valueless one), its method shorthand as a
 * `FunctionExpression` value, and the default value as `name: "value"` with
 * `default: true`; the MX AST wraps the value in a container
 * (`MxExpression`, or `MxMethod` for `name(params) { body }`), names the
 * default value `null`, and spells `:=` as `operator` (`mx-ast.ts`,
 * `MxAttribute`). Each accessor answers what lowering read off the Marko
 * attribute, from either shape; the Marko branches go when `lower()` takes
 * only the MX AST.
 */
import { type Ctx, type Node, positionAtOffset } from "./core.ts";
import { payloadOf } from "./payload.ts";

/** Is `attr` an MX AST attribute (`MxAttribute`, `MxSpreadAttribute`)? */
function isMxAttr(attr: Node): boolean {
  return attr?.type === "MxAttribute" || attr?.type === "MxSpreadAttribute";
}

/** Is `attr` the tag's default value (`<x=1>`, `<x(a) {}>`, `<let:=y>`)? */
export function isDefaultAttr(attr: Node): boolean {
  if (attr?.type === "MxAttribute") return attr.name === null;
  return attr?.default === true;
}

/** The attribute's name as Marko spelled it: the default value is `value`. */
export function attrNameOf(attr: Node): string {
  if (attr?.type === "MxAttribute") return attr.name ?? "value";
  return attr?.name;
}

/** Is `attr` bound (`a:=b`)? */
export function isBoundAttr(attr: Node): boolean {
  if (attr?.type === "MxAttribute") return attr.operator === ":=";
  return attr?.bound === true;
}

/**
 * The attribute's arguments (`c(x)`), the Babel nodes; `undefined` without
 * any. Not a method's params: `c(x) { … }` is a method value on both ASTs.
 */
export function attrArgsOf(attr: Node): Node[] | undefined {
  if (attr?.type === "MxAttribute") {
    return attr.args ? payloadOf(attr.args) : undefined;
  }
  return attr?.arguments;
}

/** Is the value a method shorthand (`c(x) { … }`)? */
export function isMethodAttr(attr: Node): boolean {
  if (attr?.type === "MxAttribute") return attr.value?.type === "MxMethod";
  return attr?.value?.type === "FunctionExpression";
}

/**
 * What a host hook (`resolveAttributeMethod`, `rejectAttributeMethod`,
 * `resolveModifier`, `rejectModifier`) receives: the attribute itself, except
 * an MX default value, which hooks read as `value` as Marko named it.
 */
export function hookAttr(attr: Node): Node {
  if (attr?.type === "MxAttribute" && attr.name === null) {
    return { ...attr, name: "value" };
  }
  return attr;
}

/**
 * The attribute's value as Marko held it, a Babel node:
 *
 * - a valueless attribute is Marko's synthesized `true` (no position);
 * - an `MxExpression` is its payload (`payloadOf`: the decision-182 trigger
 *   seam, the parse-error guard);
 * - an `MxMethod` is the `FunctionExpression` Marko built for it
 *   (`methodFunctionOf`).
 *
 * A spread's value is its expression on both ASTs.
 */
export function attrValueOf(ctx: Ctx, attr: Node): Node {
  if (!isMxAttr(attr)) return attr?.value;
  const value = attr.value;
  if (value == null) return { type: "BooleanLiteral", value: true };
  if (value.type === "MxMethod") return methodFunctionOf(ctx, value);
  return payloadOf(value);
}

/**
 * The `FunctionExpression` Marko's parser builds for a method attribute
 * (`@marko/compiler`'s `parseParams`/`parseExpression` over the method's
 * parts), rebuilt from the `MxMethod` so `Expr.node` stays the Babel payload
 * (decision 166 addendum 3). Measured against Marko 5.42.10:
 *
 * - its `loc` runs from the method's start (`async` when written, else the
 *   `(`) to after the closing `}`, line and column only;
 * - the body block's `loc` is the inside of the braces, which is the
 *   `MxStatements` container's own span; a comment-only body keeps its
 *   comments as the block's `innerComments`;
 * - `typeParameters` is `null` when type parameters are written and absent
 *   otherwise: Marko does not keep them, and `expr()` prints the authored
 *   source slice, which does.
 */
export function methodFunctionOf(ctx: Ctx, method: Node): Node {
  const statements = payloadOf(method.body);
  const params = payloadOf(method.params);
  const locOf = (start: number, end: number) => ({
    start: positionAtOffset(ctx, start),
    end: positionAtOffset(ctx, end),
  });
  const innerComments: Node[] = method.body.innerComments ?? [];
  return {
    type: "FunctionExpression",
    params,
    generator: false,
    async: method.async,
    ...(method.typeParams ? { typeParameters: null } : {}),
    id: null,
    body: {
      type: "BlockStatement",
      directives: method.body.directives ?? [],
      body: statements,
      loc: locOf(method.body.start, method.body.end),
      ...(innerComments.length > 0 ? { innerComments } : {}),
    },
    loc: locOf(method.start, method.end),
  };
}

/**
 * Is the value an authored expression (`of=xs`), not a valueless attribute,
 * arguments or a method? Marko tells them apart by the value's `loc`: its
 * synthesized `true` has none.
 */
export function hasExpressionValue(attr: Node): boolean {
  if (attr?.type === "MxAttribute") {
    return attr.value?.type === "MxExpression" && !attr.args;
  }
  return (
    Boolean(attr?.value?.loc) &&
    !attr.arguments &&
    attr.value.type !== "FunctionExpression"
  );
}
