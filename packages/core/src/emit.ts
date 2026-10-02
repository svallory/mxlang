/**
 * The emitter interface and its driver (decision 79).
 *
 * A host implements `Emitter<Out>` — one method per IR kind — and `drive()`
 * walks the IR calling them. Nothing here knows what `Out` is: the vanilla
 * host accumulates string-builder lines, a JSX host would accumulate Babel
 * nodes, and neither is privileged by this file.
 *
 * ## Why a driver, rather than each host walking the IR
 *
 * The IR is a tree with a few shapes that are easy to get subtly wrong in the
 * same way twice: an if-chain's branches are already grouped (so a host must
 * not re-scan siblings for `<else>`), a `<for>`'s params already shadow its
 * body's bindings (so a host must not re-shadow), and `Hoisted` nodes must
 * precede the construct that produced them. Driving the walk once here means a
 * second host inherits those rules instead of re-deriving them — which is the
 * concrete payoff decision 79 predicted when it said Solid becomes "emitter
 * number three".
 *
 * A host that needs to render a child list itself — a component's `content`
 * block, an attribute tag's body — calls `drive` recursively with its own
 * emitter, which is why `drive` takes the nodes rather than the whole `Ir`.
 */

import type { Ir, IrNode } from "./ir.ts";

/**
 * One method per IR kind.
 *
 * Every method is required: an emitter that silently ignored a kind would drop
 * authored content from a successful compile, which is the S8 class this
 * codebase's guards exist to close. A host that genuinely cannot express a
 * construct throws from the method rather than omitting it, so the failure
 * names the construct and its position.
 */
export interface Emitter<Out> {
  text(node: Extract<IrNode, { kind: "Text" }>): void;
  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void;
  element(node: Extract<IrNode, { kind: "Element" }>): void;
  component(node: Extract<IrNode, { kind: "Component" }>): void;
  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void;
  forLoop(node: Extract<IrNode, { kind: "For" }>): void;
  define(node: Extract<IrNode, { kind: "Define" }>): void;
  constant(node: Extract<IrNode, { kind: "Const" }>): void;
  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void;
  delegatedTag(node: Extract<IrNode, { kind: "DelegatedTag" }>): void;
  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void;
  comment(node: Extract<IrNode, { kind: "Comment" }>): void;
  /** The accumulated output, once the walk is done. */
  done(): Out;
}

/**
 * Walks a list of IR nodes, calling the emitter's method for each kind.
 *
 * Module-level kinds (`Import`, `Static`, `Export`, `InputInterface`) never
 * reach here: `lower()` lifts them out of the body into `Ir`'s own fields,
 * so a host places them from there rather than filtering the tree.
 */
export function drive<Out>(emitter: Emitter<Out>, nodes: IrNode[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "Text":
        emitter.text(node);
        break;
      case "Interpolation":
        emitter.interpolation(node);
        break;
      case "Element":
        emitter.element(node);
        break;
      case "Component":
        emitter.component(node);
        break;
      case "IfChain":
        emitter.ifChain(node);
        break;
      case "For":
        emitter.forLoop(node);
        break;
      case "Define":
        emitter.define(node);
        break;
      case "Const":
        emitter.constant(node);
        break;
      case "Hoisted":
        emitter.hoisted(node);
        break;
      case "DelegatedTag":
        emitter.delegatedTag(node);
        break;
      case "DocumentType":
        emitter.documentType(node);
        break;
      case "Comment":
        emitter.comment(node);
        break;
      // The module-level kinds, lifted into `Ir`'s fields by `lower()`. A
      // host reads them from there, so reaching one here means the IR was
      // hand-built rather than lowered. Throwing rather than ignoring: a
      // silent `break` would drop a real `import` or `export` from a
      // successful compile, which is the S8 class this codebase's guards
      // exist to close.
      case "Import":
      case "Static":
      case "Export":
      case "InputInterface":
        throw new Error(
          `@mxlang/core: unexpected module-level node kind "${node.kind}" in the body walk; lower() lifts these into Ir's own fields`,
        );
      // A kind no emitter knows about. `node` is `never` here when the switch
      // is exhaustive, so the compiler catches a *new* IR kind at build time;
      // the runtime throw stays because the guard has to hold for a forged or
      // cross-version node too, and silently ignoring one drops authored
      // content from a successful compile (the S8 class).
      default: {
        const unknown = node as { kind?: unknown };
        throw new Error(
          `@mxlang/core: unknown IR node kind ${JSON.stringify(unknown?.kind)}; every kind must be handled by the driver`,
        );
      }
    }
  }
}

/** Drives a whole lowered template and returns the emitter's output. */
export function emit<Out>(emitter: Emitter<Out>, ir: Ir): Out {
  drive(emitter, ir.body);
  return emitter.done();
}
