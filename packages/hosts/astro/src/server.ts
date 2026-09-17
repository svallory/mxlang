/**
 * `@mxlang/astro`'s renderer server entrypoint.
 *
 * Astro loads this module by the `serverEntrypoint` the integration registers
 * and calls `check` on every component it renders until a renderer claims it,
 * then `renderToStaticMarkup` on the one that did. There is deliberately no
 * client entrypoint: an MX component compiled by `@mxlang/html` is a
 * `(input) => string` function with no runtime, no state and nothing to
 * hydrate, so there is nothing to ship to a browser. Astro itself raises
 * `NoClientEntrypoint` when an author puts `client:*` on such a component,
 * which is the error we want and is pinned by a test in the example.
 */

/**
 * The compiled shape every MX template's default export has.
 *
 * The brand is deliberately not part of this type: it is what `check` *tests
 * for*, not something a caller must prove up front, and requiring a symbol
 * index signature here would reject the very functions the translator emits
 * (a plain function declaration has no such signature structurally).
 */
type MxComponent = (input: Record<string, unknown>) => string;

/**
 * The brand `@mxlang/html`'s `postEmit` writes onto the default export.
 *
 * Looked up through the global registry (`Symbol.for`) rather than imported:
 * the property is written by a compiled module and read here, and the two may
 * come from different copies of the translator on disk. Astro's own docs
 * suggest sniffing `Component.name` instead, which a minifier may rewrite and
 * any function could collide with.
 */
const MX_COMPONENT = Symbol.for("mx.component");

/**
 * Claims a component for this renderer.
 *
 * The brand and nothing else: no name sniffing, no duck-typing of the call
 * signature — every `(props) => string` function in the project would pass
 * that, and claiming another renderer's component would render it wrong
 * rather than fail.
 */
export async function check(Component: unknown): Promise<boolean> {
  return (
    typeof Component === "function" &&
    (Component as unknown as Record<symbol, unknown>)[MX_COMPONENT] === true
  );
}

/**
 * Astro's per-render metadata, to the depth this file reads it.
 *
 * Declared locally for the same reason the integration's types are: `astro`
 * stays a devDependency here rather than a hard runtime dependency of every
 * consumer. The two fields below are `AstroComponentMetadata`'s own
 * (`astro/dist/types/public/internal.d.ts`), and Astro passes the object as
 * `renderToStaticMarkup`'s fourth argument at both of its call sites
 * (`dist/runtime/server/render/component.js`).
 */
interface AstroComponentMetadata {
  displayName: string;
  hydrate?: "load" | "idle" | "visible" | "media" | "only";
}

/**
 * Renders an MX component to static markup.
 *
 * Astro hands slots in as `Record<string, string>` of **already-rendered
 * HTML**, while MX's compiled modules receive children and attribute tags as
 * `() => string` thunks (`content` for ordinary children, the tag's own name
 * for each `<@name>`). The mapping is therefore: wrap each slot string in a
 * thunk that returns it.
 *
 *     <Card title="Hi">            ->  Card({ title: "Hi",
 *       default slot content            content: () => "<p>…</p>",
 *       <Fragment slot="footer">        footer: () => "<small>…</small>" })
 *
 * Two limits follow from slots being strings, both inherent to Astro's
 * contract rather than to MX:
 *
 * 1. **Attribute-tag params get nothing.** A component whose template writes
 *    `<@footer|year|>` compiles to a `footer: (year) => string` the parent
 *    calls with an argument; a slot from Astro is already rendered, so the
 *    thunk ignores every argument it is handed. Astro has no channel for
 *    passing a value back into a slot, so this is documented rather than
 *    detectable here: the renderer sees a compiled function, not the template
 *    that declared the params.
 * 2. **Slot HTML is inserted verbatim.** Astro rendered it, so it is markup,
 *    not text to escape — the thunk returns the string unchanged, which is
 *    exactly what MX does with a nested template's own output.
 */
export async function renderToStaticMarkup(
  Component: MxComponent,
  props: Record<string, unknown>,
  slots: Record<string, string>,
  metadata?: AstroComponentMetadata,
): Promise<{ html: string }> {
  // `client:*` on an MX component is an error, and this host raises it.
  //
  // Astro will not: its `NoClientEntrypoint` message is defined in
  // `dist/core/errors/errors-data.js` and thrown from nowhere in 7.3.2 (the
  // render path is a bare `if (renderer.clientEntrypoint)` at
  // `dist/runtime/server/hydration.js:98` with no else branch). Left alone,
  // the build succeeds and ships an `<astro-island client="load">` whose
  // loader falls back to a no-op hydrator — an island that silently does
  // nothing, on a host whose whole claim is shipping no client JS.
  //
  // Decision 70's intent is that the directive is an error, so the failure is
  // raised here rather than left to be discovered in a bundle. `metadata` is
  // Astro's own fourth argument and `hydrate` holds the directive's value
  // (`load`, `idle`, `visible`, `media` or `only`).
  if (metadata?.hydrate) {
    throw new Error(
      `\`${metadata.displayName}\` is an MX component and renders statically: ` +
        `remove the \`client:${metadata.hydrate}\` directive. MX compiles to a ` +
        "plain function with no state and no runtime, so there is nothing to " +
        "hydrate on the client.",
    );
  }

  const input: Record<string, unknown> = { ...props };

  for (const [name, html] of Object.entries(slots ?? {})) {
    // `default` is MX's ordinary children, which the compiler names
    // `content`; every other slot is an attribute tag of the same name.
    input[name === "default" ? "content" : name] = () => html;
  }

  // A unit that declares `<return>` hands back `{ value, output }` rather
  // than the output alone (design §3.3). Astro renders the markup and has
  // nowhere to put the value — an `.amx` template has no statement position
  // to bind one in, and `/var` there is refused for that reason — so the
  // output half is what renders. Unwrapped here rather than at the call
  // site, because Astro calls the component itself.
  const rendered = Component(input) as string | { output: string };
  return {
    html: typeof rendered === "string" ? rendered : (rendered?.output ?? ""),
  };
}

export default { check, renderToStaticMarkup };
