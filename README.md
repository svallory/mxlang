# MX

MX (Markup eXtended) is a template language born from Marko. It takes Marko's syntax and brings it to wherever JSX lives today, letting each **host** decide what state, reactivity, and output mean. MX 1.0 is a strict subset of Marko: every MX file is a valid Marko file, which is what lets MX borrow Marko's parser, formatter, and grammar. `.mx` is the official and only whole-template extension; porting a Marko component that stays within the subset is a rename. SolidMX (codename "Fluid", `.solid.mx`) is the Solid host: MX in JSX's position inside Solid component files.

Custom tags let a project define its own portable markup vocabulary in `tags/x.mx` or `tags/x.tag.ts`. They are discovered without call-site imports and expand to ordinary IR before any host emits. See the [custom-tag guide](apps/docs/docs/custom-tags/index.md).

## Packages

| Package | npm name | Purpose |
|---|---|---|
| `packages/parser` | `@mxlang/parser` | `@babel/parser` fork: MX in expression position -> lowered JSX AST (the language) |
| `packages/tooling/babel-plugin` | `@mxlang/babel-plugin` | `parserOverride` -> parser |
| `packages/tooling/typescript-plugin` | `@mxlang/typescript-plugin` | `@volar/typescript` plugin; virtual `.tsx` via `@babel/generator` source maps |
| `packages/tooling/tsc` | `@mxlang/tsc` | `tsc` wrapper (`runTsc`) so CI type-checks `.solid.mx` |
| `packages/editors/vscode` | `@mxlang/vscode` | VS Code extension: language client, TextMate grammars, and `typescriptServerPlugins` manifest |
| `packages/tooling/eslint-plugin` | `@mxlang/eslint-plugin` | MX-specific lint rules (parser is `@babel/eslint-parser` + `babel-plugin-mx`) |
| `packages/tooling/vite-plugin` | `@mxlang/vite-plugin` | Vite transform: prints `.solid.mx` to JSX text ahead of `@solidjs/vite-plugin` (the primary integration) |
| `packages/core` | `@mxlang/core` | The Marko-node consumer every MX host is built on: structural and custom-tag lowering, the host declarations contract, stateful-tag hooks, and the `compileSource`/`parseFragment` front doors. Depends on `@marko/compiler` alone. |
| `packages/hosts/html` | `@mxlang/html` | The vanilla MX host on `@mxlang/core`: `.mx` files compile to a pure `(input) => string` function, no runtime beyond an `escape` helper, as a `config.translator` for `@marko/compiler`. MX 1.0 is a strict subset of Marko syntax (decision 72), so this is Marko syntax, unmodified — no fork. |
| `packages/hosts/astro` | `@mxlang/astro` | The Astro host: an integration plus a renderer that renders `.mx` components to static markup at build time, with no islands and no client JS. Astro's slots (already-rendered HTML strings) map to MX's `content`/attribute-tag thunks; stateful tags are compile errors, since this host has no reactive target (decision 71). |
| `packages/hosts/preact` | `@mxlang/preact` | The Preact host: a `.mx` template compiles to a Preact component module in JSX text. The first host whose target has no control-flow components at all — `<if>` becomes a ternary chain and `<for>` a `.map` with a `key`, exactly as a Preact author would write them. Ships `MxErrorBoundary`/`MxPlaceholder` for `<try>` (Preact has no built-in error boundary) and a `Target` object so a React host can reuse the emitter rather than fork it. |
| `packages/hosts/react` | `@mxlang/react` | The React target on the shared Preact/React JSX emitter: `className`/`htmlFor`, native React Fragment and Suspense, and a React class error boundary for `<try>`—no Preact compat layer. |
| `packages/hosts/hono` | `@mxlang/hono` | The Hono target on the shared JSX emitter: native `class`/`for`, and `<try>` lowers straight to `hono/jsx`'s own built-in `ErrorBoundary`/`Suspense`—no hand-rolled boundary class needed, unlike Preact/React. Ships a Bun loader (`@mxlang/hono/bun`) for a plain Bun server with no bundler. |
| `packages/tooling/language-server` | `@mxlang/language-server` | Diagnostics-only LSP server for MX hosts (decision 71/72): publishes one `Diagnostic` per host-policy `TranslateError` (e.g. `<let>` under a `strict` policy) that Marko's own language server cannot see. Runs alongside Marko's server, never in place of it — no completion, hover, or go-to-definition. |

**Naming TODO**: the `@mxlang/*` scope and these short names are placeholders. Final npm names are undecided (see `notes/index.md` in the space root, "Naming on npm").

## Pinned versions

