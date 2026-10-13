/**
 * Reading a derived `<const>` after writing a `<let>` it depends on, inside
 * one event handler, one `<script>` body or one `<lifecycle>` hook.
 *
 * Targets disagree on what the read returns. Marko, React and Solid 2 apply a
 * write when the turn ends, so the read still shows the value from before the
 * write; Svelte, Vue, Angular and Lit recompute on read and show the new one.
 * One source has to mean the same on every target, so core refuses the read
 * and names the ways out. In a handler: compute from the written value, or
 * move the check into a `<script>`, which runs after the write has settled.
 * In a `<script>` body or a `<lifecycle>` hook, which are where the write
 * settles, a body that writes is not the place to move the read to: compute
 * from the written value.
 *
 * Scope, as implemented:
 *
 * - A derived `<const>` is one whose value mentions a `<let>` or another
 *   derived `<const>`, at any depth, even inside a callback the value passes
 *   on (the value still depends on it). Transitive: the set of `<let>`s is
 *   resolved when the `<const>` is declared (`derivedFrom`).
 * - A handler is the function given to an `on…` attribute, whatever the tag.
 *   A `<script>` body is one function body of its own (`bodyFunction`), and a
 *   `<lifecycle>` hook is any function the tag is given. The walk looks at
 *   that function's own body: a nested function (a `setTimeout` or `.then`
 *   callback) runs after the flush and is skipped, for reads and for writes
 *   alike.
 * - "After" is source order in that body, with a write counted from the end
 *   of its own expression (`items = [...items, total]` reads `total` first).
 *   A write in an earlier branch counts, and so does one after an `await`.
 *   A write and a read inside the same loop count both ways, because the
 *   write of one iteration comes before the read of the next.
 * - A parameter or local that shadows the `<const>` or the `<let>` is neither
 *   a read nor a write of it.
 *
 * Not detected: a handler held in a variable or built by a call
 * (`onClick=makeHandler()`), a function value declared with `<const>` and
 * called from a handler, script body or hook, a write made inside a nested
 * function, a `for (x of …)` head used as a write, a `<script>` body that
 * holds a `${…}` placeholder, and any flow through a called function.
 */

import { coreBabel } from "./babel.ts";
import type { Node } from "./core.ts";
import { assignedNames } from "./render-let-write.ts";

/** A derived `<const>`, by name, and the `<let>`s its value depends on. */
export type DerivedConsts = ReadonlyMap<string, ReadonlySet<string>>;

/** One stale read: where, which `<const>`, and the write that made it stale. */
export type StaleRead = {
  /** The identifier that reads the `<const>`. */
  readonly read: Node;
  /** The `<const>` it reads. */
  readonly name: string;
  /** The `<let>` the body wrote that the `<const>` depends on. */
  readonly written: string;
  /** The assignment or update that writes it. */
  readonly write: Node;
};

const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

/** A node wrapped for a walk: the walk validates nothing, so it goes as is. */
function wrapped(node: Node): Node {
  const { types } = coreBabel();
  return types.file(
    types.program([{ type: "ExpressionStatement", expression: node } as Node]),
  );
}

/** The names `expression` reads that it does not declare itself. */
function referencedNames(expression: Node): Set<string> {
  const names = new Set<string>();
  if (!expression) return names;
  coreBabel().traverse(wrapped(expression), {
    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      if (path.scope.getBinding(path.node.name)) return;
      names.add(path.node.name);
    },
  });
  return names;
}

/**
 * The `<let>`s a `<const>` with this value depends on: the `<let>`s the
 * value mentions, and what each derived `<const>` it mentions depends on.
 * Empty when the value is not derived.
 */
export function derivedFrom(
  value: Node,
  lets: ReadonlySet<string>,
  derived: DerivedConsts | undefined,
): Set<string> {
  const from = new Set<string>();
  for (const name of referencedNames(value)) {
    if (lets.has(name)) from.add(name);
    for (const dependency of derived?.get(name) ?? []) from.add(dependency);
  }
  return from;
}

