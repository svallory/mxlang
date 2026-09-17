/**
 * What a host *declares*, as opposed to what it *emits* (decision 79).
 *
 * Before the IR existed, one `Policy` object carried both: `isComponent` and
 * the `tags` table (queries the walk asks) sat beside `emitComponent` and
 * `emitSpecial` (callbacks that pushed text into a buffer mid-walk). That is
 * exactly the mix an IR cannot have — lower has to classify a tag without
 * emitting anything, and a host has to emit without re-walking Marko nodes.
 *
 * So the object splits in two. This file is the half `lower()` consults:
 * every member is a *question* about a tag name or a binding, and none of them
 * can write output. `Emitter<Out>` in `emit.ts` is the other half.
 *
 * `Policy` remains as an alias of `HostDeclarations`, deliberately: hosts
 * export their declarations by value (`@mxlang/html`'s `policy` and
 * `strictPolicy`, which `@mxlang/language-server` imports and passes to
 * `compileSource`), and those exports keep working under either name. The new
 * name is the accurate one — the object declares, it no longer emits — and is
 * what new code should use.
 */

import type { Ctx, Disposition, Node } from "./core.ts";
import type { Attr } from "./ir.ts";

export type { Disposition };

/**
 * The questions `lower()` asks a host about a template.
 *
 * Every member is side-effect free by contract. A member that wanted to emit
 * would have nowhere to emit *to*: lower builds an IR, and the buffer does
 * not exist yet.
 */
export interface HostDeclarations {
  /**
   * Per-tag-name dispositions: `inert` (accepted, no output, in a declared
   * shape) or `error` (this target cannot express it). Decision 65: never "my
   * code cannot".
   */
  tags: Record<string, Disposition>;
  /** Whether an unbound lowercase tag name is a real element. */
  isElement(name: string, ctx: Ctx): boolean;
  /** Whether a tag name resolves to a component in this host. */
  isComponent(name: string, ctx: Ctx): boolean;
  /**
   * Whether this host handles `name` itself, rather than letting the core
   * route it to a component or an element.
   *
   * The declaration half of what `emitSpecial` used to decide by returning
   * true or false *after* emitting. A claimed tag resolves to the `HostTag` IR
   * kind with its attributes, children, attribute tags, params and `var`
   * already resolved, and the host's emitter renders it.
   *
   * `DYNAMIC_TAG` is passed for `<${expr}/>`. `shape` distinguishes the bare
   * form (no attributes, no body — indistinguishable at parse time from a
   * plain `${expr}` placeholder) from a form carrying at least one, only for
   * `DYNAMIC_TAG`; omitted for every other name. A host that ignores the
   * third argument keeps claiming both shapes, which is every existing
   * host's behaviour — the parameter only lets a *new* host opt out of the
   * bare shape and leave it to the `Interpolation` fallback.
   */
  claimsTag?(name: string, ctx: Ctx, shape?: "bare" | "tagged"): boolean;
  /**
   * Records whatever this host decided about a claimed tag, into the
   * `HostTag` node's `data` slot.
   *
   * Called once per claimed tag, during lower, with the Marko node still in
   * hand. Without it a host's emitter would have no resolved record of the
   * decision; the original Marko node is deliberately absent from `HostTag`,
   * so emission cannot fall back to walking parser nodes.
   *
   * Also the seam decision 80's user-tag macros need: a user-defined tag with
   * compile-time meaning hands its resolved form to every host through this
   * channel, since the core cannot know what the macro decided.
   */
  resolveHostTag?(name: string, node: Node, ctx: Ctx): unknown;
  /**
   * Rejects an attribute modifier (`class:active`) in this host's own words.
   *
   * Called before the core's generic message, and expected to throw. A
   * Marko-parity target quotes Marko's own fix-it here, which reads very
   * differently from "not supported in a standalone template" — the core's
   * wording is a dialect's vocabulary leaking into a parity target.
   */
  rejectModifier?(attr: Node, on?: "element" | "component"): void;
  /**
   * Resolves an attribute modifier a host keeps as target syntax.
   *
   * Return the emitted IR name (for example `namespace:name`) to accept it;
   * return `undefined` to let `rejectModifier`/the generic diagnostic reject
   * it. Most hosts accept no modifiers, so this hook is optional.
   */
  resolveModifier?(
    attr: Node,
    on?: "element" | "component",
  ): string | undefined;
  /**
   * Rejects an attribute method in this host's own words.
   *
   * Marko represents an attribute method as a `FunctionExpression` value in
   * some parser paths and through `arguments` in others. The lowerer detects
   * both before constructing an `Attr`; a host may replace the generic
   * standalone-string diagnostic here.
   */
  rejectAttributeMethod?(attr: Node, on?: "element" | "component"): void;
  /** Return true when this host carries an attribute method as a callable prop. */
  resolveAttributeMethod?(attr: Node, on?: "element" | "component"): boolean;
  /**
   * Rejects attribute tags attached to an element in this host's own words.
   *
   * Attribute tags are represented in the IR only for component calls. A host
   * whose target has a more specific concept (Astro named slots, for example)
   * can explain the invalid element case while the Marko node and its precise
   * position are still available during lower.
   */
  rejectElementAttributeTags?(name: string, node: Node, ctx: Ctx): void;
  /**
   * Rejects a component call this host will not route, in its own words.
   *
   * Called from `lowerComponent` *before* the `Component` node is built, so
   * a construct the host refuses never reaches an emitter at all. The vanilla
   * HTML host uses it for Marko's own rule that a lowercase tag name is never
   * resolved through a local variable (`import layout …` then `<layout>`),
   * which Marko rejects outright — a check that has to happen at lower time
   * now that the emitter no longer sees the Marko node.
   */
  rejectComponentTag?(name: string, node: Node, ctx: Ctx): void;
  /**
   * Rejects an unresolved tag name in this host's own words.
   *
   * Called before the core's generic "unknown tag" message. A Marko-parity
   * target quotes Marko's own failure ("Unable to find entry point for custom
   * tag …"), which is what its users see and what the fixtures assert; the
   * core's wording is only the fallback for a host that supplies none.
   */
  rejectUnknownTag?(name: string, node: Node, ctx: Ctx): void;
  /**
   * Places already-resolved attributes in the order this host requires.
   *
   * Called during resolution for elements, components, and claimed host tags,
   * so the IR is already in host order and an emitter only walks it. This is
   * observable for HTML inputs: Marko places `value` before `type` because a
   * browser may reset or reinterpret a value when its type changes.
   */
  orderAttrs?(
    name: string,
    attrs: Attr[],
    on: "element" | "component",
    ctx: Ctx,
  ): Attr[];
  /**
   * Inspects a name a construct is about to bind at *render* scope — a
   * `<let>` or `<const>` name. A host rejects a name that would collide with
   * something the emitted module already binds.
   *
   * Deliberately not called for tag params (`<for|x|>`, `<define/R|x|>`):
   * those open a nested scope where an ordinary JS shadow is correct. Marko
   * draws the same line, accepting `<for|input|>` while rejecting
   * `<let/input>` as a duplicate declaration.
   */
  checkBinding?(target: Node, what: string): void;
  /**
   * Whether an HTML comment reaches the output. Stock Marko drops every
   * comment; MX keeps `<!-- -->` and treats `//` as author-only.
   */
  keepComments?: boolean;
}

/** Backwards-compatible name for a host's lowering declarations. */
export type Policy = HostDeclarations;
