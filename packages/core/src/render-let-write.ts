/**
 * A write to a binding that the code at hand may not write.
 *
 * A `<let>` is state: a render reads it, and an event handler or a `<script>`
 * body writes it. A render that writes its own input would need a second
 * render to show the write, which would write again, so no target can run
 * it. Core refuses it before any target sees the file. The same walk refuses
 * the other writes Marko refuses at compile time and a runtime would take
 * silently:
 *
 * - while the template renders: a `<const>`, a `<for>` parameter (value,
 *   index, key) and a `<define>` parameter;
 * - in a handler, a callback or a `<script>` body too: a `<const>`, a `<for>`
 *   parameter and a `<define>` parameter bound as a plain name, which are
 *   never written (a name bound through an object pattern is written there,
 *   through its object);
 * - anywhere: a `<let>` or a `<const>` written above its declaration, and a
 *   `for…of` or `for…in` whose left side is a `<let>` (a `<let>` is written by
 *   assignment, and a loop head is not a place a target can route one
 *   through); a two-way binding (`:=`, `:fn:=`) whose value is a plain-name
 *   `<const>` is a write the host would make, and is refused the same way.
 *
 * "While the template renders" is the code that runs as the template does,
 * read off the expression and not off how the file is used: a placeholder, an
 * attribute or tag argument, a `<const>` value, an `<if>` or `<for>` header.
 * The code inside a function (an event handler, an arrow passed as an
 * attribute, an object method, a `<let>`'s own `valueChange`) runs when
 * that function is called, so a write to a `<let>` there is the way a `<let>`
 * is written and is never refused. A function called while the template
 * renders is not followed: there is no flow analysis, so a write inside
 * `${bump()}`'s callee is not detected.
 *
 * What counts as a function is Marko's own list: a function declaration, a
 * function expression, an arrow and an object method. A class member is not
 * one (its body runs when the class is used, but Marko refuses a write there
 * and so does MX): a method, getter, private method, computed key, field
 * initializer or static block of a class in an expression is render position,
 * unless a function of the list encloses the write.
 *
 * A parameter or a local of the same spelling as a guarded name shadows it
 * wherever it is declared, inside a function or not, and a write to it is
 * never refused (read off the expression's own scopes); the scopes of the
 * template itself (a loop variable, a `<const>`) are tracked by the lowerer,
 * which hands this module only the names in effect.
 */

import { coreBabel } from "./babel.ts";
import type { Node, WriteGuard } from "./core.ts";
import type { MxDiagnosticCode } from "./diagnostic-codes.ts";
import {
  CONST_WRITE_BEFORE_DECLARATION_CODE,
  LET_LOOP_ASSIGNMENT_CODE,
  LET_WRITE_BEFORE_DECLARATION_CODE,
  LET_WRITE_IN_RENDER_CODE,
  READONLY_BINDING_WRITE_CODE,
} from "./diagnostic-codes.ts";
import type { Voice } from "./message-vocabulary.ts";

/** Why a write is refused. */
export type WriteReason =
  /** A `<let>` written while the template renders. */
  | "let-render"
  /** A `<let>` written above its declaration. */
  | "let-below"
  /** A `<const>` written above its declaration. */
  | "const-below"
  /** A `<let>` assigned by a `for…of` or `for…in` head. */
  | "let-loop"
  /** A `<define>` parameter bound as a plain name, written anywhere. */
  | "define-plain"
  | WriteGuard["kind"];

/** The first refused write found, with the name it writes. */
export type BindingWrite = {
  /** What is reported: the assignment or update, or a loop's left side. */
  readonly node: Node;
  /** The binding it writes. */
  readonly name: string;
  readonly reason: WriteReason;
  /** A `"const-below"` whose declaring tag binds a plain name (no pattern). */
  readonly plain?: boolean;
  /** `of` or `in` for a `"let-loop"`. */
  readonly loop?: "of" | "in";
};

