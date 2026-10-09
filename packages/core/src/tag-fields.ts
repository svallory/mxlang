/**
 * Tag field reads for both ASTs `lower()` takes until PR 5 (PR 4 slice 3,
 * family 1). Marko keeps a tag's name as a Babel node and its variable,
 * arguments and params as bare Babel payloads (params on the `body`
 * wrapper); the MX AST names a tag with the `MxTagName` field shape and wraps
 * each payload in a container (`mx-ast.ts`, `MxTagFields`). Each accessor
 * answers what lowering read off the Marko tag, from either shape; the Marko
 * branches go when `lower()` takes only the MX AST.
 */
import type { Node } from "./core.ts";
import { payloadOf } from "./payload.ts";

/**
 * Default tags resolved for unnamed MX tags (`default-tag.ts`), kept beside
 * the tree: an MX pass never writes to the MX AST (decision 158, slice-4
 * addendum), where the Marko path rewrites its name node in place.
 */
const resolvedNames = new WeakMap<object, string>();

/** Records the default tag an unnamed MX tag resolved to. */
export function resolveUnnamedTag(node: Node, name: string): void {
  resolvedNames.set(node, name);
}

/** Is `node` an MX AST tag (`MxTag`, `MxReturn`, `MxAttributeTag`)? */
function isMxTagShape(node: Node): boolean {
  const type = node?.type;
  return type === "MxTag" || type === "MxReturn" || type === "MxAttributeTag";
}

/**
 * The tag's written name when it is static, as Marko spelled it: an
 * attribute tag keeps its `@` (`@item`). `undefined` for a dynamic name.
 */
export function tagNameOf(node: Node): string | undefined {
  if (node?.type === "MxAttributeTag") return `@${node.name.value}`;
  if (isMxTagShape(node)) {
    const resolved = resolvedNames.get(node);
    if (resolved !== undefined) return resolved;
    return node.name?.kind === "static" ? node.name.value : undefined;
  }
  return node?.name?.value;
}

/** Is the tag's name static (Marko: a `StringLiteral` name node)? */
export function hasStaticName(node: Node): boolean {
  if (node?.type === "MxAttributeTag") return true;
  if (isMxTagShape(node)) {
    return node.name?.kind === "static" || resolvedNames.has(node);
  }
  return node?.name?.type === "StringLiteral";
}

/**
 * What a tag name's position reads from: Marko's name node; the MX name
 * field shape (its `span`), or for a dynamic name its expression container,
 * since Marko's dynamic name node is the expression itself, not `${…}`.
 */
export function tagNameSpanOf(node: Node): Node {
  if (isMxTagShape(node) && node.name?.kind === "dynamic") {
    return node.name.expression;
  }
  return node?.name;
}

/** A dynamic tag name's expression, the Babel node `exprOf` reads. */
export function tagNameExprOf(node: Node): Node {
  if (isMxTagShape(node) && node.name?.kind === "dynamic") {
    return payloadOf(node.name.expression);
  }
  return node?.name;
}

/** The tag's arguments `(a, b)`; `undefined` when none were written. */
export function tagArgsOf(node: Node): Node[] | undefined {
  if (!isMxTagShape(node)) return node?.arguments;
  return node.args ? payloadOf(node.args) : undefined;
}

/** The tag variable's pattern `/x`; Marko's own value when none was written. */
export function tagVarOf(node: Node): Node {
  if (!isMxTagShape(node)) return node?.var;
  return node.var ? payloadOf(node.var) : null;
}

/** The tag's params `|a, b|`, empty when none were written. */
export function tagParamsOf(node: Node): Node[] {
  if (!isMxTagShape(node)) return node?.body?.params ?? [];
  return node.params ? payloadOf(node.params) : [];
}

/** Does the tag carry type arguments `<T>` or type parameters? */
export function hasTypeArguments(node: Node): boolean {
  if (!isMxTagShape(node)) {
    return Boolean(node?.typeArguments || node?.body?.typeParameters);
  }
  return Boolean(node.typeArgs || node.typeParams);
}

/**
 * The tag's attribute list as Marko had it. The MX AST keeps comments in the
 * same list (`MxTagFields.attributes`); Marko dropped them, so they go here.
 */
export function tagAttributesOf(node: Node): Node[] {
  const attributes: Node[] = node?.attributes ?? [];
  if (!isMxTagShape(node)) return attributes;
  return (
    sugarAttributes.get(node) ??
    attributes.filter((attr) => attr?.type !== "MxComment")
  );
}

/**
 * An MX tag's attributes after the name-sugar rewrite (`rewriteMxSugar`):
 * kept beside the tree, which stays as parsed.
 */
const sugarAttributes = new WeakMap<Node, Node[]>();

export function recordSugarAttributes(node: Node, attributes: Node[]): void {
  sugarAttributes.set(node, attributes);
}
