/**
 * How a `<define>` param is typed in the arrow the JSX hosts emit, decided
 * from its parser node (`Define.paramNodes`), not by scanning its text.
 *
 * Internal: not in `package.json` `exports`.
 */

/**
 * The parts of a Babel param node this module reads. The host does not import
 * Babel; core hands the nodes over as they are.
 */
export interface ParamNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: {
    start?: { index?: number } | null;
    end?: { index?: number } | null;
  } | null;
  typeAnnotation?: unknown;
  left?: ParamNode;
  right?: ParamNode;
  operator?: string;
  argument?: ParamNode;
}

const LITERALS = new Set([
  "StringLiteral",
  "NumericLiteral",
  "BigIntLiteral",
  "BooleanLiteral",
]);

/**
 * Whether the author wrote a type on `node`. The key, not its value: in a
 * build core strips the payloads before lowering, which leaves
 * `typeAnnotation: null` on the node while the param text keeps the authored
 * annotation; Babel's parser sets no such key on an unannotated node.
 */
function annotated(node: ParamNode): boolean {
  return "typeAnnotation" in node;
}

/** A node's start and end offsets, read as core's `bindingIdentifierNodes` reads them. */
function startOf(node: ParamNode): number | undefined {
  return node.loc?.start?.index ?? node.start ?? undefined;
}
function endOf(node: ParamNode): number | undefined {
  return node.loc?.end?.index ?? node.end ?? undefined;
}

/** A default whose type TypeScript infers usefully: a primitive literal, or `-` over a number. */
function isPrimitiveDefault(node: ParamNode | undefined): boolean {
  if (!node) return false;
  if (LITERALS.has(node.type)) return true;
  return (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    (node.argument?.type === "NumericLiteral" ||
      node.argument?.type === "BigIntLiteral")
  );
}

/**
 * A `<define>` param as the arrow declares it, from its text (the param's
 * exact source) and its parser node. A param that carries its own type
 * (`a: string`) is kept as written, and so is a plain name with a
 * primitive-literal default (`n = 1`), whose type TypeScript infers from the
 * default. Any other is typed `any` (`any[]` for a rest param): a bare name, a
 * pattern, a null/undefined/`[]`/`{}`/expression default, so a strict project
 * (`noImplicitAny`) does not report TS7006 or TS7031 on a define whose params
 * the author left untyped.
 */
export function typedDefineParamNode(text: string, node: ParamNode): string {
  if (annotated(node)) return text;
  if (node.type === "AssignmentPattern" && node.left) {
    const left = node.left;
    if (annotated(left)) return text;
    if (left.type === "Identifier" && isPrimitiveDefault(node.right)) {
      return text;
    }
    const start = startOf(node);
    const leftEnd = endOf(left);
    if (start === undefined || leftEnd === undefined) return text;
    const at = leftEnd - start;
    return `${text.slice(0, at)}: any${text.slice(at)}`;
  }
  if (node.type === "RestElement") return `${text}: any[]`;
  return `${text}: any`;
}
