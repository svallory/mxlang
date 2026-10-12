/**
 * A write to a `<let>` while the template renders.
 *
 * A `<let>` is state: a render reads it, and an event handler or a `<script>`
 * body writes it. A render that writes its own input would need a second
 * render to show the write, which would write again, so no target can run
 * it. Core refuses it before any target sees the file.
 *
 * "While the template renders" is the code that runs as the template does,
 * read off the expression and not off how the file is used: a placeholder, an
 * attribute or tag argument, a `<const>` value, an `<if>` or `<for>` header.
 * The code inside a function (an event handler, an arrow passed as an
 * attribute, a method shorthand, a `<let>`'s own `valueChange`) runs when
 * that function is called, so a write there is the way a `<let>` is written
 * and is never refused. A function called while the template renders is not
 * followed: there is no flow analysis, so a write inside `${bump()}`'s
 * callee is not detected.
 *
 * A parameter or a local of the same spelling as the `<let>` can only be
 * declared inside a function, so skipping the code inside functions also
 * settles shadowing within one expression; the scopes of the template itself
 * (a loop variable, a `<const>`) are tracked by the lowerer.
 */

import { coreBabel } from "./babel.ts";
import type { Node } from "./core.ts";

/** The first write to one of `lets` that runs during render, if any. */
export type LetWrite = {
  /** The assignment or update expression. */
  readonly node: Node;
  /** The `<let>` it writes. */
  readonly name: string;
};

/** Every identifier an assignment target binds, in source order. */
function targetNames(target: Node, out: string[]): void {
  switch (target?.type) {
    case "Identifier":
      out.push(target.name);
      return;
    case "ArrayPattern":
      for (const element of target.elements ?? []) targetNames(element, out);
      return;
    case "ObjectPattern":
      for (const property of target.properties ?? []) {
        targetNames(
          property.type === "RestElement" ? property : property.value,
          out,
        );
      }
      return;
    case "RestElement":
      targetNames(target.argument, out);
      return;
    case "AssignmentPattern":
      targetNames(target.left, out);
      return;
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "ParenthesizedExpression":
      targetNames(target.expression, out);
      return;
    default:
      // A member target (`p.count = 1`) mutates the object the name holds
      // rather than rebinding the name.
      return;
  }
}

/**
 * Finds the first write, in source order, to a name in `lets` made outside
 * every function in `expression`.
 */
export function findLetWrite(
  expression: Node,
  lets: ReadonlySet<string>,
): LetWrite | undefined {
  if (lets.size === 0 || !expression) return undefined;
  const { traverse, types } = coreBabel();
  const file = types.file(
    types.program([types.expressionStatement(expression)]),
  );
  let found: LetWrite | undefined;

  const check = (path: Node, target: Node): void => {
    if (found || path.getFunctionParent()) return;
    const names: string[] = [];
    targetNames(target, names);
    for (const name of names) {
      if (!lets.has(name)) continue;
      found = { node: path.node, name };
      path.stop();
      return;
    }
  };

  traverse(file, {
    AssignmentExpression(path: Node) {
      check(path, path.node.left);
    },
    UpdateExpression(path: Node) {
      check(path, path.node.argument);
    },
  });
  return found;
}