All dependencies below are pinned to an exact version (no `^`/`~`) at the root `package.json`. Reason: `parser`'s output must be byte-reproducible wire format between the parser, the Babel plugin, and the TS plugin's virtual-file generator — a transitive semver bump in Babel or the TS compiler could silently change AST shape or emitted output and break that guarantee without warning.

| Package | Version |
|---|---|
| `@babel/parser` | 7.29.8 |
| `@babel/core` | 7.29.7 |
| `@babel/generator` | 7.29.8 |
| `@babel/traverse` | 7.29.8 |
| `@babel/types` | 7.29.8 |
| `htmljs-parser` | 5.15.0 |
| `@marko/compiler` | 5.42.5 |
| `solid-js` | 2.0.0-rc.7 |
| `@solidjs/web` | 2.0.0-rc.7 |
| `@solidjs/babel-plugin` | 2.0.0-rc.7 |
| `@solidjs/compiler` | 2.0.0-rc.7 |
| `typescript` | 6.0.3 |
| `vitest` | 3.2.7 |
| `@biomejs/biome` | 2.5.12 |
| `@babel/preset-typescript` | 7.29.7 |
| `@types/node` | 26.5.1 |
| `@types/babel__core` | 7.20.5 |
| `@types/babel__generator` | 7.27.0 |
| `charcodes` | 0.2.0 |
| `@babel/helper-validator-identifier` | 7.28.5 |
| `@types/charcodes` | 0.2.2 |
| `@types/babel__helper-validator-identifier` | 7.15.2 |
| `@types/babel__generator` | 7.27.0 |
| `vite` | 8.2.2 |
| `playwright` | 1.63.0 |
| `marko` | 6.3.51 |
| `@marko/compiler` | 5.42.5 |
| `@marko/runtime-tags` | 6.3.51 |
| `parse5` | 7.3.0 |
| `react` / `react-dom` | 19.3.0 |
| `@vitejs/plugin-react` | 6.1.1 |
| `hono` | 4.6.20 |

`marko`/`@marko/compiler`/`@marko/runtime-tags`/`parse5` are pinned in `packages/oracle/package.json`, not the root — they are only a dev dependency of the `oracle:marko` parity check (decision 51), not of the language itself. `@marko/compiler`'s own version numbering is decoupled from the Marko language version; 5.42.5 is the compiler release that ships Marko 6's translator (`marko/translator`) and is what `marko@6.3.51` itself depends on. `parse5` is `oracle:marko`'s HTML parser for semantic (decoded-content) comparison rather than raw-string comparison, pinned to the version already resolved transitively through `@solidjs/babel-plugin`'s own dependency on it.

