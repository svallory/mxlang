/**
 * Rewriting identifier *reads* into another expression, across an IR subtree.
 *
 * This is the generic half of what `template-tag.ts` does for `input.<name>`:
 * "every free reference to name `x` becomes expression `f(x)`". It exists
 * separately because a host needs the same machinery for a reason that has
 * nothing to do with custom tags — Solid 2's `<For>` hands some callback
 * parameters as **accessors**, so a body the author wrote against a value
 * (`${p.name}`) has to read `p().name` instead.
 *
 * ## Why rewrite reads rather than snapshot
 *
 * The obvious alternative is one `const p = p$()` at the top of the callback.
 * It is wrong: that runs once per row, so the row goes stale the moment Solid
 * updates a same-key row in place. Rewriting each read keeps the call inside
 * Solid's tracking scope, which is the whole point of being handed an
 * accessor.
 *
 * ## Why an AST and not a regex
 *
 * Same reason as `rewriteExpressionCode` — see its own note for the measured
 * table of ways a regex over printed JavaScript gets this silently wrong
 * (`x?x:x`, `'x' + x`, a template literal's text, a class method's name).
 * Scope is Babel's: `isReferencedIdentifier()` excludes member properties,
 * non-shorthand object keys, labels and `case` clauses, and
 * `path.scope.getBinding(name)` excludes a name an inner scope rebinds, so an
 * arrow parameter `p => p.x` inside the body is left alone.
 */

import { markoBabel, type Node, TranslateError } from "./core.ts";
import type { IrNode, Position } from "./ir.ts";
import { rewriteCodes } from "./template-tag.ts";

/** How one bound name is read where it is referenced. */
export type ReadRewrite = {
  /**
   * The replacement expression's complete source text — `"p()"` for a row
   * read as an accessor, `"mxEntry()[0]"` for a for-in key. It is parsed once
   * per rewritten reference and substituted whole; it does not refer to the
   * identifier it replaces, so a caller that needs the original name in the
   * replacement spells it out.
   */
  readonly read: string;
  /**
   * Message for an assignment to this name (`p = x`, `i++`). An accessor is
   * not assignable, so the emitted code would be a run-time error with no
   * diagnostic — the silent class this codebase guards against.
   */
  readonly assignError: string;
};

/**
 * Applies `rewrites` to every `Expr` in `nodes`, in place.
 *
 * Shadowing is respected at both levels: `rewriteCodes` carries the names
 * bound by the IR above each expression (a nested `<for|p|>` rebinding `p`),
 * and Babel's own scope analysis handles bindings inside one expression (an
 * arrow parameter, a `catch` clause).
 */
export function rewriteAccessorReads(
  nodes: IrNode[],
  rewrites: ReadonlyMap<string, ReadRewrite>,
): void {
  if (rewrites.size === 0) return;
  rewriteCodes(nodes, (code, loc, shadowed) =>
    rewriteReadsInCode(code, rewrites, loc, shadowed),
  );
}