/** The names in effect, by what a write to each is refused for. */
export type WriteRules = {
  /** `<let>`s declared above: refused while rendering, and in a loop head. */
  readonly lets?: ReadonlySet<string>;
  /** `<let>`s declared below: refused everywhere. */
  readonly later?: ReadonlySet<string>;
  /** `<const>`s declared below: refused everywhere, like `later`. */
  readonly laterConsts?: ReadonlySet<string>;
  /** The plain-name `<const>`s among `laterConsts`: a two-way binding to one
   * is refused too, while a pattern name is writable where a binding writes. */
  readonly laterPlainConsts?: ReadonlySet<string>;
  /** `<const>` and parameters. */
  readonly guards?: ReadonlyMap<string, WriteGuard>;
};

/** Is `path` inside a function that runs later than the render? */
function insideFunction(path: Node): boolean {
  return Boolean(
    path.findParent(
      (parent: Node) =>
        parent.isFunctionDeclaration() ||
        parent.isFunctionExpression() ||
        parent.isArrowFunctionExpression() ||
        parent.isObjectMethod(),
    ),
  );
}

/** Every identifier an assignment target binds, in source order. */
export function assignedNames(target: Node, out: string[]): void {
  switch (target?.type) {
    case "Identifier":
      out.push(target.name);
      return;
    case "ArrayPattern":
      for (const element of target.elements ?? []) assignedNames(element, out);
      return;
    case "ObjectPattern":
      for (const property of target.properties ?? []) {
        assignedNames(
          property.type === "RestElement" ? property : property.value,
          out,
        );
      }
      return;
    case "RestElement":
      assignedNames(target.argument, out);
      return;
    case "AssignmentPattern":
      assignedNames(target.left, out);
      return;
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "ParenthesizedExpression":
      assignedNames(target.expression, out);
      return;
    default:
      // A member target (`p.count = 1`) mutates the object the name holds
      // rather than rebinding the name.
      return;
  }
}

/**
 * Finds the first refused write, in source order, in `expression`.
 *
 * `inFunction` says the whole expression runs later than the render (a
 * `<script>` body), so no write in it is in render position.
 */
export function findBindingWrite(
  expression: Node,
  rules: WriteRules,
  inFunction = false,
): BindingWrite | undefined {
  const { lets, later, laterConsts, laterPlainConsts, guards } = rules;
  if (
    !expression ||
    !(lets?.size || later?.size || laterConsts?.size || guards?.size)
  ) {
    return undefined;
  }
  const { traverse, types } = coreBabel();
  // A tag param (`x = count++`) is a pattern, which `expressionStatement`
  // would refuse; the walk validates nothing, so the node is wrapped as is.
  const file = types.file(
    types.program(
      expression.type === "Program"
        ? expression.body
        : [{ type: "ExpressionStatement", expression } as Node],
    ),
  );
  let found: BindingWrite | undefined;

  const reasonFor = (
    path: Node,
    name: string,
    loop: boolean,
  ):
    | { reason: WriteReason; plain?: boolean; loop?: "of" | "in" }
    | undefined => {
    // A name the expression declares itself is not the template's.
    if (path.scope.getBinding(name)) return undefined;
    const runsLater = inFunction || insideFunction(path);
    // A declaration below in this (or an inner) block is the nearer one, so
    // it decides over a guard a declaration above left (stock reports the
    // declaration below); a two-way binding writes in handler position,
    // where a pattern name is writable, so only a plain name is refused
    // there (checked at the binding site, not here).
    if (later?.has(name)) return { reason: "let-below" };
    if (laterConsts?.has(name)) {
      return {
        reason: "const-below",
        plain: laterPlainConsts?.has(name) || undefined,
      };
    }
    const guard = guards?.get(name);
    if (guard) {
      if (runsLater && !guard.inFunction) return undefined;
      return {
        reason:
          guard.kind === "define" && guard.inFunction
            ? "define-plain"
            : guard.kind,
      };
    }
    if (lets?.has(name)) {
      if (loop) return { reason: "let-loop" };
      return runsLater ? undefined : { reason: "let-render" };
    }
    return undefined;
  };

  const check = (
    path: Node,
    target: Node,
    report: Node,
    loop?: "of" | "in",
  ) => {
    if (found) return;
    const names: string[] = [];
    assignedNames(target, names);
    for (const name of names) {
      const found0 = reasonFor(path, name, loop !== undefined);
      if (!found0) continue;
      found = {
        node: report,
        name,
        ...found0,
        ...(found0.reason === "let-loop" && loop ? { loop } : {}),
      };
      path.stop();
      return;
    }
  };

  const loopHead = (path: Node, loop: "of" | "in"): void => {
    // `for (const x of xs)` declares; only a bare target assigns.
    const { left } = path.node;
    if (left?.type !== "VariableDeclaration") check(path, left, left, loop);
  };

  traverse(file, {
    AssignmentExpression(path: Node) {
      check(path, path.node.left, path.node);
    },
    UpdateExpression(path: Node) {
      check(path, path.node.argument, path.node);
    },
    ForOfStatement(path: Node) {
      loopHead(path, "of");
    },
    ForInStatement(path: Node) {
      loopHead(path, "in");
    },
  });
  return found;
}