/** The function a handler attribute holds, through parentheses and casts. */
export function handlerFunction(value: Node): Node | undefined {
  let node = value;
  while (
    node &&
    (node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression")
  ) {
    node = node.expression;
  }
  return node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
    ? node
    : undefined;
}

/**
 * A `<script>` body as the function it runs in: an async arrow holding the
 * parsed statements, so `findStaleRead` walks it as it walks a handler (the
 * body may `await`, and its locals shadow like a function's).
 */
export function bodyFunction(program: Node): Node {
  return {
    type: "ArrowFunctionExpression",
    async: true,
    expression: false,
    params: [],
    body: {
      type: "BlockStatement",
      body: program.body,
      directives: program.directives ?? [],
    },
  };
}

type Access = {
  readonly node: Node;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly loops: ReadonlySet<Node>;
};

/**
 * The first read of a derived `<const>` in `handler`'s body that follows a
 * write to a `<let>` it depends on, if any. `lets` are the `<let>`s in scope.
 */
export function findStaleRead(
  handler: Node,
  lets: ReadonlySet<string>,
  derived: DerivedConsts,
): StaleRead | undefined {
  const reads: Access[] = [];
  const writes: Access[] = [];
  const { traverse } = coreBabel();

  traverse(wrapped(handler), {
    Function(handlerPath: Node) {
      if (handlerPath.node !== handler) return;
      /** The loops of the handler's own body that enclose `path`. */
      const loopsOf = (path: Node): Set<Node> => {
        const loops = new Set<Node>();
        let child = path;
        for (let at = path.parentPath; at && at !== handlerPath; ) {
          // A `for` initializer and a `for…of` / `for…in` subject run once,
          // before any write in the body, so they are not inside the loop.
          const once =
            child.key === "init" ||
            (child.key === "right" && at.node.type !== "ForStatement");
          if (LOOPS.has(at.node.type) && !once) loops.add(at.node);
          child = at;
          at = at.parentPath;
        }
        return loops;
      };
      const own = (path: Node): boolean =>
        path.getFunctionParent()?.node === handler;
      const writeAt = (path: Node, target: Node): void => {
        if (!own(path)) return;
        const names: string[] = [];
        assignedNames(target, names);
        for (const name of names) {
          if (!lets.has(name) || path.scope.getBinding(name)) continue;
          writes.push({
            node: path.node,
            name,
            start: path.node.start,
            end: path.node.end,
            loops: loopsOf(path),
          });
        }
      };
      handlerPath.traverse({
        AssignmentExpression(path: Node) {
          writeAt(path, path.node.left);
        },
        UpdateExpression(path: Node) {
          writeAt(path, path.node.argument);
        },
        Identifier(path: Node) {
          const { name } = path.node;
          if (!derived.has(name) || !path.isReferencedIdentifier()) return;
          if (!own(path) || path.scope.getBinding(name)) return;
          reads.push({
            node: path.node,
            name,
            start: path.node.start,
            end: path.node.end,
            loops: loopsOf(path),
          });
        },
      });
      handlerPath.stop();
    },
  });

  if (writes.length === 0 || reads.length === 0) return undefined;
  // Source order, so the first read reported is the first one in the file.
  reads.sort((a, b) => a.start - b.start);
  writes.sort((a, b) => a.start - b.start);
  for (const read of reads) {
    const dependencies = derived.get(read.name);
    const write = writes.find(
      (candidate) =>
        dependencies?.has(candidate.name) &&
        (candidate.end <= read.start ||
          [...candidate.loops].some((loop) => read.loops.has(loop))),
    );
    if (write) {
      return {
        read: read.node,
        name: read.name,
        written: write.name,
        write: write.node,
      };
    }
  }
  return undefined;
}
