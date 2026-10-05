# @mxlang/vite-plugin

- **Docs (render-consumers, decision 155):** the comment on the Astro page pipeline describes the default export as `(input) => string`, not `{ value, output }`.

## 0.1.0 (unreleased)

- **Changed (bridge-host, decision 154):** the default `extensions` are the registry's region file kinds then `.mx` (`defaultExtensions()`, today `.solid.mx, .mx`), resolved lazily by the async hooks; a user's `extensions` still replaces them. A region file is printed with `mx: true` and lowered by the region entry its suffix names, not by the first region kind. Behaviour change: a user-listed extension no region kind serves (`extensions: [".foo.mx"]`, or an opt-in `".astro.mx"`) used to compile through Solid's region entry; it is now the error `no registered host compiles MX regions for "<file>"`. Region kinds are looked up in the file's project lookup (`lookupFor(policy)`), as the language server does.

- **Added (default-tag-ladder, decision 145):** the package's `defaultTag` reaches the page compile and each `.solid.mx` region.

- **Fix (translate-error-callee-file):** a callee syntax error's build header uses the callee file together with its coordinates, not the caller's authored id. Its message stays compact, carrying one caret reason per frame so an aggregate callee's later reasons are not lost; the overlay frame is built from the callee source. Build-render headers print 1-based columns (#227); the transform/overlay's structured `loc.column` stays 0-based.

- **Fix (vite-virtual-tsx-id):** a failing `vite build` now names the **authored** file in its error header. Rolldown builds that line (`[plugin mx] <id>:L:C`) from the *module* id and stamps it itself — `TransformPluginContextImpl.error` does `e.id = this.moduleId` — so a compile error in `page.mx` printed `page.mx.tsx:1:0`, a path that does not exist on disk, and neither the plugin's own `id`/`loc.file` nor `this.error({ id, loc })` could change it (verified on rolldown 1.2.8 / vite 8.2.2, this repo's pins). A `buildEnd` hook now re-labels those diagnostics before rolldown aggregates and formats them:

  ```text
  [plugin mx] /…/src/page.mx:1:0
  CompileError: Missing ending "div" tag
  ```

  - Deliberately narrow: only this plugin's own errors (`plugin: "mx"`), and only those rolldown still formats from `id`/`loc.file`. A diagnostic rolldown rendered itself (`[builtin:vite-transform]`, `[PARSE_ERROR]`) carries a `kind`, has no `id`, and bakes the generated path into an already-formatted message at a position in *generated* text; the `.mx` path has no source map, so those keep the generated name rather than print a real file with a line that is not in it.
  - Only ids this plugin minted are renamed (`isMxModule`/`sourcePath`, the same pair the rest of the plugin uses), and every write is guarded: a diagnostic that cannot be re-labelled still fails the build, with the generated name.
  - The dev server is unchanged and needed nothing: the plugin's error reaches Vite with the authored `id`.
  - The module id itself is unchanged. Dropping the virtual `.tsx` suffix (with a `moduleType: "tsx"` hint, which does fix the parse) was measured and rejected: `@solidjs/vite-plugin`'s `transform` gate is the extension (`/\.[mc]?[tj]sx$/`, `.tsrx`, or listed in `options.extensions`), so `.solid.mx` and Solid-host `.mx` would need `solid({ extensions: ['.mx'] })`, breaking the documented zero-config `plugins: [mx(), solid()]`; rewriting from `renderError` is ignored by rolldown. Details in `AGENTS.md`.

- **Added (third-party-target, registration PR 7):** the transform compiles through a target loaded from `package.json#mx.target` / `mx.host` (the project's lookup, `lookupFor(policy)`); a failed load fails the transform with the positioned `package.json:line:col: <message>` error through the existing policy-error path.

- **Changed (refactor/vite-plugin, decisions 129 and 132):** whole-file `.mx`
  compilation dispatches through `@mxlang/target-registry` (`load(core).compileModule`
  with the full built-in lookup) instead of branching on host names, and
  `.solid.mx` uses the registered region pipeline. Build strictness,
  `resolveImport`, mapping absence and the unwired-Angular message now come
  from the descriptor, so Vite's own behaviour is unchanged.

- **Changed (build/vite-plugin):** the package ships a bundled `dist/`
  (`main`/`exports`/`types`). Descriptor `load()` needs a bundler, and a
  source-loaded plugin raised `ERR_AMBIGUOUS_MODULE_SYNTAX` under native Node;
  the ESM entry is a facade over a relocatable CJS bundle, which keeps every
  heavy compiler lazy. Importing the plugin still loads no compiler.

- **Fix (vite-plugin-colored-marko-header):** under `FORCE_COLOR=1` kleur colourises Marko's `at <path>:L:C` header (and the reason `label`), so the position regex missed the header and a Marko `CompileError` printed `page.mx.tsx:undefined:undefined` with ANSI still in the message. SGR runs are stripped before the position is parsed (`markoPosition`) and before `label` becomes the printed message, matching what `@mxlang/language-server`'s `splitCodeFrame` already does.

- **Added (target-select, decisions 129/132):** `mx.target` selects its host
  behaviour. Invalid targets and host/target mismatches fail transforms via
  `this.error`, with the manifest's value position and a code frame; repeat
  transforms cannot turn an error into a warning or a silent pass. Existing
  host warnings remain unchanged. Explicit `data` reports the registry's
  decision 131 addendum restriction naming `parseData` and the tooling TODO.

- **Changed (refactor/target-open-set, decisions 129 and 132):** host policy and scanning go through `@mxlang/target-registry`'s wrappers over the built-in lookup (a dynamic import, so the plugin's config-loading discipline is unchanged), and `mx.tags[].hosts` is matched on `hostFilterKey(policy.target)` — the same string as before for every built-in. Every compile carries the built-in lookup. An unknown bare word in `mx.tags[].hosts` still warns through `warn()`; a package specifier no longer does.

