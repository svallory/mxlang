/**
 * The Babel payload of an MX expression container (PR 4).
 *
 * MX wraps every embedded piece of TypeScript in a container
 * (`MxExpression`, `MxStatements`, `MxPattern`, `MxArguments`,
 * `MxParameterList`, …; `@mxlang/babel`'s `mx-ast.ts`, ast §4.1) whose `node`
 * is the Babel payload, or `null` with an `error` when the front end could
 * not parse it. Marko's tree hands lowering the Babel node itself, so the
 * `any`-typed path never had the guards below; each one is a behaviour of
 * the MX path and has its own test.
 */
import { fail, type Node } from "./core.ts";

/**
 * A container's Babel payload, checked in this order:
 *
 * 1. An expression trigger inside (decision 182; ast §4.4) is refused at the
 *    first one, in the syntax pre-pass's wording, until lowering dispatches
 *    triggers to the table's `lowerTrigger`. This is that dispatch's seam.
 * 2. A container the front end could not parse fails at its `MxParseError`,
 *    with the parser's message.
 * 3. A container with neither a payload nor an error is an MX bug.
 * 4. Otherwise, its `node`.
 *
 * Every failure is on an MX node, so `fail` positions it from the node's
 * offsets at the lowering boundary.
 */
export function payloadOf(container: Node): Node {
  const trigger = container.triggers?.[0];
  if (trigger) {
    // Decision 182 seam: `lowerTrigger` dispatch replaces this refusal.
    fail(`\`${trigger.id}\` trigger has no lowering yet`, trigger);
  }
  if (container.error) fail(container.error.message, container.error);
  if (container.node == null) {
    fail(
      `\`${container.type}\` has neither a payload nor an error (not yours: an MX bug)`,
      container,
    );
  }
  return container.node;
}