/** Parses one expression, rewrites the reads it makes, and reprints it. */
export function rewriteReadsInCode(
  code: string,
  rewrites: ReadonlyMap<string, ReadRewrite>,
  loc: Position,
  shadowed: ReadonlySet<string> = new Set(),
): string {
  const { parseExpression, traverse, types, generator } = markoBabel();

  let parsed: Node;
  try {
    parsed = parseExpression(code, { plugins: [["typescript", {}]] });
  } catch {
    // An expression the vendored parser cannot read is left exactly as it
    // was: it reached here already printed by the lowerer, and failing the
    // compile on a parse the *emitter* would have accepted would be its own
    // regression. Matches `rewriteExpressionCode`'s stance.
    return code;
  }

  const file = types.file(
    types.program([types.expressionStatement(parsed as Node)]),
  );
  let changed = false;

  const active = (path: Node, name: string): ReadRewrite | undefined => {
    if (shadowed.has(name)) return undefined;
    if (path.scope.getBinding(name)) return undefined;
    return rewrites.get(name);
  };

  /**
   * Raises the assignment error for any rewritten name a target binds.
   *
   * An assignment target is not always an identifier: `[p] = arr` and
   * `({ p } = o)` assign through patterns, and `for (p of xs)` assigns
   * through a statement's `left`. Each still writes to the binding, which an
   * accessor cannot accept, so every identifier the target binds is checked
   * rather than only the simple case.
   */
  const rejectAssignmentTo = (path: Node, target: Node): void => {
    const visit = (node: Node): void => {
      if (!node) return;
      switch (node.type) {
        case "Identifier": {
          const rewrite = active(path, node.name);
          if (!rewrite) return;
          throw new TranslateError(
            rewrite.assignError,
            loc.line,
            loc.column,
            loc.file,
          );
        }
        case "ArrayPattern":
          for (const element of node.elements ?? []) visit(element);
          return;
        case "ObjectPattern":
          for (const property of node.properties ?? []) {
            visit(property.type === "RestElement" ? property : property.value);
          }
          return;
        case "RestElement":
          visit(node.argument);
          return;
        case "AssignmentPattern":
          visit(node.left);
          return;
        default:
          // A member target (`p.count = 1`, `p[0] = x`) mutates the object the
          // accessor returns rather than rebinding the name, so it is legal
          // and deliberately not walked.
          return;
      }
    };
    visit(target);
  };

  traverse(file, {
    AssignmentExpression(path: Node) {
      rejectAssignmentTo(path, path.node.left);
    },

    UpdateExpression(path: Node) {
      rejectAssignmentTo(path, path.node.argument);
    },

    // `for (p of xs)` / `for (p in o)` assign to `p` on each iteration. Left
    // unchecked, the `Identifier` visitor below rewrote the loop target to a
    // call and Babel asserted on the malformed tree
    // (`Property left of ForOfStatement expected node to be of a type
    // ["VariableDeclaration","LVal"]`) — an internal crash instead of a
    // diagnostic. A `left` that declares its own binding (`for (const p of …)`)
    // is a new scope and is not a write to the row.
    ForOfStatement(path: Node) {
      if (path.node.left?.type === "VariableDeclaration") return;
      rejectAssignmentTo(path, path.node.left);
    },

    ForInStatement(path: Node) {
      if (path.node.left?.type === "VariableDeclaration") return;
      rejectAssignmentTo(path, path.node.left);
    },

    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      const name = path.node.name;
      const rewrite = active(path, name);
      if (!rewrite) return;
      const replacement = parseExpression(rewrite.read, {
        plugins: [["typescript", {}]],
      });
      path.replaceWith(replacement);
      path.skip();
      changed = true;
    },
  });

  // Reprinting is not free and it normalizes the author's own spacing, so an
  // expression that rewrote nothing keeps its original text verbatim.
  if (!changed) return code;
  return generator(file.program.body[0].expression, { concise: true }).code;
}

/** One name a destructuring pattern binds, with the path that reads it. */
export type DestructuredName = {
  readonly name: string;
  /** Member path applied to the row expression — `.name`, `[0]`. */
  readonly path: string;
};

/**
 * The names a destructuring parameter binds, each with the member path that
 * reads it from the value — `{ name, id: k }` gives `.name` for `name` and
 * `.id` for `k`; `[a, b]` gives `[0]` and `[1]`.
 *
 * Parsed, not scanned: a pattern may nest, rename and default, and each of
 * those changes which name is bound and what reads it.
 *
 * Returns `null` when the pattern does not parse, or binds something no
 * single member read can express (a rest element) — the caller raises the
 * positioned error, since only it knows which construct the parameter came
 * from.
 */
export function destructuredNames(pattern: string): DestructuredName[] | null {
  const { parseExpression } = markoBabel();
  let parsed: Node;
  try {
    // A pattern is not an expression on its own; an assignment's left-hand
    // side is the shape that parses.
    parsed = parseExpression(`(${pattern} = 0)`, {
      plugins: [["typescript", {}]],
    }).left;
  } catch {
    return null;
  }

  const out: DestructuredName[] = [];
  let ok = true;
  const walk = (target: Node, path: string): void => {
    if (!target || !ok) return;
    switch (target.type) {
      case "Identifier":
        out.push({ name: target.name, path });
        return;
      case "AssignmentPattern":
        walk(target.left, path);
        return;
      case "ObjectPattern":
        for (const property of target.properties ?? []) {
          if (property.type === "RestElement") {
            ok = false;
            return;
          }
          const key = property.key;
          const step = property.computed
            ? key?.type === "StringLiteral"
              ? `[${JSON.stringify(key.value)}]`
              : `[${key?.name}]`
            : key?.type === "Identifier"
              ? `.${key.name}`
              : `[${JSON.stringify(key?.value)}]`;
          walk(property.value, `${path}${step}`);
        }
        return;
      case "ArrayPattern":
        (target.elements ?? []).forEach((element: Node, index: number) => {
          if (element?.type === "RestElement") {
            ok = false;
            return;
          }
          walk(element, `${path}[${index}]`);
        });
        return;
      default:
        ok = false;
    }
  };
  walk(parsed, "");
  return ok ? out : null;
}