/** The diagnostic code of a refused write. */
export function bindingWriteCode(write: BindingWrite): MxDiagnosticCode {
  switch (write.reason) {
    case "let-render":
      return LET_WRITE_IN_RENDER_CODE;
    case "let-below":
      return LET_WRITE_BEFORE_DECLARATION_CODE;
    case "const-below":
      return CONST_WRITE_BEFORE_DECLARATION_CODE;
    case "let-loop":
      return LET_LOOP_ASSIGNMENT_CODE;
    default:
      return READONLY_BINDING_WRITE_CODE;
  }
}

/**
 * The message of a refused write: the rule and the fix, with each built-in
 * tag spelled in the file's voice.
 */
export function bindingWriteMessage(write: BindingWrite, voice: Voice): string {
  const name = `\`${write.name}\``;
  const [letTag, constTag, forTag, defineTag, scriptTag] = [
    "let",
    "const",
    "for",
    "define",
    "script",
  ].map((tag) => voice.tag(tag));
  switch (write.reason) {
    case "let-render":
      return `${name} is a ${letTag} and cannot be written while the template renders. Write it in an event handler or a ${scriptTag} body, or derive a value with ${constTag}.`;
    case "let-below":
      return `${name} is a ${letTag} declared below this write, and a ${letTag} can only be written below its declaration. Move the ${letTag} above this code.`;
    case "const-below":
      // The advice depends on the declaring tag: a plain-name `<const>` is
      // never written at all (moving it above the write trades one refusal
      // for another), while a pattern name is written through its object, so
      // moving the declaration above the write is the fix there.
      return write.plain
        ? `${name} is a ${constTag} declared below this write, and a tag variable can only be assigned below its declaration. A ${constTag} is never written: declare ${name} with a ${letTag} and write that in an event handler or a ${scriptTag} body, or derive a new value with another ${constTag}.`
        : `${name} is a ${constTag} declared below this write, and a tag variable can only be assigned below its declaration. Move the ${constTag} above this code.`;
    case "let-loop":
      return `${name} is a ${letTag}, so a \`for...${write.loop}\` cannot assign to it. Loop into a local variable and assign ${name} from it instead.`;
    case "const":
      return `${name} is a ${constTag} and cannot be written. Keep a value that changes in a ${letTag} and write that in an event handler or a ${scriptTag} body, or derive a new value with another ${constTag}.`;
    case "for":
      return `${name} is a ${forTag} parameter and cannot be written. Keep a value that changes in a ${letTag}, or derive a new value with a ${constTag}.`;
    case "define":
      return `${name} is a ${defineTag} parameter and cannot be written while the template renders. Write it in an event handler or a ${scriptTag} body, or derive a value with ${constTag}.`;
    case "define-plain":
      return `${name} is a ${defineTag} parameter and cannot be written. Keep a value that changes in a ${letTag}, or derive a new value with a ${constTag}.`;
  }
}