The last four entries are build-only dependencies of `packages/parser`'s
vendored `@babel/parser` source (`@babel/parser`'s own runtime deps, which
npm's published bundle doesn't need to declare since Babel's build inlines
them) — see `packages/parser/README.md` and `UPSTREAM.md`. A fifth such
dependency, `@babel/helper-string-parser`, is vendored as source instead of
installed as a package (see `UPSTREAM.md`'s "Local modifications"); its
pinned version (7.27.1) is recorded there, not here, since there's no
`package.json` entry for it.

Note: Babel 8 (8.0.x) and TypeScript 7 (7.0.x) were released but are new majors; the spec's parser fork targets Babel 7's `parserOverride`/JSX-plugin shape, so this scaffold pins the latest stable Babel 7 line. TypeScript is pinned to the 6.0 line for a harder reason: TS 7 removes `compilerOptions.plugins` entirely, which is the extension point `@mxlang/typescript-plugin` is built on — see `notes/investigations/ts7-go-impact.md`.

The two tooling packages that load TypeScript at runtime (`@mxlang/tsc`, `@mxlang/typescript-plugin`) declare it as a `peerDependencies` range (`>=5.9.0 <7`) rather than an exact pin, since a peer is resolved from the consumer's own project; the exact pin above is what this repo builds and tests against. `@mxlang/language-server` declares no peer — TypeScript is only its build tool. See `AGENTS.md` "Exact-pin policy".

### Solid 2 RC policy

SolidMX targets **Solid 2 only**. `babel-preset-solid` and `vite-plugin-solid`
are dead ends: the live packages are `@solidjs/babel-plugin` and
`@solidjs/vite-plugin`, and `@solidjs/compiler` (native Oxc) is the default
backend. Solid 2 is pre-stable — `solid-js`'s npm `latest` is still 1.9.15
and 2.0 lives under the `next` tag, with RCs shipping weekly.

Policy: **pin one RC and stay on it.** Re-sync
`notes/research/solid-2-impact.md` on each bump we choose to take; do not
chase every RC. A milestone in flight finishes against its pinned RC even if
a newer one lands mid-milestone.

## Scripts

Runnable via `bun run <name>` or `moon run :<name>`:

- `typecheck` — `tsc --noEmit` per package and per example
- `test` — `vitest run`
- `lint` — `biome check .`
- `verify` — typecheck, then lint, then build, then test; stops on first failure. Includes `build` so `vendored.test.ts`'s dist-equivalence pass always runs against a fresh `dist/index.js`, not just the pre-build TS source.
- `build` — builds `packages/parser`'s vendored parser to `dist/index.js`
- `oracle` — runs only the oracle/golden harness (`packages/oracle`) and prints a fixture/variant/status summary

## Try it

Runnable Solid 2 apps whose components are written in MX:

```
cd examples/counter-app && bun run dev
cd examples/todomvc && bun run dev
```

`bun run build` builds them, and `bun run e2e` drives the dev server and the
production build through a headless Chromium (needs `bunx playwright install
chromium` once). The e2e suite is not part of the root `bun run test` — it
needs a browser — so it stays behind the example's own script.

`examples/mx-site` is a different kind of example: a Hono-on-Bun server
rendering MX (`.mx`) templates to HTML strings with `@mxlang/html`, no
client runtime and no Solid. It imports these files
directly via `@mxlang/html/bun` (no prebuild step). See
`examples/mx-site/README.md`.

`examples/mx-vite` is a minimal static-site build: two `.mx` pages compiled
by `@mxlang/vite-plugin`, bundled by `vite build`
to an SSR entry, then run once to write `dist/*.html`.

`@mxlang/html` needs no app at all — it renders a fixture to stdout,
showing the stock `.marko` template, the compiled runtime-free module, and
the HTML it produces:

```
cd packages/hosts/html && bun run example
cd packages/hosts/html && bun run example nested-layout
```

```
cd examples/mx-vite && bun run build
```

`examples/astro-static` is the Astro host's example: an Astro site with `.mx`
components (props, a default slot, a named slot, one
component composed from another) and, per decision 76b, `.mx` files directly
under `src/pages` as pages — one through a layout with a `static`-block props
and `<if>`/`<for>`, one with no layout writing its own full document, and a
dynamic `posts/[slug].mx` with `getStaticPaths`. It also covers `.amx`
(decisions 76c/78) — an Astro component whose *template* is MX, lowered to
Astro's own template syntax: a page, a layout and two components, exercising
props from the `---` fence, named slots, `class:list`, `<if>`/`<else if>`/
`<else>` and `<for>` with an index. Every page is prerendered with
`output: "static"` and ships no client JS at all.

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run e2e        # headless Chromium over dist/, plus the two error builds
```

`examples/preact-app` is the Preact host's example: a Vite app whose
components are `.mx`, with hook state through `<const>`, event handlers, a
structured `class`, and a `<for>` loop, mounted by a small `.tsx` entry
point. The host is selected by `package.json`'s `"mx": { "host":
"preact" }` alone — the same field the language server and `mx-tsc` read.
Its e2e drives a real Chromium against the production build and clicks the
counter, which is the one claim neither the unit tests (emitted JSX text) nor
the oracle (rendered HTML) can make: that the result is a live component.

```
cd examples/preact-app
bun run build      # vite build -> dist/
bun run e2e        # headless Chromium over the built app
```

`examples/react-app` is the corresponding native React target: `.mx`
components use `useState` through `<const>`, React event handlers, structured
classes, and `<try>` backed by a React class boundary. Its Chromium e2e clicks
the live counter and verifies a thrown child error is caught.

```
cd examples/react-app
bun run build
bun run e2e
```

`examples/hono-app` is the Hono target's example: a Hono-on-Bun server (no
bundler) rendering one `.mx` page with a `<for>` list and two `<try>` blocks,
loaded via `@mxlang/hono/bun`'s Bun plugin. Its Playwright e2e fetches the
live server and asserts the rendered list, the non-throwing `<try>` branch,
the branch Hono's built-in `ErrorBoundary` catches, and that the response
ships no client hydration script — Hono's default server render is plain
HTML, unlike Preact's/React's client-hydrated hosts.

```
cd examples/hono-app
bun run dev &      # or: bun run e2e starts and stops its own server
bun run e2e
```

## Editors

`packages/editors/zed` ships three languages for Zed: `MX` (`.mx`) and
`AstroMX` (`.amx`), both backed by the unmodified `marko-js/tree-sitter`
grammar, and `SolidMX` (`.solid.mx`), backed by `packages/editors/tree-sitter-solidmx`.
See its `README.md` for dev-install steps, the per-language limitations, and
the upstream bump procedure.