- **Changed (amx-to-astro-mx, decision 134):** `x.astro.mx`, Astro's template kind, is declined by `mx()` (it joins the foreign-extension guard), so a registered `.mx` does not claim it.

- A Marko mismatched-closing-tag error now reports the opener's position in its reason (`… opening "p" tag at 3:3`), through core. Test expectation updated; no plugin code changed.

- **Fix (audit-05-vite-unresolved-import, audit cases h15, p10, s11):** an import in an authored `.mx` / `.solid.mx` file that nothing resolves (a missing `./card.mx`, a missing `./helper.ts`, a package that is not installed) now fails `vite build` and the dev server against the authored file and the import's own line:col, with a one-line code frame:

  ```
  [plugin mx] …/src/page.mx:1:17
  Error: Could not resolve "./card.mx"
  1 | import Card from "./card.mx";
                       ^
  ```

  It used to name the generated `page.mx.tsx` at a position in generated text (rolldown's `UNRESOLVED_IMPORT`), which an author could not map back.

  - `resolveId` asks the rest of the resolver chain about each import written in an MX module and raises the error only when nothing resolves it; a resolvable import resolves exactly as before, and an `external` one is still external. The position is found by searching the authored source for the specifier, because the `.mx` path has no source map. An import the emitter added (not written by the author) is left to rolldown.
  - Also covers a `tags/*.mx` tag's own imports (the error names the tag file) and the `.marko` tag import.
  - The column is 0-based like every other `loc` this plugin raises (`1:17` where `mx-tsc` prints `1:18`).
  - In the dev server, Vite rewrites an error raised while an importer is being transformed (it maps `err.loc` through the importer's sourcemap and re-attributes the error to `vite:import-analysis`), which turned the authored position into a generated one; this error carries the authored source as `pluginCode` and `plugin: "mx"`, which makes Vite leave it alone.
  - The import is found by a small lexer over the authored source, so the same text in a comment or a string above the real import is ignored; a CRLF file's code frame has no `\r`. A resolvable import is returned as resolved, so later resolvers run once per import.

- **Fix (audit-04-vite-tags-marko, audit case h18):** a page that calls a `tags/*.marko` tag now builds under `vite build` and the dev server. It used to pass `mx-tsc` and the language server, then fail the build with `PARSE_ERROR Unexpected JSX expression` at `tags/<tag>.marko:1:1`, because every host emits Marko's `import _badge from "./tags/badge.marko"` (#187) and nothing in the plugin handled a `.marko` module.

  - The plugin now claims a `.marko` import **only when an MX module (or a tag it already claimed) imports it**, and compiles the tag through the same whole-file path as a page, so a tag takes the host of its own nearest `package.json`. This is parity with Marko's auto-discovery of `tags/*.marko`; there is no new option or dependency. `@marko/vite` is not used: it emits Marko runtime templates, not the `(input) => string` / component function the emitted call expects.
  - Fixed for the `html`, `preact`, `react` and `hono` hosts (all four failed before). A Solid whole-file `.mx` does not discover `tags/*.marko` at all; that is outside this plugin.
  - `extensions: [".marko"]` is still rejected: `.marko` is never claimed on its own.
  - A syntax error inside a tag file is reported at the tag (`…/tags/bad.marko:1:15`), compact, like any other compile error (see audit-03 below).

- **Fix (audit-03-vite-errors):** a compile error in an authored `.mx` / `.solid.mx` file (`TranslateError`, Marko `CompileError`, Babel parse error) no longer carries the translator/Babel/rolldown stack, and a Marko `CompileError` no longer prints `undefined:undefined`. Over the agent-feedback corpus a failing `vite build` drops from ~1,450 to ~460 tokens. Errors that are bugs in mx itself keep their stack.

  What a failing `vite build` prints now:

  ```
  [plugin mx] /abs/path/src/pages/page.mx.tsx:4:0
  CompileError: The closing "div" tag does not match the corresponding opening "p" tag
  4 | </div>
      ^
  ```

  - The **header line** (`[plugin mx] …page.mx.tsx:4:0`) still names the virtual `.tsx` module: rolldown builds it from the module id, and `this.error({ id, loc })` does not change it (rolldown 1.2.8). The line is right; the file name carries a `.tsx` suffix. Line is 1-based, column is 0-based.
  - The **error's `id` and `loc.file`** (what the dev-server overlay and any programmatic consumer read) are the authored path `…/page.mx`.
  - Vite's own CLI still prints ~7 frames of its own stack under the error.
  - Tracked separately: dropping the virtual `.tsx` suffix (TODO `vite-virtual-tsx-id`).
