# examples — agent instructions

## Examples

`examples/counter-app` is a Solid 2 app whose components are `.solid.mx`.
`examples/todomvc` is the canonical TodoMVC app (todomvc.com spec), also
entirely in MX: `App.solid.mx` (state, hash-routed filter, localStorage
persistence), `TodoItem.solid.mx` (toggle, double-click-to-edit, destroy),
`Footer.solid.mx` (count, filters, clear-completed). Root `package.json`
`workspaces` includes `examples/*`, so `@mxlang/vite-plugin` and
`@mxlang/tsx-bridge` resolve as workspace deps, and root `typecheck` covers
`examples/*/` as well as `packages/*/`.

Solid 2's `createEffect` requires **two** arguments — a compute function and
an effect function (`createEffect(() => signal(), value => doWork(value))`).
The single-callback Solid 1 form (`createEffect(() => { ... })`) throws
`MISSING_EFFECT_FN` at runtime and halts the reactive system. This is a Solid
2 API change, not an MX lowering issue — MX passes `createEffect` calls
through untouched.

```
cd examples/counter-app
bun run dev        # dev server
bun run build      # production build
bun run e2e        # headless Chromium against dev server + built output
```

`bun run e2e` needs `bunx playwright install chromium` once. It is wired to
the example's own vitest config (`e2e/vitest.config.ts`) and is deliberately
outside the root `bun run test`, whose `projects` glob is `packages/*`.
`examples/astro-static`'s e2e is the exception to "outside CI": the
`astro-static-e2e` job in `.github/workflows/ci.yml` runs it and is a
`verify` dependency, because it is the only lane that renders an `.astro.mx`
page through Astro's own compiler.

`e2e/resolve.spec.ts` is left out of that config and run on demand with
`vitest run --config e2e/vitest.config.ts e2e/resolve.spec.ts`: all four of its
assertions pass, but closing a Vite dev server inside vitest never settles, so
the file reports a hook timeout after two minutes. The hang is in that
teardown, not in the plugin — the same `server.close()` returns in ~1ms outside
vitest, and `counter.spec.ts`/`hmr.spec.ts` close their own dev servers in
seconds.

Pin policy for examples: an example pins its own Solid 2 RC versions exactly
in its own `package.json` (`solid-js`, `@solidjs/web`, `@solidjs/vite-plugin`),
independent of the root pins, which still track Solid 1 for the oracle's
`babel-preset-solid` comparison. Root and example pins are expected to
disagree; do not "fix" one to match the other.

Type-checking `.solid.mx` imports from `.tsx` uses
`@mxlang/typescript-plugin`'s virtual-`.tsx` projection (spec section 7.2,
decision 81), loaded through `compilerOptions.plugins` in each example's
`tsconfig.json`. The old ambient `src/mx.d.ts` shims are **deleted** and must
not come back: a shim asserts types instead of deriving them, so it hides both
each file's real exports and every error inside the file. Each example's
`typecheck` script is `mx-tsc --noEmit`, not `tsc --noEmit` — `tsc` ignores
`compilerOptions.plugins`.

`examples/mx-site` is a plain-string example: a Hono-on-Bun server and a
static build both rendering MX (`.mx`) templates via
`@mxlang/target-html/bun` (the Bun loader — see `packages/targets/html/AGENTS.md`), no
Solid, no client runtime, no prebuild step. `src/server.ts` and
`src/build.ts` `import renderX from "./pages/x.mx"` directly, exactly like
any other module; `bunfig.toml` preloads the loader.

`packages/targets/html/tsconfig.json` maps `@mxlang/tsx-bridge` to
`../tsx-bridge/src/public.d.ts` in its `paths`, for typechecking against the
parser's public types without requiring `dist/` to be built first. Bun's
`bun run` also honours `tsconfig.json` `paths` at runtime, and does so per
imported file's own directory, not just the entry point's — so a plain `bun
run` of any script that imports `@mxlang/target-html` (which imports
`@mxlang/tsx-bridge`) fails with `Export named 'X' not found in module
".../public.d.ts"`, because Bun resolves the bare `@mxlang/tsx-bridge` specifier
against `packages/targets/html/tsconfig.json`'s `paths` regardless of where the
importing file lives. Work around it with `bun run
--tsconfig-override=<path to a tsconfig with no such paths>`; `examples/mx-site`'s
`dev` and `build` scripts do this against the root `tsconfig.base.json`. This
is a property of `translator`'s tsconfig, not a bug in `@mxlang/target-html`
itself or in Bun's resolver generally — vitest is unaffected because it does
not resolve bare specifiers through `tsconfig.json` `paths` the same way.

