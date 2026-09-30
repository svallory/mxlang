/**
 * Event invoker base for hand-written Angular components.
 *
 * A template MX emits for a page calls `__mxOn(handler, receiver, $event)` and
 * `__mxOnAt(object, 'key', $event)` on the component, so a 0-, 1- or 2-arg
 * `(event, element)` handler type-checks under `strictTemplates`. A page's
 * class is the author's, so it has to carry those two members: either paste
 * the text the build prints, or extend `MxHandlers` (or wrap the class it
 * already extends in `MxHandlersMixin(Base)`) and write nothing.
 *
 * This module has no imports on purpose, in source and in the built output: it
 * is safe to bundle into a browser application, and pulls in none of the
 * compiler. It is the one part of the package application code may import, so
 * the package must then be a production dependency, not a dev dependency.
 * The members are the same ones the build injects into a component, with the
 * same semantics; keep them in step with the injected text.
 *
 * @module
 */

/** A handler as Marko types it: `(event, element) => unknown`, or absent. */
type Handler<E, R> =
  | ((event: E, element: EventTarget | null) => R)
  | null
  | undefined
  | false;

/** Calls `handler` with `receiver` as `this` and `(event, currentTarget)`; a falsy handler is a no-op. */
const on = <E, R>(
  handler: Handler<E, R>,
  receiver: unknown,
  event: E,
): R | undefined =>
  handler
    ? handler.call(
        receiver,
        event,
        (event as { currentTarget?: EventTarget | null } | null)
          ?.currentTarget ?? null,
      )
    : undefined;

/** `__mxOnAt` for `owner`: reads `object[key]` and calls it through `owner.__mxOn`, so an override of that is honoured. */
const onAt =
  (owner: { readonly __mxOn: typeof on }) =>
  <K extends PropertyKey, E, R>(
    object: { [P in K]?: Handler<E, R> },
    key: K,
    event: E,
  ): R | undefined =>
    owner.__mxOn(object[key], object, event);

/**
 * Base class carrying the event invoker members.
 *
 * @example
 * ```ts
 * import { MxHandlers } from "@mxlang/angular/runtime";
 *
 * @Component({ selector: "app-form", templateUrl: "./form.html" })
 * export class FormComponent extends MxHandlers {}
 * ```
 */
export class MxHandlers {
  /**
   * Calls a handler with `receiver` as `this` and `(event, element)`.
   *
   * @internal Called by generated templates; not part of the authoring API.
   */
  readonly __mxOn = on;

  /**
   * Calls `object[key]` as a handler, with `object` as `this`.
   *
   * @internal Called by generated templates; not part of the authoring API.
   */
  readonly __mxOnAt = onAt(this);
}

/**
 * The same members as `MxHandlers`, for a component that already extends a
 * class: `class FormComponent extends MxHandlersMixin(Base) {}`. The base's
 * constructor arguments, members and `instanceof` are unchanged.
 */
export function MxHandlersMixin<
  // biome-ignore lint/suspicious/noExplicitAny: a mixin base must accept any constructor signature
  TBase extends new (
    ...args: any[]
  ) => object,
>(Base: TBase) {
  return class extends Base {
    /**
     * Calls a handler with `receiver` as `this` and `(event, element)`.
     *
     * @internal Called by generated templates; not part of the authoring API.
     */
    readonly __mxOn = on;

    /**
     * Calls `object[key]` as a handler, with `object` as `this`.
     *
     * @internal Called by generated templates; not part of the authoring API.
     */
    readonly __mxOnAt = onAt(this);
  };
}