`examples/astro-static` is the Astro host's example: an Astro 7.3.2 site
(`output: "static"`, pinned exact in its own `package.json`) with `.mx`
components — props and a default slot, a named slot, and one component
composed from another — and, per decision
76b, `.mx` **pages** directly under `src/pages`: `mx-page.mx` (a `layout`
export, props from a `static` block, `<if>`, `<for>`), `no-layout.mx` (no
`layout`, writes its own full document), and `posts/[slug].mx` (`getStaticPaths`
returning two entries, `prerender = true`).

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run e2e        # headless Chromium over dist/, plus the two error builds
```

Its `e2e/` holds two specs. `pages.spec.ts` builds once, serves `dist/` over a
bare `node:http` server and asserts the rendered HTML (the same Vitest-driving-
raw-playwright shape as `examples/mx-vite/e2e/pages.spec.ts`) for every
component page and every `.mx` page (layout applied, static-block props,
`<if>`/`<for>`, both `getStaticPaths` entries, `input.params.slug` reaching
the dynamic route), including that no page contains a `<script>` — the host's
whole claim. `build-errors.spec.ts` asserts the two builds that must fail:
`<let>` in an MX component (the strict policy) and `client:load` on an MX
component (the renderer's own error, since Astro raises none — see
`packages/hosts/astro/AGENTS.md`). Both pages live in `error-fixtures/`, **outside**
`src/pages/`, and each is copied in for a single build and removed afterwards
— a page that is meant to break the build cannot also be part of the build
every other test depends on. `vitest.config.ts` sets `fileParallelism: false`,
since each spec runs a real `astro build`.

`src/components/stateful.mx` is the component the strict-policy error page
imports, so it cannot compile by design. `tsconfig.json` excludes it:
`mx-tsc` reports a stored compile error as a diagnostic (TS80001), and the
example's typecheck would otherwise fail on the file that exists to fail.

**`.mx` pages** (decision 76b, `packages/hosts/astro/src/index.ts` +
`packages/hosts/astro/src/vite-pages.ts`): the integration calls Astro's
`addPageExtension(".mx")` — `.marko` is not a registered extension for this
integration at all (see "`.mx` is the only template extension" in `packages/tsx-bridge/AGENTS.md`), so
there is no separate question of whether it is a page. A second Vite plugin (`mxPages`,
`enforce: "post"`, scoped to `<srcDir>/pages/`) runs after
`@mxlang/vite-plugin`'s own `.mx` → TS compile in the *same* transform pass
and rewrites the already-compiled module — by the time this stage runs the
bundler has already stripped TypeScript types from the code (measured: no
`: Input`/`: string` annotations survive), so the rewrite injects plain JS,
not TS. It matches `@mxlang/target-html`'s exact branded tail (`function
About(input) {...}; Object.defineProperty(About,
Symbol.for("mx.component"), ...); export default About;` — see
`translate.ts`'s `brandRender`), where the name is the file's own derived
export name and the **same** name in both halves of the tail. The tail is
matched first and the name read out of it; the function declaration is then
anchored on that name, never on "the first function taking `input`" — such
a function can be a hoisted helper or a bundler-inlined tag unit, and
renaming *it* would leave the real render function untouched. It replaces
the tail with an Astro
`createComponent` factory built with Astro's own
`renderTemplate`/`renderComponent`/`unescapeHTML` runtime helpers
(`astro/runtime/server/index.js`), never a hand-rolled factory invocation —
`renderComponent` is the same helper a compiled `.astro` template uses to
call a nested component, so this stays correct if Astro's factory-calling
convention changes shape. `input` is `{ ...props, params: astro.params, url:
astro.url }`, `astro` obtained via `result.createAstro(props, slots)`
(verified against `astro/dist/types/public/internal.d.ts`). A page's `export
const layout = "...";` (a string literal, matched and stripped from the
compiled module) is turned into a real `import` of that `.astro` file, and
every other top-level `export const NAME = ...;` the page declares becomes a
`frontmatter` key passed to the layout, mirroring Markdown's own `layout`
behaviour (`astro/dist/vite-plugin-markdown`).

This rewrite is possible at all only because `@mxlang/core`'s `emitStatement`
(`packages/core/src/core.ts`) now hoists **any** `export` statement — not
only `export interface Input` — to real module scope verbatim, the same way
it already hoists `import`. Before this change, an MX file's TypeScript
section could only ever `export interface Input`; any other top-level
`export` was a hard compile error ("a standalone template may only `export
interface Input`..."). This was a shared-core change (not `translate.ts`'s
`brandRender`, which `oracle-shape` owns) needed so a page's `export const
getStaticPaths = ...`/`export const prerender = ...` can reach Astro's router
as real named exports of the compiled module, exactly as a `.astro` page's
own frontmatter does.

`examples/mx-vite` is a minimal static-site build exercising
`@mxlang/vite-plugin`'s `.mx` handling (not `.solid.mx`): two `.mx` pages
under `src/pages/`, a tiny `src/build.ts` that imports both and writes
`dist/*.html`, and a `vite.config.ts` whose `build.ssr` is that script rather
than a browser entry — `vite build` bundles it through the plugin's
`.mx` transform, then `bun run dist-ssr/build.js` actually runs it
and writes the
HTML. `vite.config.ts`'s `ssr.external: ["@mxlang/target-html"]` keeps that
package's own `import { escape } from "@mxlang/target-html"` (present in
every compiled `.mx` page) out of the rolldown bundle — left un-external,
rolldown would try to bundle `@mxlang/target-html`'s raw TS source itself,
pulling in `@marko/compiler`'s transitive syntax the same way the plugin's
own dynamic `import()` has to route around (see
`packages/tooling/vite-plugin/AGENTS.md`).
