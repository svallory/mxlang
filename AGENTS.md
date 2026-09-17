# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn, with one exception: `packages/hosts/html/scripts/consumer-check.ts` packs tarballs with `npm pack`, because `bun pm pack` hangs on macOS with bun 1.3.14 (it also hangs from a plain shell; PR #51). npm is only that script's packer, never the project's package manager; the node/npm toolchain is pinned in `.prototools` (`node`) and in CI. Toolchain versions are pinned in `.prototools` (`bun`, `moon`, `node`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- delegates straight to `bun run verify`, see below
bun run build       # or: moon run parser:build -- builds packages/parser to dist/
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root (the typecheck loop defers to a package's own `typecheck` script when it has one, which is what lets `examples/counter-app` and `examples/todomvc` run `mx-tsc`, and `examples/astro-static` run `mx-tsc --astro`, while everything else runs plain `tsc`) — so pick one command style (bun or moon) per invocation rather than mixing them. `verify` is the one exception: moon's `verify` task is a single `bun run verify` command, not a `deps` list, because `bun run verify`'s own chain (pre-verify must run before test; the coverage script must run last, after everything else) isn't expressible as an unordered `deps` set — delegating keeps the two entry points from silently drifting into two different definitions of "verified".

## Test Coverage Verification (decision 64)

`verify` (`bun run verify` / `moon run :verify`) proves every non-exception
package's tests actually **ran in that invocation** — not merely that some
test wiring exists for it. This chain runs locally without deadlock, including `consumer-check:html` which checks consumer packing behavior. The chain is:

```
scripts/pre-verify.ts && typecheck && lint && build && test && test:bun && test:grammar && scripts/verify-coverage.ts
```

- `scripts/pre-verify.ts` deletes any evidence left over from a previous run
  (`vitest-results.json`, `packages/editors/tree-sitter-solidmx/.test-ran`) and writes
  `.verify-start` with the current time. All three are gitignored.
- `bun run test` runs vitest (over the root `projects: ["packages/*"]`
  config, which auto-discovers a project per package with test files) with
  `--reporter=json --outputFile=vitest-results.json`.
- `bun run test:grammar` runs `moon run tree-sitter-solidmx:test --force`
  (`tree-sitter-solidmx`'s real test is `scripts/test.sh`, not vitest, so it
  can never appear in the JSON report). `scripts/test.sh` writes
  `.test-ran` as its last step, only on success; `--force` bypasses moon's
  own task cache so a cached "already ran, nothing changed" result can't be
  mistaken for evidence from *this* run.
- `scripts/verify-coverage.ts` (the last step) enumerates all workspace
  packages (`packages/*`, `examples/*`), and for each non-exception package
  reads the evidence directly: a package name parsed out of
  `vitest-results.json`'s test file paths, or (for `tree-sitter-solidmx`
  only) the `.test-ran` marker. Every evidence file's mtime must be `>=`
  `.verify-start`'s timestamp, or it's treated as stale and the package
  fails — there is no code path that marks a package as tested without
  reading its evidence file. Prints a table: package | test wiring | ran,
  and exits non-zero if any non-exception package has no fresh evidence.

Exception packages (no unit test wiring required; verified elsewhere):
- `examples/astro-static` — e2e only
- `examples/counter-app` — e2e only
- `examples/hono-app` — e2e only
- `examples/mx-site` — e2e only
- `examples/mx-vite` — e2e only
- `examples/preact-app` — e2e only
- `examples/react-app` — e2e only
- `examples/todomvc` — e2e only
- `packages/editors/zed` — grammar and Rust extension (registers
  `@mxlang/language-server`), both build-verified in CI
  (`zed-compile-check`, `zed-compile-check`)

Any new package without test wiring must be added to the exception list with
a documented reason, or get a vitest project (a package under `packages/*`
or `examples/*` with its own test files) that emits into
`vitest-results.json`.

## Edit check hook

`.claude/hyper.json` runs Biome formatting checks, then per-package TypeScript type checking via `tsc --noEmit` after every agent edit. Both commands use `./node_modules/.bin` paths directly so they work without shell shims (proto/bun/nvm wrappers).

## Scoped lint exceptions

- `noUnusedImports` and `noUnusedVariables` are disabled for
  `examples/astro-static/**/*.astro`: Biome checks only Astro frontmatter and
  cannot see imports and variables consumed by the template body.
- `noTemplateCurlyInString` is disabled for the exact Astro, core, and
  translator source/test files listed in `biome.json`. Those strings
  intentionally contain Marko `${...}` syntax or generated JavaScript
  template source and must remain ordinary string literals.
- `packages/hosts/html/src/translate.test.ts` keeps
  `noTemplateCurlyInString` enabled at info severity because its existing
  occurrence-level suppressions would become stale if the rule were disabled.
  Biome 2.5.12 does not expose `suppressions/unused` as a configurable rule.
- `useNamingConvention` remains enabled only in
  `packages/core/src/compile.ts` and `packages/core/src/core.ts`, keeping their
  existing visitor-key suppressions active; `noExplicitAny` is disabled only
  there for the compiler adapter's intentional `Node = any`. These two files
  are owned by the parallel core-ir refactor and must not be edited here.

## Exact-pin policy

All dependencies in the root `package.json` are pinned to an exact version (no `^`/`~`). `parser`'s output must be byte-reproducible wire format across the parser, the Babel plugin, and the TS plugin's virtual-file generator; an unpinned transitive bump in Babel or TypeScript could silently change AST shape or emitted output. See `README.md` "Pinned versions" for the current set and rationale.

## Solid 2 target and pin policy

SolidMX targets **Solid 2 only** — no Solid 1 lowering table, no dual target. Pins: `solid-js`, `@solidjs/web`, `@solidjs/babel-plugin`, `@solidjs/compiler` all at `2.0.0-rc.7`. `babel-preset-solid` and `vite-plugin-solid` are dead ends (renamed upstream).

Solid 2 is pre-stable and RCs ship weekly. Policy: **pin one RC and stay on it**; re-sync the research note on each bump we choose to take, and do not chase every RC. See `README.md` "Solid 2 RC policy".

Consequences encoded in the lowering table: `Index`/`Key`/`mxRange` are gone (one `For` with a `keyed` prop, plus `Repeat`); `classList` is gone (one `class` prop taking a string, object, or recursive array); `on:`/`oncapture:`/`attr:`/`bool:`/`use:` are parse errors with fix-it hints (only `prop:` survives); `<try>` lowers to `Errored`/`Loading`. No runtime-helper imports and no `needsImport` machinery: both compilers auto-import the builtIns (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`).

## Base branch

`main`.

## Commit convention

Conventional commits: `type(scope): summary`.

## MX parser

`packages/parser` vendors `@babel/parser` 7.29.8 and forks one method of its JSX plugin so `<` in expression position is parsed as MX. Entry points:

- `parse(source, filename, options?)` — parses `.solid.mx`, returns a Babel `File` of standard node types only (MX facts go in `node.extra.mx`). Every MX region inside is lowered to Solid JSX text via `@mxlang/solid`'s `compileSolidMx` before being re-parsed and spliced back in — see "`@mxlang/solid`: the Solid host on `@mxlang/core`" below for that lowering, and `packages/parser/README.md` for this package's own, now-narrower job (region discovery only).
- `parseBabel` / `parseBabelExpression` — the untouched vendored `@babel/parser` surface, for plain `.ts`/`.tsx`.

MX parsing is opt-in through the `mx` parser option, which `parse` sets. Without it the vendored parser is byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, so keep those tests on `parseBabel` rather than `parse`. `packages/parser/UPSTREAM.md` "Local modifications" records exactly what the fork changed.

Consumers typecheck against `src/public.d.ts`, not `src/index.ts`: the vendored tree needs tsconfig relaxations that must not leak into packages that merely call `parse`.

Two syntax decisions are settled and encoded in `@mxlang/solid`'s lowering (`packages/hosts/solid/README.md`'s table is the authoritative version; this is the summary):

- **Whitespace follows Marko, not JSX.** A whitespace-only text run containing a newline is dropped entirely, so indented markup renders nothing between children; a whitespace-only run without a newline collapses to one space. `${" "}` is the escape hatch. Comments are dropped from the output and do not count as content when trimming. This is Marko's own `onText` rule (decision 33), the same one every host relies on — see the four Marko facts below.
- **Void elements need no slash.** `<input value=x>` parses. The set (`area base br col embed hr img input link meta param source track wbr`) is declared to htmljs-parser as `TagType.void`; a void tag written with a closing tag is a parse error.
- **Shorthand `class` merges with a string or an object; anything else is a parse error.** Shorthand plus a *string* `class="x"` merges to `class="card x"` (shorthand first). Shorthand plus an **object literal** merges to Solid 2's array form, `class={["card", {...}]}`, the string entry always-on and the object toggling; a static `class="x"` present as well folds into that string entry (`class={["card x", {...}]}`) rather than being emitted as a second `class` attribute. Shorthand plus any *other* dynamic `class=` expression (an identifier, a call, a ternary) is a parse error. `#id` shorthand combined with an explicit `id=` is a parse error. `style=` only accepts an object-literal value (`style={color: c()}` → `style={{color: c()}}`); any other `style=` expression is a parse error for v1.
- **Tag params and attribute tags are generic, not control-tag-only**
  (decision 51), for any tag Marko itself accepts them on — decision 72's
  subset rule (`divergences.md`) removed the cases real Marko rejects (tag
  params on `<if>`, tag params and attribute tags on native HTML elements).
  `<Tag|p1, p2|>body</Tag>` lowers to `<Tag>{(p1, p2) => body}</Tag>`, which is
  what lets Solid's own render-prop components be called from MX
  (`<For|item, i| each=xs()>`, `<Show|u| when=user()>`). Inside a component,
  `<@name>body</@name>` becomes the prop `name={body}`, and `<@name|p|>`
  becomes `name={(p) => body}`; ordinary children stay the child callback, and
  props are emitted as the parent's own attributes in source order followed
  by the attribute tags in source order. `<try>` is expressed *on top of*
  this in `@mxlang/solid`'s `resolveHostTag`: it reads `<@catch>`/
  `<@placeholder>` out of the same attribute-tag resolution every other tag
  uses, so the special and generic paths cannot drift. An attribute tag whose
  name is already an attribute on the parent is a parse error rather than a
  second `name=` the last writer wins — and `children` counts, since ordinary
  children lower into that prop, so `<@children>` beside any ordinary child
  collides too.
- **Tag params (`|a, b|`) come before `=value`.** `<if|u|=user()>`, not `<if=user()|u|>` — the latter parses but folds `|u|` into the condition expression and reports no params, matching `<for|item, i| of=...>`'s own order. `notes/solidmx-spec.md` §5.1 writes `<if=user()|u|>` as loose prose; the real grammar is params-first.

## `.mx` is the only template extension (decisions 72, 2026-09-15)

Decision 68 retired the old `.mx` *dialect* (required explicit imports,
`<fragment>`, required `export interface Input`, lowercase-by-scope) —
`@mxlang/html` and `packages/mx-html` stay deleted, and those conventions do
not come back. Decision 72 re-establishes `.mx` as MX's own **identity**,
distinct from that dialect: MX is its own language with Marko as its origin,
and MX 1.0 is a strict subset of Marko syntax — every MX 1.0 file is a valid
Marko file with the same meaning for the structural core.

**Decision 2026-09-15 (Saulo) superseded decision 72's `.marko` alias**:
no product path of MX accepts or advertises `.marko` any more — MX only
supports the MX 1.0 subset of Marko syntax, so treating an arbitrary
`.marko` file as MX would silently claim support it does not have. `.mx`
(plus `.solid.mx` and `.amx`, different file kinds) is the only template
extension across every host loader (`@mxlang/html/bun`, `@mxlang/hono/bun`,
`@mxlang/vite-plugin`), the language server, the TypeScript plugin/`mx-tsc`,
and the VS Code/Zed extensions. Porting a Marko component that stays within
the MX 1.0 subset is a rename. `@marko/compiler`'s own `tags/` auto-discovery
convention (`tagDiscoveryDirs: ["tags"]`, used by `@mxlang/html` and
`@mxlang/preact`) is the one narrow exception that still touches real
`.marko` files: `@marko/compiler`'s `scanTagsDir` only discovers files whose
*actual* extension is `.marko` (measured in 5.42.5's `loadTaglibFromDir.js`,
`ext === ".marko"`) — a `.mx` file placed in a `tags/` directory is not
discovered at all. This is Marko's own compiler behavior during a whole-file
`.mx` compile, not a second entry point MX advertises.

The oracle (`packages/oracle`, `packages/hosts/html/fixtures-marko/*`) still
keeps its 43 stock fixtures as real `.marko` files, because Marko's own
compiler and its `tags/` scan only accept `.marko` — but it feeds them to MX
by reading the file content and compiling under a virtual sibling `.mx`
filename in the same directory (`translator-render.ts`'s `renderTranslator`),
not by the real `.marko` path. `tags/*.marko` fixture files stay on disk as
real `.marko` (Marko's own discovery convention above), and every other
fixture `.marko` file's `from "./x.marko"` imports are rewritten for the MX
side the same way the oracle already rewrites them to `.ts`. `.solid.mx` is
unaffected either way — a different file kind (TSX with MX regions), never
covered by the `.marko` alias in the first place.

- `parse(source, filename)` in `@mxlang/parser` — a `.solid.mx` file: a
  TypeScript module in which `<` in expression position opens an MX element,
  lowered to Solid 2 JSX by `@mxlang/solid` (see below). This is the parser
  package's only mode; there is no `mxMode` option. SolidMX is a separate
  host from the vanilla one below, and is not affected by `.mx` being the
  only template extension or by decision 68's dialect retirement.
- `compile(source, filename)` in `@mxlang/html` — a whole-file MX
  template (`.mx`, stock Marko syntax with no dialect layered on top).
  `@marko/compiler` parses, validates and supplies the tag registry; the
  package supplies only a translator (`packages/hosts/html/src/translate.ts`)
  and its own taglib (`packages/hosts/html/taglib/marko.json`).
  `@mxlang/parser` is not on this path at all. `compile()`/`compileFile()`
  themselves do not gate on the filename extension (it is inert in
  `@mxlang/core`'s `compileSource` too — the extension check lives at the
  loader boundary instead); the Bun loader (`@mxlang/html/bun`) and
  `@mxlang/vite-plugin`'s `mx()` both accept only `.mx`, excluding
  `.solid.mx`.

Four Marko facts that are easy to get wrong (all measured against
`@marko/compiler` 5.42.5, all cost real debugging time):

- **Marko's `onText` already implements decision 33.** `<p>\n  a\n</p>` gives
  `MarkoText "a"` — a whitespace-only run containing a newline is dropped —
  and `a   b` gives `"a b"`. The string translator therefore does **not**
  re-normalize, and does not call `normalizeText()`. Do not add a second
  normalization pass on that path; it would double-collapse.
- **`import` / `static` / `export` parse as *tags*, not statements**, whose
  attributes are the remaining words. To recover the statement text, slice by
  **`loc` line/column**: `start` and `end` are **`undefined`** on these nodes.
  (An earlier version of this file said "the tag's range is the statement's
  source span" — true of `loc`, not of `start`/`end`.) Import binding names
  are then re-parsed with `parseBabel`, never regex-scraped.
- **A bare top-level `${expr}` line is a `MarkoTag` whose `name` is the
  expression**, not a `MarkoPlaceholder` — concise mode has no other shape for
  it. A tag with an expression name, no attributes and no body is that
  placeholder; treating every expression-named tag as a dynamic tag error
  breaks a template whose first content is a placeholder.
- **`<!doctype html>` arrives as a `MarkoDocumentType` node** whose `value` is
  `doctype html` (delimiters stripped), so it is re-emitted as `<!${value}>`.
  Marko strips comment delimiters too, which is why an HTML comment and a `//`
  line comment are told apart by re-reading the source at the node's `loc`.

`@mxlang/html`'s translator (`translate.ts`'s dispatch) decides
component-vs-HTML dispatch by **in-scope binding, not case**: a tag name
matching an `import`, a `<define>`, or a tag Marko discovered via taglib/
`tags/` is a component call whatever its case; anything else is an HTML
element (Marko's own registry) whatever its case, hyphenated custom elements
included. This is Marko's own rule (custom tags are lowercase there), not an
MX invention. `import layout from "./layout.marko"` then `<layout>` calls the
component; `<my-widget>` with no matching binding stays a literal element. A
capitalized tag with no matching binding is a compile error, not a literal
element — no HTML element is ever capitalized. Import binding names are
extracted by parsing the hoisted import line with `parseBabel` (default,
namespace, named, aliased, and combined forms), not by regex. An unbound
*lowercase* tag that is neither hyphenated nor a real HTML/SVG/MathML element
is a translate error naming it, rather than silently rendering as an unknown
custom element. SolidMX's own PascalCase-means-component convention
(`packages/hosts/solid/src/emitter.ts`'s `isComponent`) is unrelated and
unchanged by this — it follows JSX, and is a separate host on a separate
lowering path.

## Running tests in a fresh worktree

`@mxlang/parser` and `@mxlang/core` resolve to `dist/`, so a freshly created worktree
needs `bun install` **and** `bun run build` before any dependent package's
tests will run — without `dist/` consumers fail to resolve those packages
(the oracle fails the same way). `bun run verify` builds before it tests,
so this only bites when running one package's tests directly. The per-edit
typecheck hook in `.claude/hyper.json` also expects a prior build for full
coverage (it skips checking packages that rely on the built `mx-tsc` wrapper if
it isn't built yet).

`packages/editors/tree-sitter-solidmx/vendor/` is gitignored, so a fresh worktree has
none — `scripts/test.sh` now runs `scripts/vendor.sh` itself when
`vendor/tree-sitter-typescript` is missing (printing one line saying so), so
`bun run verify` and `bun run test:grammar` pass from a clone with no manual
setup step.

Per-package vitest runs need the root config: `bunx vitest run --root ../..
--project @mxlang/<name>`. A bare `bunx vitest run` inside a package directory
fails with "No projects were found", because `projects: ["packages/*"]` is
resolved relative to the root.

`packages/hosts/html` (`@mxlang/html`) holds the string target:

- `escape(value)` — the *entire* runtime. Escapes `& < > " '`; `null` and
  `undefined` render as `""`, not their names.
- `compile(source, filename, options?)` -> `{ code, map }`, driving the
  translator under `@marko/compiler`. `options.strict` swaps in `strictPolicy`
  (see the translator section below). The map is currently an identity
  placeholder: the translator builds text directly rather than printing an
  AST. Marko's nodes do carry real `loc`, so genuine mappings are now
  possible — a separate task.
- `TranslateError` — a construct that parses as Marko but has no string
  lowering, carrying `line`/`column` rather than byte offsets, because that is
  what Marko's nodes have.

Emitted module shape: the `escape` import, the author's hoisted `import`s and
`static` blocks, their `export interface Input` verbatim, and
`export default function <Name>(input: Input): string` (named after the file —
see the export-name bullet below) building one local by `out +=`
concatenation (**not** an array join — the goldens diff this code).

Whitespace on **every** host, SolidMX included, is decision 33's rule
applied once, by Marko's own `onText` before `@mxlang/core`'s resolver ever
sees a `MarkoText` node (see the four Marko facts above) — there is no
separate SolidMX-specific whitespace pass to keep in sync; a second
implementation on any host's path would collapse whitespace twice.

Goldens live at `packages/hosts/html/fixtures-marko/<name>/` with
`input.marko`, `input.json` and `expected.html`, and are asserted on
**rendered HTML**, not on emitted code, so the emitter stays free to improve.
`biome.json` ignores `**/fixtures-marko`.

## Zed extension

`packages/editors/zed` (`mxlang`) ships three languages for Zed: `MX`
(`.mx`, restored per decision 72), `AstroMX` (`.amx`, decisions 76c/78) and
`SolidMX` (`.solid.mx`). `AstroMX` rides the `amx` grammar (from `packages/editors/tree-sitter-amx`, which splits the file into a TypeScript fence and an MX template body) and injects Marko queries into the body, so the frontmatter highlights as TypeScript.

`MX` rides Marko's own unmodified tree-sitter grammar (`[grammars.marko]` in
`extension.toml`, pinned to the same rev the official `marko-js/zed`
extension pins: `7fb20382b9b0c97c8bdbceee0e0641bea11dd00f`,
`@marko/tree-sitter` v0.2.0). `languages/mx/*.scm` are the official
extension's `languages/marko/*.scm` copied **verbatim**, no overlay, no
edits — MX 1.0 being a strict Marko subset (decision 72) means Marko's own
queries already apply. `languages/mx/config.toml` is hand-written (`name =
"MX"`, `path_suffixes = ["mx"]`) since the official file's `name = "Marko"`
would collide with the official extension's own language if copied as-is.
`.marko` files are covered by installing Zed's official `marko-js/zed`
extension directly (its own `Marko` language, unrelated to `MX`); do so
alongside `mxlang` for the SolidMX injection to highlight (see below). `MX`
has no language server of its own: Marko's LS (from the official extension)
binds to its own `Marko` language, not `MX`, since Zed's
`[language_servers.*]` binding is per-language-name.

**Zed suffix precedence.** Zed's suffix matcher takes the text after a
file's *last* dot, then the longest matching `path_suffixes` entry wins.
`MX` declares `["mx"]`; `SolidMX` declares `["solid.mx"]` — both match
`Counter.solid.mx`, and `SolidMX`'s longer entry wins, so `.solid.mx` keeps
resolving to `SolidMX` regardless of `MX` being present. Verified by
inspection: `languages/solidmx/config.toml` already declared the longer
`path_suffixes = ["solid.mx"]` before `MX` was added back, so no change was
needed to preserve this precedence.

`SolidMX` (`.solid.mx`) is backed by `packages/editors/tree-sitter-solidmx`'s grammar
(a patched `tree-sitter-typescript` tsx dialect with an `mx_element` external
token in expression position). Its grammar is a **`file://` dependency during
development** (`extension.toml`'s `[grammars.solidmx]`, with
`path = "packages/editors/tree-sitter-solidmx"` since the grammar lives inside this
monorepo rather than at a repo's own root) — swapped to a real GitHub URL at
publish time. Even `file://` still requires a **committed sha**: Zed's
`checkout_repo` runs `git init` + `git fetch --depth 1 origin <rev>` +
`git checkout <rev>` regardless of scheme, so uncommitted changes under
`packages/editors/tree-sitter-solidmx` are invisible to Zed. The dev loop is commit,
then bump `rev` in `extension.toml`, then reinstall — see
`packages/editors/zed/README.md`.

`languages/solidmx/*.scm` are generated by `scripts/vendor.sh`:
`highlights.scm` is copied from
`packages/editors/tree-sitter-solidmx/queries/highlights.scm` (a local sibling
package, not a network fetch); `injections.scm`/`brackets.scm`/`outline.scm`
have no upstream reference extension to copy from (no `marko-js/zed`
equivalent exists for this grammar), so their base content is hand-authored
in `base/solidmx/*.scm` instead. All four get `overlay/solidmx/*.scm`
concatenated on top. Never hand-edit `languages/solidmx/*.scm` directly.
There is no `vendor.sh --check` mode (MX's version had one, comparing its
`marko-js/tree-sitter`/`marko-js/zed` pins against upstream HEAD): SolidMX's
highlights source is local, with no upstream HEAD to drift against, so a
"check" mode could only ever report success — decision 55, a gate that
cannot fail is not a gate. `.github/workflows/upstream-check.yml`'s
`vendored-files-match` job does the real check instead.

**Rust `lib.rs` registers the MX language server** (decision 77, task
`zed-ls-registration`): `Cargo.toml` + `src/lib.rs` implement
`zed::Extension::language_server_command`, and `extension.toml` carries
`[language_servers.mxlang]` (`languages = ["MX", "SolidMX"]`; AstroMX is not
listed since `@mxlang/language-server` does not compile that file kind yet).
Minimal by design: no settings, no downloads — command
resolution checks a local worktree install (via `Worktree::read_text_file`,
the sandbox-safe check: Zed's wasm sandbox preopens only the extension's own
working directory, so a plain `std::fs`/`Path` check on a worktree path
always reports "not found" and cannot be used; there is also no walk-up past
the worktree root, since `Worktree`'s API has no such operation), else a
global install via `Worktree::which`, else `bunx @mxlang/language-server
--stdio`, else `npx`. Built to
`wasm32-wasip1` by `scripts/zed-compile-check.sh` (a clean-clone
gate, same shape as `tree-sitter-solidmx`'s own `zed-compile-check.sh`),
wired into `ci.yml` as its own job (`rustup target add wasm32-wasip1` on the
runner first — this is the one place in this repo Rust is required; the
target is a toolchain install, not a repo dependency). See
`packages/editors/zed/README.md` "Toolchain prerequisite" and "Language
server", and `UPSTREAM.md` for the pinned `marko-js/zed` commit the `lib.rs`
shape was read from.

`base/solidmx/injections.scm` injects a language named `marko` into
`mx_element` regions (MX and SolidMX share syntax) — the region is a single
opaque external token, so nothing inside it is captured by SolidMX's own
queries. This package's own `MX` language is named `"MX"`, not `"Marko"`, so
it cannot satisfy the injection despite compiling the same grammar — the
injection resolves, and only then does the region get any syntax
highlighting, when Zed's official `marko-js/zed` extension (`name = "Marko"`
in its `languages/marko/config.toml`, matched case-insensitively) is also
installed; without it the region stays unhighlighted plain text. This is a
documented prerequisite, not a bug (see `packages/editors/zed/UPSTREAM.md`
"SolidMX injection prerequisite").

## Design docs

Design docs, specs, and research notes live outside this repo, at the project space root under `notes/` (not inside this worktree).

## Oracle harness

`packages/oracle` (`@mxlang/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, across **both Solid 2 backends and both generate variants** — four rows per fixture. `bun run oracle` runs it standalone and prints a fixture/backend/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

Backends (`compile.ts`'s `backend: "babel" | "native"`):

- `babel` — `@solidjs/babel-plugin`, the `babel-preset-solid` successor, over a Babel JSX AST via `parserOverride`.
- `native` — `@solidjs/compiler`, Solid's Oxc compiler and `@solidjs/vite-plugin`'s default. Its only entry point is `transform(code, options)` over **source text**, so MX reaches it by printing its lowered AST back to JSX text first. Both backends must pass: they are separate codegen implementations.

Variant names are unchanged from Solid 1 (`generate: "dom" | "ssr"` plus `hydratable`) — both 2.0 packages document the same spelling.

Two native-compiler gotchas, worked around in `compile.ts`:

- The documented `syntax` option (README and `types.d.ts`) is **rejected at runtime** by rc.7. Frontend routing is by filename.
- The compiler picks its parser dialect from the **filename extension** and rejects `.solid.mx`. The oracle appends `.tsx` to MX filenames for that backend, like `@mxlang/vite-plugin`'s virtual id.

`@mxlang/parser` exports two printer entry points, both sharing one set of `@babel/generator` options so they cannot drift: `print(source, filename)` for the ordinary case, and `printAst(ast, filename)` for callers that must run their own pass over the AST first. The oracle needs the second one — `.solid.mx` fixtures use TypeScript syntax, `@babel/preset-typescript` has to erase it before printing, and `print` would re-parse the source and skip that erasure, handing `interface Todo { ... }` to a JSX-only frontend.

A twin must not introduce whitespace MX drops. MX follows Marko's rules — a whitespace-only run containing a newline is dropped — so `text<p>…` goes on one line in the twin wherever the MX source separates them only by indentation. See `fixtures/README.md`.

`@mxlang/parser` is wired into the harness (`packages/oracle` depends on it and `report.ts` passes its `parse` as `mxParser`), so fixtures compile for real. Statuses: `pass`, `fail` and `divergent` mean the parser ran; `skipped` means no parser was available (now a real failure, not "not implemented"); `pending` means the fixture carries a `PENDING` marker naming constructs the parser cannot lower yet. Neither `skipped` nor `pending` is a pass, and `--strict` fails the run on either — see `fixtures/README.md` for the `PENDING` contract.

Current state: `counter`, `todos`, `attrs`, `lists` and `render-props` all pass on both backends and both variants (20 rows). `bun run oracle` and `bun run oracle -- --strict` are both expected to exit 0 — `--strict` green is the standing bar, not an aspiration.

`packages/oracle/src/compile.ts` runs `@babel/preset-typescript` after parsing `.solid.mx` too, not only `.tsx`: the vendored MX parser accepts TS syntax (interfaces, type annotations, generics) but `mxParser`'s `parserOverride` only replaces the *parse* step, not the erasure pass, so TS type nodes are still in the AST afterward and need the same stripping a `.tsx` file gets — or they leak into the compiled output and break byte parity against a twin that went through the ordinary TS pipeline.

Golden snapshots (`fixtures/<name>/__golden__/twin.<backend>.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a Solid 2 pin bump changing generated code. Regenerate them deliberately with `bun run oracle -- --update` and call it out in the PR — never let a pin bump change them as a silent side effect.

`packages/parser/src/mx/perf.test.ts`'s 500ms wall-clock budget only fails the test when `MX_PERF_STRICT` is set; otherwise it just `console.warn`s past the budget, since a plain `bun run verify` under machine contention (several agents/verifiers at once) can blow well past 500ms with no actual parser regression.

### `oracle:marko`: Marko parity for the stock `.marko` fixture set

Decision 51: the parity target for Marko-syntax constructs is Marko itself,
not Solid. Decision 68 retired `.mx`/`@mxlang/html`, so there is one dialect
and one table: `bun run oracle:marko` (`packages/oracle/src/report-marko.ts`,
delegating to `report-marko-stock.ts`) renders every fixture under
`packages/hosts/html/fixtures-marko/<name>/{input.marko,input.json,expected.html}`
two ways — through the real Marko 6 toolchain (`@marko/compiler` 5.42.5 +
`marko/translator`, exactly matching `marko@6.3.51`'s own dependency) and
through `@mxlang/html`'s `compile()` — and compares both against
`expected.html` for **semantic** equality (`normalize-html.ts`'s
`htmlEquals`: both sides parsed with `parse5` and compared by decoded
tag/attribute/text/comment content, not by string spelling). `-- --strict` is
accepted for CLI symmetry with `oracle -- --strict` but does not fail on a
recorded, reasoned skip/divergence (`meta.json` in a fixture directory — see
`fixtures/README.md`'s "oracle:marko" section for the full contract) — that
classification is the settled state, not unfinished work like `oracle`'s own
`pending`/`skipped`. The run fails if the fixture glob is empty, a fixture is
missing one of its three files, or too few fixtures were processed (decision
55: a gate must assert it did work, not only that nothing failed). See the
script's own footer for the current pass/skip/bug count.

`bun run oracle:preact` and `bun run oracle:react` have the same shape for the
JSX hosts — see their package sections below. Both ignore attribute order;
the React runner also removes React 19's leading, renderer-generated image
preload hints before comparing the authored markup.

Neither is part of `bun run verify` or `moon run :verify`
— the Marko toolchain is a real install/memory cost and this task's own load
rule is one heavy process at a time. Run it in CI as its own job if
`.github/workflows/` grows a verify workflow; none exists yet in this repo, so
there is nothing to wire it into today.

Two Marko-toolchain facts worth knowing before touching
`packages/oracle/src/marko-compile-stock.ts`:

- `compileFile`'s `translator` option must be resolved and passed as the imported module object (`import * as translator from "marko/translator"`), not the string `"marko/translator"` — passing the string fails to resolve relative to the compiler's own internal base path rather than the caller's `node_modules`.
- `optimize: true` is required to get a plain server-HTML render: without it, `@marko/compiler` emits Marko's resume/hydration markers (an HTML comment plus an inline `<script>`) even under `output: "html"`. It does not fully suppress them — `<input>` and dynamic spread attributes still emit one regardless of `optimize` — so `normalize-html.ts`'s `stripMarkoResumeMarker` strips the trailing `<!--M_$…--><script>…</script>` pair before comparison: it is Marko hydration plumbing with no `@mxlang/html` equivalent to compare against, not template content, and its id/script body is randomly generated per compile so it can never byte-match anyway.

## Vite plugin

`packages/tooling/vite-plugin` (`@mxlang/vite-plugin`) is the primary integration
(spec section 7.1): an `enforce: "pre"` Vite transform that prints
`.solid.mx` to JSX source text with `print()` ahead of
`@solidjs/vite-plugin`. Both plugins are `enforce: "pre"`, so their relative
order is their order in the `plugins` array — `mx()` must come first.

`mx()`'s default `extensions` is `[".solid.mx", ".mx"]`: `.mx` (the official
and only template extension — `.marko` is not accepted, see "`.mx` is the
only template extension" above) compiles through `compileMarko()` (routing
to the resolved host's compiler — `@mxlang/html`'s `compile()`,
`@mxlang/preact`'s `compilePreactMx()`, etc.) instead of `print()`, to a
plain `(input) => string` module or a JSX component module per host —
`suffixFor` returns `.tsx` for every handled extension (it used to pick
`.ts` for the `.mx` path): the suffix has to be decided identically by
`resolveId`, which holds the real path, and `isMxModule`, which holds only
the suffixed one — and the host is a property of the file's nearest
`package.json`, so deriving it in both places would mean resolving a policy
from a path that does not exist on disk. A `.tsx` file containing no JSX is
ordinary TypeScript and rolldown's transform over it is a no-op. `.solid.mx`
is otherwise byte-for-byte unchanged by this: same suffix, same `print()`
call, same source map, and it keeps precedence over `.mx` regardless of
`extensions` order (`.mx` is a literal string suffix of `.solid.mx`, so the
longest-first sort at `index.ts`'s `matchExt`/`isMxModule` setup matters
here). The `.mx` path returns `map: null` from `transform` — `compile()`'s
map is presently an identity placeholder (see `packages/hosts/html`'s own
doc comment: no AST is printed on that path), so there is nothing real to
hand Vite yet.

`compileMarko()` inside the plugin dynamically `import()`s
`@mxlang/html` rather than importing it statically at module top level,
and this is load-bearing, not a style choice: `@mxlang/html` has no
compiled entry (`main` is `src/index.ts`), and its `translate.ts` pulls in
`@marko/compiler`. A static import would load that dependency the instant
`vite.config.ts` imports this plugin — including for a `.solid.mx`-only
project like `examples/counter-app` that never touches `.mx` — and
previously broke `vite build` for such projects, because Vite's own config
loader (and, separately, Node's plain `import()`/`require()`) reads
TypeScript through Node's native strip-only mode, which used to reject a
`readonly` parameter property in `TranslateError`'s constructor (fixed to
plain fields, since it is public API a no-build-step consumer can hit
directly). A dynamic `import()`, not `require()`: `require()` on a bare
specifier whose `main` is TS source goes through Node's native loader with
zero transform under a Node-native `require` (e.g. inside a Vitest test),
hitting the same class of error one import further in; dynamic `import()`
goes through Vite's/Vitest's own transform pipeline, which strips TypeScript
fully.

Any consumer of this plugin needs `allowImportingTsExtensions` in its own
`tsconfig.json`, even one that only writes `.solid.mx`: resolving
`@mxlang/html`'s types at all — even through the plugin's own dynamic
`import()`, cast away at the call site — means `tsc` walks that package's
`.ts` source, which needs the flag wherever it lands. `examples/counter-app`
and `examples/todomvc` both carry it for exactly this reason, not because
either project imports `.ts` paths itself.

`resolveId` rewrites the resolved path to `<path>.solid.mx.tsx` and `load`
reads the real file from disk. That suffix is not cosmetic; three separate
stages dispatch on the file extension and `.solid.mx` satisfies none of them:

1. Vite routes a module into the JS pipeline only when the extension matches
   `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). With no `resolveId` hook the
   import is never resolved and `transform` never runs at all.
2. Rolldown picks its parser dialect from the extension, so printed JSX is
   parsed as plain JS ("Unexpected JSX expression"). Returning
   `moduleType: "tsx"` fixes the parse but then hands the module to
   rolldown's own JSX transform, which resolves `react/jsx-runtime`.
3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, default
   `src/**/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`. That test runs *before* its
   `options.extensions` list is consulted, so registering `.solid.mx` there
   cannot bring the file back in.

The `.tsx`-suffixed id satisfies all three at once, which is why the
example's `vite.config.ts` is just `plugins: [mx(), solid()]` with no Solid
configuration.

The suffixed path is produced by Vite's own resolver, never by path
arithmetic in the plugin: `resolveId` calls `this.resolve(id, importer,
{ skipSelf: true })` and appends the suffix to whatever comes back. That is
what makes relative ids from nested importers, root-relative (`/src/x.solid.mx`)
and `/@fs/` ids, `resolve.alias` entries and bare specifiers into workspace
packages all work; computing the path locally got each of those wrong. Any
`?query` on the id is re-attached after the suffix, so `./A.solid.mx?raw`
still returns the file's text rather than the compiled module.

`load` claims the suffixed id only when the un-suffixed `.solid.mx` file
actually exists on disk. A real `Foo.solid.mx.tsx` checked into a project is a
different module and must not be shadowed by MX's virtual one, so when there is
no `Foo.solid.mx` beside it the hook returns null and Vite reads the real file. Diagnostics and source maps keep the original `.solid.mx`
filename: `transform` prints against the stripped path, and parse errors are
re-raised with a Vite-shaped `loc` (`{ file, line, column }`) so the overlay
points at the MX line.

`@mxlang/parser`'s `main` is `dist/index.js`, not `src/index.ts`. Vite's config
loader externalizes bare imports, so a consumer that pulls the parser's TS
source makes Node load the vendored Babel tree, whose `const enum`s the
strip-only TypeScript loader rejects. `types` still points at
`src/public.d.ts`, so typechecking never needs a build; `bun run verify`
builds before it tests.

## `@mxlang/core`: the Marko-node consumer

`packages/core` (`@mxlang/core`, decisions 70 to 72, 79) is the half every MX
host shares: it consumes Marko's AST through `@marko/compiler`, applies the
structural lowerings (`<if>`/`<else>`, every `<for>` form, `<define>`,
`<const>`, statement tags, the field and inert-shape guards) and **resolves
them into a host-independent IR** (decision 79). A host then *emits* from that
IR and never walks a Marko node. `packages/core/README.md` documents the IR
kinds, what a host implements in order, the hooks and the front doors — read it
before adding either.

The three pieces: `src/ir.ts` (the node kinds, a position on every one),
`src/lower.ts` (Marko AST in, `Ir` out, carrying every validation and every
error message the emitting walk had), and `src/emit.ts` (`Emitter<Out>`, one
method per kind, plus the `drive`/`emit` driver). `src/declarations.ts` holds
`HostDeclarations` — the questions the lowerer asks — and `Policy` remains a
compatibility alias of `HostDeclarations` only. `HostOptions.emitIr` is
required: there is no pre-IR string-walk fallback.

Both current hosts are on the driver. `@mxlang/html` uses
`packages/hosts/html/src/emitter.ts` for vanilla HTML strings;
`@mxlang/astro` uses `packages/hosts/astro/src/astro-template.ts` for `.amx`'s
expression-shaped Astro syntax. Neither emitter reads a Marko node; a
host-specific resolve-time decision goes in `HostTag.data` through
`claimsTag`/`resolveHostTag`.

Five facts worth knowing before editing it:

- **It depends on `@marko/compiler` and nothing else.** `core.ts` used to parse
  an `import` line with `@mxlang/parser` — the *SolidMX parser* package — for a
  single `parse` call. It now asks `@marko/compiler/internal/babel`
  (`parse`/`parseExpression`/`traverse`/`types`, all present), which is also
  the instance Marko's own nodes belong to. Do not reintroduce a second Babel.
- **Every host implements `Emitter<Out>`**, one method per IR kind, and the
  core's `drive`/`emit` owns the walk. A host that cannot express a kind throws;
  no optional callback may silently drop it.
- **Three stateful-tag hooks** (decision 70), unit-tested through
  `src/lower.test.ts`: `claimsTag`/`resolveHostTag` (the lower-time tag
  handler), `ctx.hoist(code)` (lift a statement to the enclosing function's
  head — the render function, or the nearest `Define`), and
  `ctx.bindings.register(name, rewrite)` (rewrite identifier *references*, so a
  host whose state is a getter emits `count()` for `${count}`). Rewrites apply
  only to reference positions, and emitted-JS scopes restore shadowed names.
- **`parseFragment` is spike 1's stopgap, with measured limits.** Marko's own
  nodes carry no numeric `start`/`end` at all (only `loc.{line,column}`); the
  Babel expression nodes nested inside them carry their offset at
  `loc.*.index`; **position objects are shared between nodes**, so the walk
  dedupes them or a second visit lands at `base + base` (measured: raw index 16
  with `baseOffset: 42` came out at 100 instead of 58); a thrown parse error's
  position is on the exception, not in the tree, and is shifted separately.
  `parseFragment` also passes a **parse-only translator stub** (empty
  `translate`), because `@marko/compiler` otherwise resolves its default
  `marko/translator` before parsing and fails — the `marko` package is not a
  dependency here. SolidMX's own bridge
  (`packages/parser/src/mx/bridge.ts`) now calls `parseFragment` for every MX
  region it finds; see "`@mxlang/solid`: the Solid host on `@mxlang/core`"
  below.
- **Programmatic custom tags lower to ordinary IR before a host emits.** Every
  host compiler accepts `customTags: Record<string, CustomTag>`; the core
  validates declared attributes and attribute tags, then calls `transform`.
  Only `parseOptions.text`/`preserveWhitespace`/`openTagOnly` cross into an
  injected Marko taglib. Marko caches injected taglibs by id, so the id must
  remain keyed by the parser-facing definitions or later compilations can
  reuse the first map. **That cache is never evicted, so the id must not be
  minted per compile.** Marko's `lookupCache` is keyed on the sorted taglib
  ids and `loadedTranslatorsTaglibs` on the translator object, and neither
  drops an entry except through `clearCaches()`; measured, 200 compiles with
  200 distinct tag sets leave 200 live ids. In a one-shot build that is
  bounded, but a long-lived language server compiling an edited file over and
  over grows without limit. **Done in P2** (`packages/core/src/scan-cache.ts`):
  the cache interns one tag-map object per tag set, so the derived id is
  stable across compiles, and evicts `taglib.clearCaches()` when the
  parser-facing set changes. The TypeScript plugin passes the
  same map to compilation and its
  second lower. `.solid.mx` carries the map across the parser boundary on the
  `mxCustomTags` parser option (`print(source, file, { customTags })`), the
  only channel the in-tokenizer bridge has to the caller.
  `bun run oracle:custom-tags` is the six-host gate; every row renders and
  compares against `expected.html`. It runs **five** fixtures — `icon` (an L2
  sidecar), `icon-template` (the same tag as an L1 template), `icon-sprite`
  (P5's collecting pair), `table-of` (L2 without that pair) and `tree` (a
  self-recursive L1 template, three levels deep) — for a 30-row count gate.
  **All 30 rows pass, with no recorded skip.** (Two skips used to
  live here and both are fixed: `table-of` on Solid was the accessor-binding
  bug — see the P5 bullet below — and `icon-template` on Solid was a discovered
  unit's import having no module scope inside a `.solid.mx` region, now hoisted
  by the parser bridge; see the bullet on that below.) A skip still runs, still
  counts, and still prints its reason, so a fixture that stopped running is
  still a failure.
- **`analyze` / `finalize` / `ctx.store` are P5 and shipped**
  (`packages/core/src/custom-tags.ts`; the contract and the worked example are
  in `packages/core/README.md`). Six invariants worth knowing before touching
  them:
  - **Order is by tag name, twice.** Per file: every `analyze`, then every
    `transform` in source order, then every `finalize`; both hook phases run
    sorted by tag name, and `finalize`'s nodes are prepended to `Ir.body` in
    that order. A `finalize` receives no other tag's output and no route to the
    program, so ordering cannot become semantically load-bearing — decision
    80's coupling, which this is the obvious back door for.
  - **A store is per file *and* per tag, keyed on the `Ctx`.** A definition
    object is a module singleton the scan hands to every file in a package, so
    keying anywhere else leaks one file's collected state into the next. The
    same map is shared by reference into a tag template's `Ctx`, which is both
    the store's scope (a template's `<icon>` joins the caller's sprite sheet)
    and the hook gate: a non-undefined `ctx.customTagStores` is how the nested
    `lower()` knows it is not the file root and runs no hooks of its own.
  - **A file containing a tag that defines `analyze` is lowered twice.** The
    first walk runs over a scratch `Ctx` (same source, declarations, lookup,
    tags, stores and filename; its own prelude, bindings, imports and
    warnings) that records each call and is then discarded — so `analyze` gets
    the identical `TagCall` its `transform` will get, while the walk's hoists
    and warnings are not emitted twice. Its suppressed-output IR is never
    cached. No registered `analyze` means one walk, exactly as before.
  - **A unit boundary is a hook boundary** (decision 95). A call written inside
    a tag template belongs to *that template's* compilation unit and is not
    replayed into the caller, so a file-level `analyze` sees only the calls its
    own file wrote — measured: a caller whose template calls `<inner/>` reports
    an empty call list for `inner`. This is the reverse of the inlined model,
    where the scratch walk expanded templates far enough to record nested calls
    and every cache entry replayed a transitive call list. A tag that must
    collect across units has to do it through its own module state, not through
    `analyze`. The cached metadata a unit exposes to its caller is
    `{ readsContent, attributeTags }` and nothing else.
  - **Only a tag the file actually calls is finalized** (`ctx.customTagsUsed`),
    and a tag with `analyze` but no calls is skipped rather than analyzed with
    an empty array. A tag declaring **only** `finalize` is rejected at
    registration, from both `compile.ts` and `fragment.ts`, beside the
    built-in-shadowing check.
  - **`table-of` on Solid was skipped and now passes.** The skip recorded a
    `<for>` body reading a *property* of its row rendering empty under SSR.
    That was the accessor-binding bug, not a custom-tag matter: `@mxlang/solid`
    now rewrites every read of a parameter Solid hands as an accessor into a
    call (`p.name` -> `p().name`), so all 24 rows of `bun run oracle:custom-tags`
    pass with no recorded skip. See `packages/hosts/solid/README.md`
    "`<for>` bodies read the row as a value, on every form".
- **`<try>` is a core-owned custom tag (spec §5 P4), not per-host code.**
  `packages/core/src/builtin-tags.ts` exports `BUILTIN_CUSTOM_TAGS`, and a
  name it lists (today, only `try`) cannot be shadowed by a registered
  `customTags` entry of the same name at either of two points: `lower.ts`'s
  custom-tag branch consults it *before* a caller's own `ctx.customTags` (the
  call-site check, for a name Marko has already agreed to parse as that tag),
  and `rejectShadowedRegistration` in `builtin-tags.ts` rejects the whole
  registration up front, from both `compile.ts` and `fragment.ts`, before any
  parsing happens. The second check exists because a shadowing registration's
  own `parseOptions` (e.g. `try: { parseOptions: { openTagOnly: true } }`)
  changes how the parser itself reads `<try>`, which would otherwise surface
  as an unrelated parser error instead of the shadow diagnostic — a name
  cannot be shadowed even by a registration whose `transform` never runs.
  Every rejection is the same positioned error, not a silent override. The
  tag's `transform` validates the shape every host used to re-derive by hand
  (no tag params, no `/var`, at most one `<@catch>`, at most one
  `<@placeholder>` with no params of its own — the first two through the
  tag's own checks, the attribute-tag shape through the tag's declared
  `attributeTags` contract) and then asks for the primitive with
  `ctx.build.hostTag("try", children, attributeTags)`. `lowerCustomTag`
  passes an `isBuiltin` flag that skips the ordinary `hasContent` gate on a
  custom tag's body: a template-authored tag treats a whitespace-only body as
  "no children supplied", but `<try>` is a structural pass-through wrapper
  and must reproduce the caller's body unchanged, matching what
  `lowerHostTag` always did. Each host's `claimsTag`/`resolveHostTag` for
  `"try"` only decides how the primitive renders now — `@mxlang/html`,
  `@mxlang/solid`, and `@mxlang/preact`'s shared JSX emitter (reused by
  `@mxlang/react`/`@mxlang/hono`) all shrank to that. `@mxlang/astro` never
  claimed `"try"`; its rejection is an ordinary `tags["try"]` disposition
  entry (`ctx.declarations.tags`), checked earlier in `lowerTag` than any
  custom tag, so it is unrelated to this change and untouched. Error wording
  for the shape checks changed from each host's hand-written phrasing (e.g.
  "given twice") to the generic custom-tag messages (e.g. "may not be
  repeated") — a wording change, not a behavior change, so the affected host
  and SolidMX-bridge tests were updated to match rather than left failing. A
  tag whose `attributes` is declared empty (`{}`, `<try>`'s own case) reports
  a named or spread attribute the same way — "accepts no attributes" — rather
  than the generic checker's own internal wording ("spread attributes cannot
  be checked...") leaking into a user-facing message.
- **Custom tags are discovered, not configured** (P2, spec §4;
  `packages/core/src/{scan,scan-cache}.ts`). `getCustomTags(file)` walks
  upward from a file to the package root collecting `tags/` directories,
  indexes `x.mx` and `x.tag.ts` by basename, and extends the walk with
  `package.json#mx.tags` (a string, or entries of
  `{ dir, prefix?, hosts?, parseOptions? }` supplying directory-level defaults
  a sidecar may override). Nearest `tags/` directory wins; `mx.tags` entries
  come last, in array order. Every integration the spec lists calls it per
  compiled file — the Bun loaders, the Vite plugin, the Astro `.amx` plugin,
  the TypeScript plugin, the language server, and `mx-tsc` through the same
  language plugin — because which tags a template may call follows from where
  the template lives. An explicitly passed `customTags` still wins over a
  discovered tag of the same name.
- **Precedence order (spec §4; ref `custom-tags-import-precedence`):
  core structural tags, then built-in custom tags (`try`, never shadowable),
  then a *PascalCase* name the file itself binds (`import`, `<define>`),
  then a registered custom tag, then a host claim
  (`ctx.declarations.claimsTag`), then components/elements.** `lower.ts`'s
  tag-name switch checks `/^[A-Z]/.test(name) && (ctx.defines.has(name) ||
  ctx.imports.has(name))` directly — a *core* rule inline in `lower.ts`, not
  a call into a host's own `isComponent` (Solid's and Astro's `isComponent`
  are casing-only and never consult `ctx.imports`/`ctx.defines` at all, so
  there is no shared "file-local half" of `isComponent` to call into) —
  before ever consulting `ctx.customTags` or `claimsTag`, so
  `import Panel from "./panel.mx"` in a package that also has a
  `tags/Panel.mx` or a registered `Panel` custom tag resolves to the
  import, not the custom tag. This was previously backwards (`ctx.customTags`
  was checked first) with no test covering the order.
  **The casing guard is load-bearing, not incidental**: Marko's own rule
  (matched by every host's `isComponent` — html `translate.ts`, preact
  `emitter.ts`) is that a *lowercase* local variable is never resolved as a
  component call — `import panel from "./panel.mx"` then `<panel/>` is a
  parse-time Marko error ("Local variables must be in a dynamic tag unless
  they are PascalCase"), not a component reference. An earlier version of
  this fix checked `ctx.defines`/`ctx.imports` with no casing gate, which
  regressed every lowercase-named custom tag or host claim (e.g. `<style>`)
  sharing a name with an unrelated lowercase import in the same file — the
  binding existed but was never meant to route as a component, so it must
  not shadow the custom tag or host claim either.
  **Known gap, pre-existing and unaffected by this fix**: only `import` and
  `<define>` populate `ctx.imports`/`ctx.defines`. A component name bound by
  `<const>` (`<const/Panel=() => null/>`), or bound as a `<for>`/`<define>`
  *tag param*, is not in either set and still loses to a registered custom
  tag of the same name — measured: `<const/Panel=() => null/>` followed by
  `<Panel/>`, with a registered `Panel` custom tag, still expands the custom
  tag on `main` and after this fix alike. Spec §4 only names "explicit
  import" and local `tags/`/`mx.tags`; extending the file-local check to
  `<const>` and tag params is unscoped follow-up, not part of this fix.
- **The scan is synchronous, and that is load-bearing.** Bun's `onLoad`,
  Volar's `createVirtualCode`, `diagnoseDocument` and `mx-tsc` all call from
  positions that cannot await; only the Vite plugin could. One synchronous
  implementation is what keeps an editor, a `tsc` run and a build from
  resolving different tags for one file.
- **`parseOptions` is read without executing the sidecar**, because it must
  reach Marko before the *calling* file is parsed. It is extracted statically
  from the default export with `@marko/compiler`'s own Babel (not a second
  `@babel/parser`), and the accepted shape is narrow: an object literal, or an
  identifier bound once at module scope to one (optionally through `as` /
  `satisfies`), holding boolean-valued `text`/`preserveWhitespace`/
  `openTagOnly`. A spread, a computed key, a non-boolean or an indirection is
  a positioned diagnostic naming the sidecar, never a guess. Hooks load lazily
  on first use via a synchronous `require`, which both Bun and Node handle for
  a `.ts` file with no transform from MX; a sidecar that throws while loading
  becomes a `TranslateError` naming it, which is what lets the language server
  report a diagnostic instead of dying.
- **Invalidation is by recorded evidence, not by expiry.** A cached scan is
  rechecked against each scanned directory's entry list, each tag file's
  mtime, and the `package.json` that supplied `mx.tags`. Two signatures exist
  on purpose: the *parser-facing* one (names, paths, `parseOptions`) decides
  whether Marko may keep its lookup, while the *loaded* one adds every tag
  file's mtime and decides whether a memoized `CustomTag` — which holds the
  sidecar module it already loaded — may be reused. Conflating them served the
  old hooks after an edit that changed only a `transform` body.
  **Caveat when testing a reload:** under Vitest a deleted `require.cache` key
  does not make `require` re-evaluate a file, because its module runner keeps
  its own registry; Bun and Node both do re-evaluate, which is what ships. A
  Vitest test therefore asserts that the directory is rescanned (add a tag
  file), not that a rebuilt sidecar's hooks changed.
- **A template-only tag is discovered with no hooks**; calling one routes to
  its compiled unit.
- **The scan never hands a core-owned name onward.** A `tags/try.tag.ts` is
  excluded from the map with a diagnostic naming the file, because
  `rejectShadowedRegistration` refuses the *whole* `customTags` map when a
  built-in name appears in it — so passing it through would break every file
  in the package, including files that never call `<try>`, over one misnamed
  file. P4's rule is unchanged; the scan simply does not feed it a violation.
- **A sidecar may not use top-level `await`, and its relative imports need
  explicit extensions** (`./helper.ts`, not `./helper`). Measured: Bun accepts
  both forms, Node rejects both (`require() cannot be used on an ESM graph
  with top-level await`; `Cannot find module`). A sidecar that breaks either
  works in a `bun` build and fails in the editor — the exact disagreement one
  shared loader exists to prevent — so `loadSidecar` restates the constraint
  in its error when the runtime's message identifies it. Sidecars load through
  Node's type-stripping `require`, so every package that can load one declares
  `engines.node >= 22.18`; an older Node fails with `Unknown file extension
  ".ts"` at first tag use.
- **A tag's name is its filename, case included**: `tags/Icon.tag.ts` is
  `<Icon>`. The name must match `/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/`; dotfiles
  are skipped and anything else is a positioned diagnostic naming the file.
  This is a guard with teeth: `tags/.mx` has an empty basename, and an empty
  tag name makes `@marko/compiler` throw `"tag.name" is required`, which fails
  *every* file in the package rather than only a caller. A `.solid.mx` in a
  `tags/` directory is reported rather than ignored. Note the mtime cache
  assumes sub-second mtime granularity — true on every platform MX targets,
  but two writes inside one tick can look like one.
- **A missing `mx.tags` directory is a diagnostic, not a throw.** It lands in
  `ScanResult.diagnostics` and the scan continues, so one typo in
  `package.json` does not break compilation of files that never used that
  entry. Every integration that scans must *surface* that array or the typo is
  silent everywhere, which is worse than either a throw or an error: the
  language server publishes each as an LSP **warning** against the open
  document whose message names the offending `package.json` (LSP has no way to
  publish against a different file), and the Vite and TypeScript plugins warn
  once per distinct problem rather than once per compiled file.
- **Anything that must run the scan is tested where it can be driven.** The
  Bun loaders are exercised through `Bun.plugin` under `bun test`
  (`packages/hosts/{html,hono}/src/bun.test.ts`, both wired into the root
  `test:bun`); a row that calls a host's `compile*` with a map it fetched
  itself stays green with `getCustomTags` deleted from `bun.ts` and therefore
  proves nothing. The language server is driven over stdio with a real
  `file://` URI, because `resolve("file:///a/page.mx")` yields
  `<cwd>/file:/a/page.mx` — passing a raw URI discovered zero tags for every
  real document while a unit test using a plain path stayed green.
- **A template custom tag is a compilation unit, and `input` is a real
  parameter** (decision 95, `packages/core/src/template-tag.ts`). A `tags/x.mx`
  template compiles through the **same per-file pipeline a page uses**, into a
  module exporting the tag; the caller emits an injected `import` plus an
  ordinary `Component` call. Nothing is spliced into the caller. This is not
  new machinery but *less* of it: an explicitly imported tag already lowered and
  emitted exactly this way on all six hosts, so the work was routing a
  *discovered* tag down that same path and deleting the substitution engine
  (~1000 lines: `input` substitution, hygiene renaming, caller-side
  import/static merging, `templateStack`/`templateImports`, the expansion depth
  and node caps, and the cycle detector). Consequences, each one a limit that
  simply stopped existing: N reads are N reads rather than N evaluations; a
  spread attribute is ordinary; bare `input`/`typeof input`/destructuring are
  ordinary; a self-recursive tag is legal ESM. `content` stays reserved as an
  attribute name, and `<@content>` is rejected, because both would collide with
  the body slot. A tag declaring `parseOptions.openTagOnly` reports a
  positioned MX error at the call site (``` `<x>`: does not accept content ```)
  rather than a Marko parse error, which is why `openTagOnly` is deliberately
  *not* forwarded into the injected taglib.
- **The injected import is gensym'd and deduped by resolved path.** A
  discovered tag may be named `icon`, which `lower.ts`'s casing rule will never
  resolve as a component, and the caller may already bind that name for
  something else — so the local is always generated (`$mx_Icon1`), minted from
  the file-level counter against the caller's bindings *and* its source text.
  One import per module per tag, keyed by the template's resolved path; if the
  caller already imports that same path itself, its binding is reused and
  nothing is injected (ruling 3). The specifier is the relative posix path with
  `.mx` kept, since every loader resolves `.mx` per file.
- **`static` in a tag now runs once per process, not once per calling module.**
  The tag's module-level statements are its own module's, evaluated at import
  time — Marko's model. This is an observable behavior change for any tag whose
  `static` block has side effects.
- **A template's caller-facing facts come from cached metadata, not from
  expanding it.** Compiling a unit yields `{ readsContent, attributeTags }`
  (with `returnsValue` reserved for `<return>`), cached by path + mtime +
  source, bounded at 256 entries, with a provisional entry seeded before the
  compile so direct and mutual recursion terminate. This is what preserves MX's
  improvement over Marko: a body passed to a tag that never reads
  `input.content` still warns at the call site, even though the caller no
  longer sees the template's body. Marko does the same thing through
  `loadFileForTag`.
- **A sidecar `transform` may return IR or a `TagCall`.** Returning IR is a
  macro the author wrote — the only expansion left in the language. Returning a
  `TagCall` (or calling `ctx.build.template(call)`) validates or rewrites the
  call and then routes it to the adjacent template unit.
- **The html host augments `Input` only when the template reads
  `input.content`**: the render signature becomes
  `input: Input & { content?: () => string }`, so an imported call passing a
  body typechecks; a tag that ignores the body keeps a bare `Input`. The
  brand/helper rewrites in `translate.ts` key off whichever of the two
  signature lines was emitted — and the `function ` prefix they replace carries
  its trailing space, or the emitted code gets a stray one.
- **`class`/`for` are renamed to `className`/`htmlFor` on *elements only*.** The
  shared JSX emitter's `#attrName` takes the component flag: a component's
  attributes are its author's `Input` contract, so a tag whose template reads
  `input.class` must receive `class` whatever the target calls the DOM
  property. Renaming on a component call silently dropped the value; it only
  became reachable once a template tag became a real component call.
- **Positions get a third rule** (spec §2): material from a tag template keeps
  that file's line and column, tagged through the optional `Position.file` (and
  `Expr.file`, since an `Expr` carries no `loc` of its own). `TranslateError`
  gained a matching optional `file`. Absent means the file being compiled, so
  every position that existed before templates is unchanged. The language
  server publishes such a diagnostic against the template's **own URI** at its
  real position and leaves a pointer at the head of the open document (it
  clears the template's diagnostics when the caller stops reporting them, since
  the template is not itself open); the TypeScript plugin **drops** a
  foreign-file span, because a Volar `CodeMapping` addresses one source and a
  plausible-but-wrong column is worse than none.
- **Silent-drop reports go through `ctx.warnings`, not `console.warn`.**
  `warn(ctx, …)` records a positioned `MxWarning` when a sink is collecting and
  falls back to printing when none is, so a plain build is as loud as before
  while the language server turns them into Warning diagnostics in the file
  being edited — which is the one place a dropped-content report is worth
  anything. Both P1's unread-`attributeTags` warning and P3's unplaced-content
  warnings use it.
- **The template metadata cache is bounded** (256 entries, oldest-inserted
  evicted), not an unbounded process-wide map — a language server compiling an
  edited file over and over is long-lived, the same discipline P2's scan cache
  owes.
- **`oracle:custom-tags` compiles each fixture's tag units through the caller's
  own host** and writes them beside the caller, because the tag is a real
  import now. All 30 rows pass, Solid included.
- **Every emitted module's default export is named after its file**, never
  anonymous: `icon.mx` becomes `export default function Icon(…)`,
  `table-of.mx` becomes `TableOf`. `Ir.exportName` carries it, derived by
  `exportNameFor` (`-` and `_` separate words, `$` does not; a basename that
  would not start an identifier is prefixed `Tag`) and re-minted if it
  collides with anything the file already binds — `ctx.imports`,
  `ctx.defines`, or a match in the source text, since a name can reach the
  emitted module without passing through either set (a `<const>`, a tag
  param). It is computed in `lower` **before** the body walk, because a
  self-recursive call resolves during that walk.
  **That name is what makes self-recursion need no import** (design invariant
  §7.5-7): when a discovered tag's resolved path is the file being compiled,
  `bindingForTemplate` returns the export name instead of minting an import.
  A module importing itself is legal ESM and does work, but it is a module
  importing a binding it already has. The `tree` oracle fixture is the row
  that proves it end to end on all six hosts.
  **Consequence for anything that matches the emitted module as text:** the
  export line's *name* is now per-file, so four places match its shape and
  read the name back rather than pinning `render` — `@mxlang/html`'s
  `brandRender`/`finalizeModule`, `@mxlang/typescript-plugin`'s
  `createAstroTypeSurface`, and `@mxlang/astro`'s two `vite-pages` patterns.
  Pinning the literal there is what made every `.mx` import report
  "is not a module" under `mx-tsc --astro` when the name first changed.
- **A synthesized import is told apart from an authored one by
  `Import.synthesized`, and only Solid cares.** A `.solid.mx` MX region is an
  *expression* inside a TypeScript module, so it has no module scope to hold a
  discovered tag's injected import. The Solid host therefore splits its
  module-level-statement rejection **by origin, not by kind**: an authored
  `import`/`static`/`export`/`export interface` inside a region is still the
  same positioned error (the author has a real module to put it in), while a
  synthesized import is handed back on `CompileSolidMxResult.hoistedImports`
  for the caller to place. `packages/parser`'s bridge stamps those on the
  region root's `extra.mx` and `parse` writes them into the surrounding
  module: once per **resolved path** (the node carries `specifier` and
  `resolvedPath` beside `synthesized`, so no consumer parses the statement
  text), reusing the module's own authored *default* import of the same file
  when it has one, inserted after the last import. Every other host emits both
  kinds identically and ignores the flag.
  **A type-only import is never reused** — `import type Icon from "./icon.mx"`
  binds no runtime value, so reusing it would leave the call referencing a
  name erased before the module runs.
  **Nor is one shadowed at the region.** Reuse emits the authored name *inside
  the region*, so a scope between the module and the region that re-declares
  it (`function f(Icon) { <icon/> }`) would make the reference resolve to the
  parameter — silently, to whatever the caller passed. The check is
  deliberately coarse (any binder of that name on the path from module root to
  region), because over-reporting costs one import under a generated name,
  which is always correct, while under-reporting is the silent bug.
  **The rename onto an authored binding is scope- and position-aware**, and
  each guard is a measured bug: it rewrites only inside a region's stamped
  `[start, end)` range (else a module that happens to declare
  `const $mx_Icon1 = …` gets that declaration renamed onto the author's
  import, a duplicate-binding `SyntaxError`), never a binding position, and
  never a non-computed object key or member property (`{ $mx_Icon1: 1 }` and
  `o.$mx_Icon1` are not references to a binding at all).
  The placement decision itself lives in `packages/parser/src/mx/hoist-imports.ts`
  (`planHoistedImports`) because **two** consumers need it: `parse`, and
  `@mxlang/typescript-plugin`'s `.solid.mx` path, which reaches it through
  `print()` — `mx-language.ts` never sees a `.solid.mx` file (`isMx` excludes
  the extension), so the editor and the build agree by construction.
  **The stamp rides the AST rather than a parser-level collector, and that is
  load-bearing**: the bridge runs *speculatively* — the TypeScript plugin
  tries the MX grammar inside a `tryParse` on every `<` in expression
  position, including ones that turn out to be generic arrows — so a losing
  attempt throws its node away. A collector would keep that attempt's imports;
  a stamp goes with the node. Same pattern as `collectMxRegions`.
- **`compileSolidUnit` is the Solid host's whole-file entry point**, beside the
  region entry point `compileSolidMx`. A tag unit is a *file*, so its
  module-level statements are **placed** rather than rejected — which is the
  one thing the region compiler cannot do. It deliberately does **not** emit
  `export interface Input`: Solid's compiler takes source text and has no
  TypeScript frontend (the caller is stripped before it ever sees it), so a
  type declaration there is a downstream syntax error. Typing a unit's props
  is phase 3, through the same virtual-file projection the TypeScript plugin
  already does for `.solid.mx`.

## `@mxlang/solid`: the Solid host on `@mxlang/core`

`packages/hosts/solid` (`@mxlang/solid`, decisions 69, 71, 72, 79, 81) is the
third emitter over the core IR — SolidMX's `.solid.mx` becomes Solid JSX
text instead of a string or Astro template. `packages/hosts/solid/README.md`
carries the full lowering table (IR kind to Solid JSX), the error list, and
the `.solid.mx` bridge paragraph; the summary here is the package-map entry.

Two facts worth knowing before touching it:

- **It is an `Emitter<string>`, same shape as `@mxlang/astro`'s
  `.amx` emitter**: `IfChain` becomes `<Show>` (≤2 conditioned branches) or
  `<Switch>/<Match>` (3+); `For` becomes `<For each keyed>` (`of=`/`in=`) or
  `<Repeat count from>` (`from=`/`to=`/`until=`, with `step` folded into a
  per-row callback when present); `<try>` is a `HostTag` (`claimsTag`/
  `resolveHostTag`) lowering to `<Loading>`/`<Errored>`.

- **A `<for>` body always reads its params as values; the emitter rewrites
  the reads.** Solid 2 hands some `<For>` callback parameters as accessors
  and the shape follows the keying mode
  (`solid-js/types/client/flow.d.ts`): no `keyed` prop gives a value row and
  an accessor index; `keyed={fn}` (`by="field"`/`by=(fn)`) gives accessors for
  both. Rather than make MX authors write `p().name` on some forms and
  `p.name` on others, every read of an accessor-backed param is rewritten to
  call it, through `@mxlang/core`'s `rewriteAccessorReads` (an AST pass that
  respects shadowing, not a regex). `in=` is the special case: `keyed={e =>
  e[0]}` makes the entry one accessor, so the pair cannot be destructured in
  the parameter list — `([k, v]) =>` throws `TypeError: {} is not iterable` —
  and the callback takes a generated `mxEntry` with `k`/`v` reading
  `mxEntry()[0]`/`[1]`. Reads are rewritten rather than snapshotted to a
  `const` at callback top, which would go stale on a same-key row
  replacement. Assigning to an accessor-backed param is a positioned compile
  error. Full table in `packages/hosts/solid/README.md`. Nothing Solid-specific
  reaches `packages/core` beyond the two IR fields (`ForSource.range.step`,
  `For.key`) every Marko-syntax host needs regardless of target — see the
  core README's IR table.
- **`.solid.mx` region discovery stays in `@mxlang/parser`.**
  `packages/parser/src/mx/{walk.ts,bridge.ts}` (the vendored Babel's JSX
  plugin, replaced to recognize `<` in expression position) find each MX
  region and hand its raw text to this package's `compileSolidMx`, which
  resolves it through `@mxlang/core`'s `parseFragment` and re-splices the
  emitted JSX text back into the surrounding TypeScript AST at the same
  span — so positions and the eventual source map stay anchored to the
  original `.solid.mx` file. `@mxlang/parser`'s own `lower.ts`/`control.ts`/
  `attrs.ts` (the pre-core-IR lowering) are deleted; that lowering now lives
  entirely in this package. See `packages/parser/README.md`.

Decision 72's subset rule removed four SolidMX constructs real Marko itself
rejects (tag params on `<if>`, tag params and attribute tags on native
elements, `<fragment>`) — see `divergences.md`'s "Deferred to MX 2" table for
each construct, Marko's exact error, and the test that used to cover it.

## `@mxlang/preact`: the Preact host on `@mxlang/core`

`packages/hosts/preact` (`@mxlang/preact`, decisions 71, 79, 81, 82) is the
fourth emitter over the core IR, and the first whose target has **no
control-flow components at all**: every structural kind lowers to a plain JSX
*expression*. `packages/hosts/preact/README.md` carries the full lowering
table, the `key` rule, the error list and the `<try>` helper; this is the
package-map entry.

Selected by `package.json`'s `"mx": { "host": "preact" }` (or a lone
`@mxlang/preact` dependency) through `@mxlang/core`'s `resolveHostPolicy` —
the same resolver the Vite plugin, the language server and `mx-tsc` share, so
an editor, a `tsc` run and a build cannot disagree about a `.mx` file.

Six facts worth knowing before editing it:

- **Marko's `content` and JSX's `children` are the same slot under two
  names.** The emitter passes a component's ordinary children the JSX way (so
  a hand-written Preact component is callable from MX) and the emitted
  component bridges the names in its first line, so a template's own
  `${input.content}` still reads them. Without the bridge
  `<Card><p/></Card>` compiled cleanly and rendered an empty card — the S8
  silent-drop class, found by `oracle:preact` rather than by a unit test.
- **Element-vs-component follows Marko's rule, not JSX's.** JSX decides by
  case, so a `tags/`-discovered `<badge/>` emitted verbatim became a literal
  `<badge>` element with the props as attributes. The declarations use the
  taglib lookup and in-scope bindings (the same rule as `@mxlang/html`), and
  `componentAlias` renames such a component in the emitted JSX, binding
  `MxBadge` beside it.
- **A repeated attribute tag is an array**, as Marko does it — which is what
  lets the callee write `<for|it| of=input.item>`. Emitting the prop twice
  let the last one win.
- **Every `<for>` row carries a `key`**, defaulting to the row's own identity
  when `by=` is absent (the item for `of`, the property name for `in`, the
  loop value for a range). Documented as this host's rule rather than left
  implicit; for a list of objects an author wants `by="id"`.
- **`<try>` needs a shipped runtime**, because Preact has no built-in error
  boundary component — only the `componentDidCatch` hook, and
  `preact/compat`'s `Suspense` catches thrown *promises* rather than errors.
  `src/runtime.ts` exports `MxErrorBoundary` (a class, the only form Preact
  gives that hook), `MxPlaceholder` (`Suspense` under one name) and
  `mxClass`. This does not contradict decision 82: it is Preact code an author
  would otherwise write by hand, not an MX runtime, and a template that uses
  none of it imports none of it.
- **Preact-only vocabulary lives in `src/target.ts`.** The JSX import source,
  `class` versus `className`, the raw-HTML prop and the boundary module are a
  `Target` object so a React package can reuse this emitter. A knob that would
  need an `if (target.kind === "react")` in the emitter does not belong there.

`bun run oracle:preact` (`packages/oracle/src/report-preact.ts` +
`preact-render.ts`) compiles every fixture in the stock `.marko` set — the
same 43 `oracle:marko` uses — renders it with `preact-render-to-string`, and
compares against `expected.html`: **30 pass, 13 skipped(reason), 0 bugs**. It
passes `htmlEquals`'s new `attributeOrder: "ignore"` option, since Preact owns
its serializer and emits props in its own order; `oracle:marko` keeps the
strict default, where attribute order is real output. Like `oracle:marko` it
is a CI job rather than part of `verify` — one heavy process at a time.

**The virtual script kind is TSX for every host** (`mx-language.ts`), not just
this one: a Preact component's body is JSX, and parsed as plain TS its
`return (<>…)` is a syntax error that surfaced as the module appearing to have
no exports ("File '…/Counter.mx' is not a module"). TSX is a superset for the
other hosts' JSX-free output, whose one narrowing (`<T>x` as a type assertion)
none of them emits.

## `@mxlang/react`: the React target on the shared JSX emitter

`packages/hosts/react` (`@mxlang/react`, decision 81) depends on
`@mxlang/preact` and passes `reactTarget` to its exported emitter. This is a
deliberate shared implementation, not a compatibility layer: the structural
lowering is identical, while the target object changes the JSX import source,
`className`, `htmlFor`, Fragment module and runtime-helper module.

The runtime is native React. `src/runtime.ts` imports `Component` and
`Suspense` from `react`; `MxErrorBoundary` is a class using
`getDerivedStateFromError`/`componentDidCatch`, and `MxPlaceholder` wraps
React's own Suspense. Stateful Marko tags remain compile errors with React
hook guidance. Host selection is `"mx": { "host": "react" }` or a lone
`@mxlang/react` dependency, through the same resolver used by Vite, the
language server and the TypeScript plugin.

`bun run oracle:react` renders the stock 43 fixtures through
`react-dom/server`'s `renderToStaticMarkup`: **30 pass, 13 skipped(reason), 0
bugs**. React 19 automatically prepends image preload links during static
rendering; `react-render.ts` strips only those transport hints before the same
semantic HTML comparison. The live error-boundary and hook behavior is covered
by `examples/react-app`'s Chromium e2e.

## `@mxlang/hono`: the Hono target on the shared JSX emitter

`packages/hosts/hono` (`@mxlang/hono`) depends on `@mxlang/preact` and passes
`honoTarget` to its exported emitter, the same shared-implementation shape as
`@mxlang/react`: native `class`/`for` (Hono, like Preact, accepts them
directly), `dangerouslySetInnerHTML` for raw HTML, and `<try>` lowers straight
to `hono/jsx`'s own **built-in** `ErrorBoundary`/`Suspense` — no hand-rolled
boundary class needed, unlike Preact/React, since Hono ships one.

Two `Target` knobs on `@mxlang/preact`'s shared emitter exist because of this
host: `errorBoundaryFallbackProp` (Hono's `ErrorBoundary` takes
`fallbackRender`, not `fallback`) and `errorBoundaryFallbackAlwaysFunction`
(that prop has no non-function form, so a param-less `<@catch>` is wrapped in
`() => …`). Both default to Preact's/React's existing `fallback` behavior — a
third knob, `mxClassModule`, lets `mxClass` import from this package's own
`runtime.ts` (`hono/jsx` has no `mxClass` equivalent) while `ErrorBoundary`/
`Suspense` still import from `hono/jsx` itself. `src/runtime.ts` exports only
`mxClass`. Host selection is `"mx": { "host": "hono" }` or a lone
`@mxlang/hono` dependency, through the same resolver used by Vite, the
language server and the TypeScript plugin.

`@mxlang/hono/bun` registers a Bun plugin loading `.mx` as
`loader: "tsx"` — the same shape as `@mxlang/html/bun`'s plugin, `"tsx"`
instead of `"ts"` since this host's compiled output contains JSX. Bun honors
the emitted `/** @jsxImportSource hono/jsx */` pragma per compiled file; a
hand-written `.tsx` sibling with no pragma of its own still needs the running
script's *own* project `tsconfig.json` (not a `--tsconfig-override` pointing
elsewhere) to set `jsxImportSource: "hono/jsx"`, or Bun's JSX transform
silently falls back to a different runtime for that one file — measured: it
broke Hono's `ErrorBoundary` for a non-throwing child with an opaque
`str.search is not a function` error, only when a sibling `ErrorBoundary` with
a *throwing* child was also present in the tree. See `examples/hono-app`'s
`dev`/`e2e` scripts, which run under the example's own `tsconfig.json`.

`bun run oracle:hono` renders the stock 43 fixtures through `hono/jsx`
(`String(jsx(Component, input))`, awaited when the tree contains a caught
error — `ErrorBoundary` resolves asynchronously once its child throws): **30
pass, 13 skipped(reason), 0 bugs**, identical to `oracle:preact`/
`oracle:react` since all three share the emitter and skip list. The live
`<try>`/`<for>` behavior is covered by `examples/hono-app`'s Playwright e2e
against a real Hono-on-Bun server.

## `@mxlang/html`: the vanilla HTML host on `@mxlang/core`

`packages/hosts/html` (`@mxlang/html`, decisions 66, 68) compiles an
**ordinary Marko template** to a runtime-free `(input) => string` module. Not
a dialect: tag discovery through taglibs and `tags/` directories, Marko's own
HTML/SVG/MathML element registry, Marko's attribute-tag and component
conventions. The seam is `config.translator` — package-name discovery is a
dead end, since 5.42.5 scans only `@marko/runtime-*`.

The generic half now lives in `packages/core` (`@mxlang/core`) — see
"`@mxlang/core`: the Marko-node consumer" below. `packages/hosts/html` keeps
`translate.ts` (the policy rows, `strictPolicy`), `bun.ts`, `types/`,
`example.ts`, the taglib and the fixtures; its `index.ts` is a thin wrapper
over the core's `compileSource`, and its own `emitProgram` is now a
`postEmit(code: string) => string` pass that appends the
`classValue`/`styleValue`/`escapeComment`/`renderDynamic` helpers a template
actually calls. `escape` moved to the core and is re-exported here, so every
compiled template's `import { escape } from "@mxlang/html"` is
unchanged. The `./core` export is **gone** (breaking): importers take
`@mxlang/core` directly.

Policy table (decision 65): the target renders what Marko's server render
emits, minus resume markers. **Inert** (accepted, no output, each verified
byte-identical against Marko): `<effect>`, `<lifecycle>`, `<script>`, `<id>`,
`<log>`, `<debug>`, `client` blocks (client-only), and `by=` on `<for>`. A
`server` block is **not** inert — this is the server render, so it runs and
hoists like `static`, and its bindings are readable from the template
(verified: `server const S = 41 + 1` then `${S}` renders `42`). `<return>` is
an error: it hands a value to a parent template, and a module compiled to
`(input) => string` has no parent. **Evaluate initial
value**: `<let>`, `<const>`, `:=`. **Error** — only what the target genuinely
cannot: `<await>` (Marko itself refuses to render one to a string) and
`<try>` with a `<@placeholder>` (needs a second pass). A plain `<try>` with
`<@catch>` lowers to `try`/`catch`.

**Inert is a shape, not a licence to drop.** An inert row declares the body
and attributes its own Marko tag definition allows, and anything else is an
error naming the tag and what was found — otherwise
`<effect><div>x</div></effect>` compiles clean with the `<div>` deleted, which
is the S8 silent-drop class reopened. The declarations are per tag because
Marko is: `<effect foo="bar"/>` and `<log=1 foo="bar"/>` are refused there,
while `<lifecycle foo="bar"/>` compiles (a lifecycle tag's attributes are its
configuration), and `<script>` is the one inert tag taking a body (raw text).

Some constructs need no row at all, because Marko's own parser rejects them
before a translator runs — do not add code for these, and do not read their
absence as tolerance: `key=` on an element, and `$!{…}` in an attribute value.

`class:foo`/`style:foo` are a separate category: **not Marko syntax**, rather
than something this target cannot express. Marko has no such modifier and says
so (*"`class:active` is not a valid attribute, did you mean
`class={ active: condition }`?"*), so the translator errors with Marko's own
fix-it. There is no behaviour to reproduce and no fixture to write, since no
`.marko` file using them compiles at all.

A **render-scope** binding named `input` (`<let/input=…>`, `<const/input=…>`)
is rejected: it would shadow the emitted `function (input: Input)` parameter
and make the template's own input unreachable, and Marko refuses it as a
duplicate declaration. A **tag param** (`<for|input|>`, `<define/R|input|>`) is
*accepted*, because it opens a nested scope where an ordinary JS shadow is
correct — Marko renders those. Rejecting them would be an implementation limit
stated as a rule, which decision 65 forbids. Note the codegen consequence: a
`<for>`'s iterable is bound to a temporary before the loop opens, or a param
shadowing the name used in the iterable (`<for|input| of=input.items>`) hits
the temporal dead zone and throws at render time.

Two behaviours worth knowing before editing the policy, both verified rather
than assumed:

- **Marko hoists `value` first on `<input>`**, so
  `<input type="text" value=x>` emits `<input value=… type=text>`. A browser
  applies `type` before `value`, and some types reinterpret a later `value`.
  `orderAttrs` in the policy reproduces it; `htmlEquals` compares attribute
  order, so getting this wrong fails the oracle.
- **`class`/`style` take structured values**: `class={a: true, b: false}` →
  `class="a"`, `class=["x", {y: true}]` → `class="x y"`,
  `style={color: "red", top: 0}` → `style="color:red;top:0"`. These lower to
  emitted `classValue`/`styleValue` helpers, inlined only when called, so a
  template using none of them still compiles to `escape` and concatenation
  alone.

`bun run oracle:marko` prints one table, for
`packages/hosts/html/fixtures-marko` — see the "oracle:marko" section above
for the current fixture count and pass/skip/bug totals. Fixture
`expected.html` files are generated from real Marko, never hand-written.

### The `strict` policy

Decision 68's policy fold: the retired `.mx` dialect rejected reactive
constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks,
`<id>`) by name, since standalone MX had no reactive target at all. The
default `policy` above instead renders what Marko's own server render would
emit for those (inert, or `<let>`'s initial value) — decision 65's table.
`strictPolicy` (`translate.ts`) keeps `.mx`'s stance as an *opt-in*: the same
six constructs become errors naming the construct, for an author who wants
"this needs a reactive runtime" to be a compile error. `compile`/`compileFile`/
`build` take `{ strict: true }` to select it. The `input`-shadowing check
(`checkBinding`) is **not** `strict`-only — it was already the default in
both the old `.mx` policy and this one, since a `<let>`/`<const>` binding
named `input` silently breaking the template's own input is a bug either way,
not a stricter preference. Dropped rather than folded in (decision 65: these
were conventions of the old `.mx` walk, not target capabilities, so they do
not survive as a policy toggle): the explicit-import requirement, the
`export interface Input` requirement (Marko allows arbitrary TS regardless),
`<fragment>`, and lowercase-by-scope tag resolution.

`<html-comment>` lowers placeholders as Marko does, through an emitted
`escapeComment` helper that escapes **only `>`** — `<`, `&` and quotes pass
through raw, matching Marko's own `_escape_comment`. Filtering placeholders
out (an earlier bug) turned `<html-comment>build ${input.sha}</html-comment>`
into `<!--build -->`.

## `@mxlang/astro`: the Astro host

`packages/hosts/astro` (`@mxlang/astro`, decisions 70 to 72) renders `.mx`
components inside an Astro project as **static markup**: no islands, no
hydration, no client JS from this renderer. Two files and no third —
`src/index.ts` is the integration, `src/server.ts` the renderer's server
entrypoint. There is no compile step of its own: the integration adds
`@mxlang/vite-plugin` through `updateConfig({ vite: { plugins: [...] } })`,
since an Astro project is a Vite project and that plugin already turns a
`.mx` file into a plain module.

Four facts worth knowing before editing it:

- **`check` tests a brand, and the brand is emitted by the *translator*.**
  Astro's renderer contract hands `check(Component, props, slots)` the
  component as an opaque value with no reserved brand channel, and Astro's own
  docs suggest sniffing `Component.name` — which a minifier may rewrite and
  any function could collide with. Instead `@mxlang/html`'s `postEmit`
  (`brandRender` in `translate.ts`) names the core's anonymous default export
  `render`, marks it, and exports it, so every compiled MX module carries
  `Symbol.for("mx.component")`. `Symbol.for`, through the global registry, not
  a `unique symbol`: the property is written by a compiled module and read by
  a different package, possibly from a different copy of the translator on
  disk, so the two sides cannot agree by import identity. It is written with
  `Object.defineProperty`, not `render[Symbol.for(…)] = true` — the emitted
  module is TypeScript a consumer typechecks, and the assignment form is
  `TS7053` under `strict`, which would make every compiled template a type
  error in the user's own build.
- **Slots are strings; MX's children are thunks.** Astro hands slots in as
  `Record<string, string>` of already-rendered HTML, while MX's compiled
  modules take children as a `content: () => string` prop and each `<@name>`
  attribute tag as `name: () => string`. `renderToStaticMarkup` wraps each
  slot string in a thunk (`default` → `content`, every other key → the
  attribute tag of the same name). Two limits follow, both Astro's contract
  rather than MX's: an attribute tag declaring **params** (`<@footer|year|>`)
  can never receive them from Astro, and is documented rather than detected
  (the renderer sees a compiled function, not the template); and slot HTML is
  inserted verbatim, so a template must use `$!{input.content()}`, never
  `${...}`, or the markup Astro rendered comes out escaped.
- **The host compiles under `strictPolicy`**, so `<let>`, `<effect>`,
  `<lifecycle>`, `<script>`, `client` blocks and `<id>` are compile errors
  naming the construct (decision 71: stateful tags mean whatever the host
  says, and this host has no reactive target at all). That required the one
  change to `@mxlang/vite-plugin` this package needed: a `strict?: boolean`
  option on `MxPluginOptions`, passed straight through to `compile()`. It is a
  passthrough, not a policy of the plugin's own; `.solid.mx` never goes
  through the translator and is unaffected.
- **No `clientEntrypoint`, and the host raises the `client:*` error itself.**
  `AstroRenderer` declares the field optional, so a hydration-free renderer is
  a first-class shape. The research note (and this file, before it was
  measured) claimed `client:*` on such a component raises Astro's own
  `NoClientEntrypoint`. **It does not, in astro@7.3.2.** That error is defined
  in `dist/core/errors/errors-data.js` and thrown from nowhere — grepping the
  whole installed package finds only the definition and its `.d.ts`. The render
  path is a bare `if (renderer.clientEntrypoint)`
  (`dist/runtime/server/hydration.js:98`) that skips `renderer-url`,
  `component-export` and `props` when absent, with no else branch. Left alone
  the build would succeed and emit an `<astro-island client="load">` whose
  loader falls back to `Promise.resolve({default:()=>()=>{}})` — an island that
  silently does nothing, on a host whose claim is shipping no client JS.
  Decision 70's intent is that the directive is an error, so
  `renderToStaticMarkup` throws on `metadata.hydrate` (Astro's own fourth
  argument; `AstroComponentMetadata.hydrate` is
  `'load'|'idle'|'visible'|'media'|'only'`, and `displayName` names the
  component). `examples/astro-static/e2e/build-errors.spec.ts` asserts the
  failing build.

### `.amx`: AstroMX templates (decisions 76c, 78)

An `.amx` file is an **Astro component whose template is MX** — a different
file kind from `.mx`, not a variant of it. A `.mx` component compiles to a
runtime-free `(input) => string` and is called *through* this package's
renderer; an `.amx` component **becomes** an Astro component: the `---` fence
passes through byte for byte with Astro's own semantics (`Astro.props`,
imports, `getStaticPaths`), the MX template after it is lowered to Astro
template syntax, and the whole file goes to Astro's compiler. Components,
layouts and pages, all from one extension (`addPageExtension(".amx")`).

Four facts worth knowing before editing `src/astro-template.ts` or
`src/vite-templates.ts`:

- **The extension is single-dot because of Astro's router, not taste.**
  `.astro.mx` was the first spelling and works for components, but Astro's
  route collection keys on `path.extname(basename)`, which returns only the
  **last** extension segment (`create-manifest.js`; `parse-route.js` does the
  same through `@astrojs/internal-helpers`' `fileExtension`, which is
  `path.split(".").pop()`). Measured against astro@7.3.2: a `page.astro.mx`
  under `src/pages` is `continue`d as an unsupported file type, and once `.mx`
  is also registered it is routed to `/page.astro/` — a literal `.astro` in
  the URL. Note `dist/core/util.js`'s `endsWithPageExt` *does* use `endsWith`,
  so `isPage()` accepts what route collection rejects: two code paths in one
  version disagree. `.amx` sidesteps all of it.
- **This is `Emitter<string>` over core's IR.** `.amx` uses `parseFragment` for
  fence-relative positions, then `lower()` and the shared `drive`/`emit`
  traversal. Astro-specific decisions happen in `HostDeclarations`; the
  emitter consumes IR and opaque `HostTag.data`, never Marko nodes. `static`
  statements resolve into `Ir.hoisted` and are inserted into the fence.
- **Typing composes two maps.** The emitter records the unchanged fence,
  expressions, attribute names, `<for>` params, and whole hoisted blocks at
  their generated write offsets. `createAmxLanguagePlugin` composes those
  `.amx`-to-Astro spans with `@astrojs/compiler/sync`'s `convertToTSX` map;
  only intersections surviving both stages become Volar `CodeMapping`s.
  `.amx` is registered only by `{ astro: true }` and `mx-tsc --astro`.
- **The Vite mechanism is forced.** Astro's `astro:build` `transform` filters
  `include: [/\.astro$/, /\.astro\?/]` **and** re-checks
  `if (!parsedId.filename.endsWith(".astro")) return;`, so an `enforce: "pre"`
  transform on the real `.amx` id can never reach Astro's compiler. The module
  id itself must end in `.astro`: `resolveId` appends that suffix to whatever
  Vite's own resolver returns, `load` returns the lowered source. Same shape
  `@mxlang/vite-plugin` already uses for `.solid.mx`.
- **An attribute method can be a `FunctionExpression` value, not `attr.arguments`.**
  `<button onClick() { … }>` arrives with `arguments` falsy and the method body
  as the attribute's *value* (measured against `@marko/compiler` 5.42.5).
  The resolver detects both shapes and lets Astro provide the target-specific
  diagnostic through `rejectAttributeMethod`.

The lowering table and the full error list live in
`packages/hosts/astro/README.md` "AstroMX templates (`.amx`)". Nothing silently
degrades: every construct this target cannot express is a build error naming
the construct, the reason and the `.amx` line.

Astro projects get per-file `.mx` types from
`@mxlang/typescript-plugin`, not an ambient wildcard. The old
`packages/hosts/astro/types/mx.d.ts` and `@mxlang/astro/types` export are
deleted: they erased every component's real `Input`. Configure one Volar
plugin entry, `{ "name": "@mxlang/typescript-plugin", "astro": true }`; do
not also list `@astrojs/ts-plugin`, because the second Volar tsserver plugin is
silently skipped. Command-line checks use `mx-tsc --astro --noEmit`.
Both paths also type-check `.amx` itself through the composed AstroMX plugin;
without Astro mode, `.amx` files are ignored.

## `@mxlang/angular`: the Angular host on `@mxlang/core` (in progress)

`packages/hosts/angular` emits an Angular template string from a `.mx` page
template (`compile()`, `src/index.ts`); the emitter (task 1.3) covers every
structural kind. See `notes/investigations/angular-host-design.md` for the
design (A1: the lowering table; A3: the CLI).

`bun run oracle:angular` (`packages/oracle/src/report-angular.ts`,
`runAngularTable`) is the oracle table: each fixture under
`packages/oracle/fixtures/angular/<name>/` is either a **pass** fixture
(`input.mx` + `expected.html`, byte-compared to the emitted template, plus
`expected.warnings.txt` for a fixture whose A1 row is a Warning — one
message per line, byte-exact, in emission order; absent means zero
warnings) or an **error** fixture (`input.mx` + `expected.error.txt`,
matched exactly against the `TranslateError` message with `compile()`'s
absolute-path prefix stripped). Every pass fixture is additionally checked
against the real `@angular/compiler@22.1.7`:
`parseTemplate(emitted, name).errors === null` and a span-stripped AST
snapshot in `packages/oracle/fixtures/angular/__golden__/<name>.ast.json`
(regenerated with `--update`). `bun run oracle` runs this table too (after
its own Solid twin table) and folds its result into the exit code, and
`packages/oracle/test/angular.test.ts` runs it through `bun run test` /
`bun run verify` so a regression here fails CI, not only a developer's own
`oracle:angular` run. A third kind joined the two above in task 1.7: a
**tag** fixture (`input.mx` + `expected.ts`) compiles through
`compileTagModule` and byte-compares the emitted component module, then
extracts its `template:` string and puts that through the same
`parseTemplate` gate. A tag fixture is staged under its *own* basename (the
directory name minus `tag-`), since a tag's selector and class come from its
filename and `input.mx` would name every component `Input`; a fixture with
its own `tags/` directory is staged in a temp directory with a
`package.json` boundary, because discovery walks upward from the compiled
file. See `packages/oracle/fixtures/angular/README.md` — its "rows
intentionally absent" list is now empty — and the `<for in=>` ordering
rationale.

**`mx-angular build`/`map` (task 1.5a); `watch` (task 1.5b, incremental).**
`mx-angular build [--project <dir>] [--config <file>]` (`src/cli.ts`) reads
`package.json#mx.angular` (`include`, `pageExtension`, `tagExtension`,
`tagSelectorPrefix`, `onError` — A3's defaults; an unrecognized key is a
positioned error naming it) and compiles `include` ∪ the discovered tag
index (a `.mx` file under any `tags/` directory or `package.json#mx.tags`
entry, found via `@mxlang/core`'s `scanCached` — since that scan only walks
*upward* from a file, `src/discover.ts` walks the project tree itself to
find every `tags/` directory and every package boundary, then calls the
scan from inside each one; a `mx.tags` entry's own `hosts` restriction is
honored by re-reading that entry directly, since the scan's own
`DiscoveredTag` drops it). A page compiles to `pageExtension` beside its
source, with a generated-header comment (a second line naming the
`import`/`imports:` to add per called MX tag, when the compiled template
called at least one — sourced from the emitter's own `usedTagNames()`, not
parsed out of its warning text) and a `.map` sidecar (a plain source-map v3
envelope; `compile()`'s own `mappings` is always empty today, so
`mx-angular map` reports the source file and says fine-grained mapping
isn't available yet, rather than fabricating a line/column). Every warning
`compile()` produces prints to the terminal, `file:line:col warning: ...`.
**A discovered tag file compiles to a component module** (task 1.7,
`src/tag-module.ts`'s `compileTagModule`): a `.mx` under `tags/` emits
`tagExtension` (`.ts`) holding a standalone `@Component` — inputs from
`export interface Input` (`required: true` when not optional, the type
copied verbatim, **no `@Output()` inference**), `<ng-content>` for
`${input.content()}` and `<ng-content select="[x]">` for `${input.x()}`
(repeating one is an error: Angular matches each selector once), `mx-` +
kebab-cased basename as the selector unless the tag exports its own, and
the tag's `static`/`import` placed at module scope. The class is named by
core's `exportNameFor`/`moduleExportName` (tag-unit 2b), the same
derivation every module-emitting host uses. The *template* is built by the
page emitter, so the two output kinds cannot disagree about how a construct
lowers. Two things the emitted module must get right, both measured rather
than assumed: a template reads an input by its **bare name**, because
Angular resolves against the component instance — emitting
`{{ input.name }}` parses cleanly and renders **empty** (`parseTemplate`
cannot catch it, so the tests assert the expression text); and a
*discovered* tag reaches the emitter under a gensym'd binding
(`$mx_Icon1`, `template-tag.ts`'s `bindingForTemplate`), so the selector is
resolved through the import's specifier rather than from
`Component.target.name`, which would emit the invalid `<mx-$mx-icon1>`.
The rewrite covers `input.x`, `input?.x` (a distinct
`OptionalMemberExpression`), `input["x"]`, nested `input.a.b` and arrow
bodies, and honours every binder that shadows the name — a `<for|input|>`
param (read off the core's `For.bindings`; `params` beside it is *source
text* and never matches), a `<const/input=…>` (sequentially, as the emitted
`@let` rebinds from that point), a function parameter and a destructuring
pattern. `input[k]` is a positioned error. `Input` itself is parsed with
Babel (the core's own instance) taking each type as a verbatim source
slice; the text scan that stood here first dropped newline-separated
properties, mis-sliced arrow types and broke on comments. Three slot
misuses are errors rather than silent blanks: a name read both as a slot
and bare, a slot called with arguments, and a slot passed through as an
attribute. An authored `import Child from "./child.mx"` is emitted once,
by MX, pointing at the generated module — `isTagModuleImport` is the one
rule both halves consult so they cannot disagree and emit it twice.
`mx.angular.tagSelectorPrefix` is wired through both entry points.
Calling a discovered tag from a page is no longer the module-level error:
the synthesized `Import` is resolved to a component reference, while an
**author-written** `import`/`static`/`export` still is one. Only writes an
output when its bytes differ,
and refuses to overwrite any output — page or tag — lacking the generated
header (`checkOverwriteGuard`, `src/build.ts`, wired into `build()` itself,
not merely exported for direct testing — including the `onError` failure
path: a compile error never overwrites or deletes a hand-written file at
the output path, in any of the three modes). A tag-template's own compile
error carries `file` pointing at the tag, not the caller, and is reported
against that file (A5). Containment checks resolve real paths
(`fs.realpathSync`), not merely normalized ones, so a symlinked `tags/`
directory or output path cannot be used to read or write outside the
project directory.

**The emitted `.html` (and, once 1.7 lands, tag `.ts`) files are generated
artifacts**: `.gitignore` them, and run `mx-angular build` (or `mx-angular
watch`, for a long-running dev loop) *before* `ng serve`/`ng build` —
Angular's own template resolution needs the emitted file to already exist
on disk; there is no in-memory hand-off. Exclude `.mx` sources (not emitted
tag `.ts` modules) from `tsconfig.json` and from `angular.json`'s `assets`
array.

**`mx-angular watch`** (`src/watch.ts`, `startWatch(projectDir, options)`)
runs the initial `build()`-equivalent pass, then an incremental loop:
`fs.watch` on `include` ∪ every discovered `tags/` directory (`discoverFiles`'s
new `tagDirectories`, since a `tags/` directory holding only a sidecar
`.tag.ts` — no `.mx` template — never appears in `files`, which is `.mx`
only) ∪ the project root (for `package.json`), one non-recursive watcher per
directory (portable across platforms rather than relying on macOS/Windows-only
recursive support), debounced 50ms per A3. Dependency tracking: each page's
last compile records the `usedTags` names the IR actually kept (a
`Component` node survived); a sidecar `transform` returning IR directly
(a macro, per `@mxlang/core`'s own docs "the only expansion left in the
language") leaves no `Component` node and therefore no `usedTags` entry, so
`recordDeps` also scans the page's raw source for every discovered tag name
as a literal `<name` occurrence — a deliberate over-approximation (a
spurious rebuild costs nothing; a missed one silently serves stale output).
A changed page recompiles only itself; a changed tag path (template or
sidecar) recompiles every page whose recorded dependency set contains it; a
`package.json` change, or an `.mx` file appearing/disappearing outside the
already-routed set, triggers a full rebuild, since either can change
routing itself. `onIdle` cannot fast-path on "nothing pending right now" —
a caller reads it right after a synchronous `writeFileSync`, before
`fs.watch`'s genuinely-async delivery has necessarily fired — so it polls
for a *quiet* window (no debounce timer, no in-flight rebuild) sustained for
`max(100ms, debounceMs * 4)`, long enough to absorb realistic `fs.watch`
delivery latency without becoming a fixed sleep. `--once` skips starting any
watcher and resolves `onIdle` off the initial build alone (for CI and tests).
The CLI's non-`--once` path resolves on `SIGINT`/`SIGTERM` (`Ctrl-C`, exit
0).

## `@mxlang/language-server`: diagnostics-only LSP server (decision 71/72)

`packages/tooling/language-server` (`@mxlang/language-server`) exists to close one
gap decisions 71/72 name explicitly: "a host is not done without its editor
diagnostics." Marko's own language server (`marko-js/language-server`)
compiles every `.marko`/`.mx` file with a **hardcoded** compiler config that
carries no host policy (`Project.getCompiler(dir).compileSync(text,
filename, compilerConfig)` in its `validate.ts`, with no `translator` key),
so a construct a host's `strict` policy rejects — `<let>`, `<effect>`,
`<lifecycle>`, `<script>`, `:=` — is valid Marko syntax and Marko's server
reports nothing for it. `tsserver` cannot fill the gap either: it never opens
`.marko`/`.mx` files at all, only `.ts`/`.tsx` files that *import* one (that
is what `@marko/ts-plugin` and `@mxlang/typescript-plugin` type-check). Full
research: `notes/research/host-diagnostics.md`.

**Scope: diagnostics only.** `textDocumentSync` is the one capability
advertised. No completion, hover, go-to-definition, or formatting — adding
any of those would mean re-implementing Marko's own language server, which
this package runs *alongside*, not in place of. Both VS Code and Zed support
multiple language servers registered against one language id (ESLint+TS,
Tailwind+CSS are the everyday examples); this is a supported pattern, not a
workaround.

**Mechanism.** `src/diagnose.ts`'s `diagnoseDocument(text, uri, hostPolicy,
onUnexpectedError?)` runs `@mxlang/core`'s `compileSource` under the resolved
policy; a thrown `TranslateError` (which carries 1-based `line` and 0-based
`column`, `@mxlang/core`'s `fail()`/`TranslateError` shape) becomes one LSP
`Diagnostic` (`severity: Error`, `source: "mxlang"`, message verbatim); a
successful compile returns `[]`, which the caller publishes to clear any
stale diagnostics; any other exception is swallowed and reported through the
callback rather than crashing the server or publishing something wrong — both
paths are unit-tested directly against `diagnoseDocument`, no server needed.
`src/server.ts` wires this into a `vscode-languageserver`
`TextDocuments`/`Connection`, debouncing 150ms per document URI (a
superseded run's timer is cleared, never raced) on `didOpen`/`didChange`/
`didSave`, and clears diagnostics on `didClose`.

**Policy resolution** (`@mxlang/core`'s `src/host-policy.ts`, shared with
`@mxlang/typescript-plugin`) answers the question an
editor's `didOpen` cannot: which host, and whether `strict`, applies to this
file. Three branches, in order, walking upward from the file for the nearest
`package.json`: (1) a `"mx": { "host": ..., "strict"?: ... }` field, the
authoritative source, which doubles as the routing config decision 71's
"mixed projects" case already needs for the Vite plugin/Bun loader; (2)
failing that, if the `package.json` depends on **exactly one** `@mxlang/*`
host package (`@mxlang/html`, `@mxlang/astro`), that host at its
default policy; (3) otherwise, the translator's default (non-strict) policy.
`@mxlang/astro` always compiles under `strictPolicy` (decision 71: it ships
no stateful tags) — `resolvePolicyObject` in `diagnose.ts` special-cases
`host: "astro"` to `strictPolicy` regardless of the field's own `strict`
value, since that host has no other mode. `host: "solid"` remains a
placeholder for a different reason than before: `@mxlang/solid` ships now
(the Solid host on `@mxlang/core`, see below), but this server has no
`.solid.mx`-document diagnostics path yet — `.solid.mx` is MX regions inside
a TypeScript module, not a whole-file Marko template the way `@mxlang/html`
compiles, so wiring it needs its own diagnose path, not just a `Policy`
object. `resolveStrict` falls back to the translator's own default rather
than throwing, keeping the rest of a mixed workspace diagnosed.

**Zed finding** (brief item 4): there is **no zero-Rust path** to register a
second `[language_servers.*]` entry in Zed's `extension.toml`. Reading
`marko-js/zed`'s own `extension.toml` and `src/lib.rs` (via `gh api
repos/marko-js/zed/contents/...`, no local checkout) confirms
`[language_servers.marko]` binds `languages = ["Marko"]` to that extension's
own `zed::Extension::language_server_command` implementation — a
`Cargo.toml`-backed Rust extension is what makes the entry work, not the TOML
table alone. `packages/editors/zed` is grammar-only today (no
`Cargo.toml`, see "No Rust" in the Zed extension section above) *because* it
registers no language server; adding this server's registration is therefore
new scope (a Rust crate) for that package, tracked as follow-up rather than
done in this task (time budget). `extension.toml` gained a comment
documenting this finding at `[grammars.marko]`. Both VS Code
(`LanguageClient` targeting `language: "marko"`, a second registration
alongside Marko's own) and Zed (`[language_servers.<key>]`, once the Rust
scaffold exists) support the second-server pattern once wired; see the
package's own `README.md` "Editors" for the concrete snippets, including the
generic-LSP-client `settings.json` shape for VS Code (which ships no
dedicated extension from this task, per brief scope).

*(Update, task `zed-ls-registration`, decision 77: the Rust scaffold this
paragraph names as follow-up now exists — see "Zed extension" above. VS
Code still ships no dedicated extension.)*

**Tests**: `src/diagnose.test.ts` (direct, no server: `<let>` under strict,
a valid file, `<let>`'s initial value under the non-strict policy, the
unexpected-exception path), `@mxlang/core`'s `src/host-policy.test.ts` (all six
resolution branches — explicit `mx`, the deprecated `translator` alias,
one host dependency, two host dependencies, no `package.json`, and the
walk-up stop at the filesystem root — against fixture directories under
`packages/core/src/fixtures/host-policy/`; this package keeps its own
`src/fixtures/` for `server.test.ts`'s end-to-end documents), and
`src/server.test.ts` (the one stdio end-to-end test the brief asks for:
spawns the real built `dist/bin.js` with `bun run ... --stdio`, exchanges
`initialize`/`didOpen` via `vscode-jsonrpc`'s `createMessageConnection`, and
asserts the resulting `publishDiagnostics` notification; the child process is
killed in `afterEach`, honoring the load rule's "kill what you start").
Requires `bun run build` to have produced `dist/bin.js` first — the same
fresh-worktree caveat as `@mxlang/parser`'s `dist/index.js` (see "Running
tests in a fresh worktree" above): `bun run verify` builds before it tests,
so this only bites a standalone `vitest run` of this package.

## `@mxlang/typescript-plugin` and `@mxlang/tsc`: TypeScript for MX files (decision 81)

`packages/tooling/typescript-plugin` and `packages/tooling/tsc` are the two
halves of one job: type-check `.solid.mx` and `.mx` from the TS/TSX
each host emits.
Each package's own `README.md` carries the full story; this is the package-map
entry.

- **`@mxlang/typescript-plugin`** is the editor half — a Volar
  `LanguagePlugin` (`src/language.ts`) plus a tsserver plugin
  (`src/index.ts`, loaded via `compilerOptions.plugins`).
  `createVirtualCode` runs `@mxlang/parser`'s `print()` and wraps the printed
  TSX in a `VirtualCode` whose `CodeMapping`s are decoded from the returned
  map. A `print` failure yields empty virtual code plus one recorded syntax
  error, appended to `getSyntacticDiagnostics` so a bad region reports once,
  at its own position, instead of silently becoming an empty file.
  `src/mx-language.ts` compiles whole-file `.mx` through the host
  `@mxlang/core`'s `resolveHostPolicy` picks from the nearest `package.json`
  (one resolver, shared with the language server, so an editor and a `tsc` run
  cannot disagree about a file's host); because the HTML compiler's map is
  empty, mappings come from the positioned IR nodes the emitter consumed — see
  the mapping-coverage bullet below for what is mapped per expression and what
  whole-block. `{ astro: true }` lazily composes Astro's language plugin
  from the optional exact `@astrojs/language-server@2.16.16` peer.
- **`@mxlang/tsc`** is the CI half — `mx-tsc`, Volar's `runTsc` handed the
  *same* language plugin. It exists because `tsc` ignores
  `compilerOptions.plugins` entirely, so without it an editor would report
  errors a build silently missed. `--astro` adds Astro's plugin and extension,
  and is removed before TypeScript parses its own arguments.

Four facts worth knowing before editing either:

- **`runTsc` needs `require('typescript')` passed as its fourth argument.**
  Its default `typescriptObject` is a proxy resolving names by `eval` inside
  `tsc.js`'s own scope, so it sees only that bundle's locals. `ScriptSnapshot`
  is not one — it is on the public `typescript` module but not the `tsc` entry
  point — and the language plugin dies with `ReferenceError: ScriptSnapshot is
  not defined` before a single file is checked.
- **`createCompoundExtensionResolver` is load-bearing and shared.** Volar
  2.4.28 assumes a custom extension is one suffix, so for `X.solid.mx`
  TypeScript probes `X.solid.d.mx.ts`. The resolver claims no file
  (`getLanguageId` and `getServiceScript` both return undefined) and only
  advertises the terminal `mx` suffix; without it every `import
  "./X.solid.mx"` is `TS2307`. It lives in `language.ts` and is installed by
  both entry points, so an editor and CI resolve imports identically.
- **`mx-tsc` must be CJS.** `runTsc` uses `require`, `require.resolve` and
  `__filename`, none of which exist in an ES module — hence `dist/bin.cjs`.
- **Column accuracy comes from the parser bridge, not from this package.**
  `print`'s map is line-based; the exact columns come from
  `packages/parser/src/mx/bridge.ts` repositioning each Babel node onto the
  source expression it was copied from. `decodeMappings` then keeps only spans
  whose generated and source text match, and merges contiguous ones.
  Whole-file `.mx` is the exception: its HTML map is empty, so the
  plugin maps from the core IR node locations — per expression for every
  `Expr`, and **whole-block** for the five statement kinds (`Static`,
  `Import`, `Export`, `InputInterface`, `Hoisted`), which carry an `end`
  position beside `loc` for exactly this reason. A mapping is emitted only
  when the code is found in both texts, the generated search running forward
  and keyed per code string so repeated text cannot cross-map; when either
  lookup fails nothing is emitted, since a plausible-but-wrong column is worse
  than none. A diagnostic outside every mapping is not surfaced against the
  `.mx` file.
- **`preventLeadingOffset` must stay unset for whole-file `.mx`.** A compiled
  `.mx` module does not preserve the source's line structure, and with that
  flag set Volar's `runTsc` parses its `SourceFile` from the generated text
  alone — so `tsc` converts a correctly mapped source *offset* into line and
  column against the *generated* file's line table, putting every `.mx`
  diagnostic on the wrong line (measured: a two-error fixture reported
  (3,15)/(4,22) for errors on source lines 2 and 3). Unset, Volar pads the
  virtual contents to the source's own lines. `.solid.mx` keeps the flag,
  because its printed output does preserve source lines.

**No ambient `declare module "*.solid.mx"` shim, anywhere.** A shim asserts
types rather than deriving them, so it hides both a file's real exports and
every error inside it. Both examples' `src/mx.d.ts` are deleted; dropping
`todomvc`'s surfaced a real bug it had been masking (a `<fragment>` wrapper,
removed by decision 72, rendering as a literal unknown element).

`packages/tooling/tsc/src/fixtures/` holds two SolidMX projects differing in
one expression. The suite also runs the Astro example's paired
`typecheck-fixtures`: `<Card title="..." />` passes and `<Card title={1} />`
reports TS2322. The failing fixtures stay outside their packages' normal
typecheck inputs.


## Bun loader

`packages/hosts/html/src/bun.ts` (`@mxlang/html/bun`) is the Bun-side
`.mx` integration, decision 58 roadmap item 2, half A (moved here from the
retired `@mxlang/html/bun` by decision 68). It exports a `BunPlugin` that
registers `build.onLoad({ filter: MX_FILTER }, ...)` — `MX_FILTER` is
`/(?<!\.solid)\.mx$/`, `.mx` only; `.marko` is deliberately not registered
(see "`.mx` is the only template extension" above). On each matched `.mx`
file it reads the source, runs it through `compile()`, and returns
`{ contents: code, loader: "ts" }` — `compile()`'s output is plain TypeScript
(an `import`, an optional `export interface Input`, a default-exported
function, no JSX), so Bun's own TS stripper handles it directly with no
second transform.

The plugin object self-registers at import time (`Bun.plugin(markoPlugin)`
runs at module scope, in addition to the `export default`): `bunfig.toml`'s
`preload = ["@mxlang/html/bun"]` runs a preloaded module purely for its
side effects — it does **not** call `Bun.plugin` on a default export
automatically — so without the self-registration call, `.mx`
imports silently fall through to Bun's default loader and resolve to the
file's path string, not a compiled function. `Bun.plugin` is idempotent for
an already-registered plugin object, so `import markoPlugin from
"@mxlang/html/bun"; Bun.plugin(markoPlugin)` (the programmatic form)
still works without double-registering.

`examples/mx-site` uses this loader: `bunfig.toml` preloads it, `.mx` pages
import each other directly (`import Layout from "./layout.mx"`), and
`src/server.ts`/`src/build.ts` import pages directly with no prebuild step.
The compiled-output equality check decision 58 calls for ("cannot paper over
an emit bug") lives in the e2e suite's own content assertions
(`e2e/routes.spec.ts`), run against both the dev server and the static
build — there is no separate golden-file diff, since the rendered HTML
itself is the golden.

`packages/hosts/html/src/bun.test.ts` is a `bun:test` file (not vitest — it
exercises `Bun.plugin` and Bun's own dynamic `import()`, both Bun-runtime
only), run via `bun run test:bun` in that package. `packages/hosts/html`'s
own `vitest.config.ts` excludes it from the vitest project so the root
`bun run test` does not try to load `bun:test` under Node/Vite.

## `.mx` import typing

`packages/hosts/html/types/marko.d.ts` declares `declare module "*.mx"`,
typing the import as `(input: any) => string`. `any`, not each file's real
`Input` interface: per-file typing
needs a virtual-file projection of the compiled module (the same shape
`@mxlang/typescript-plugin` now does for `.solid.mx` — see its own section
below), which is the phase-3 language server's job for this file kind, not
something an ambient wildcard declaration can derive. A consumer references it by adding the file to its own
`tsconfig.json` `include` (see `examples/mx-site` and `examples/mx-vite`);
there is no package-level `types` wiring that pulls it in automatically,
since a `.solid.mx`-only project (the Solid examples) has no reason to load
it.

## Examples

`examples/counter-app` is a Solid 2 app whose components are `.solid.mx`.
`examples/todomvc` is the canonical TodoMVC app (todomvc.com spec), also
entirely in MX: `App.solid.mx` (state, hash-routed filter, localStorage
persistence), `TodoItem.solid.mx` (toggle, double-click-to-edit, destroy),
`Footer.solid.mx` (count, filters, clear-completed). Root `package.json`
`workspaces` includes `examples/*`, so `@mxlang/vite-plugin` and
`@mxlang/parser` resolve as workspace deps, and root `typecheck` covers
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
`@mxlang/html/bun` (the Bun loader — see its own section above), no
Solid, no client runtime, no prebuild step. `src/server.ts` and
`src/build.ts` `import renderX from "./pages/x.mx"` directly, exactly like
any other module; `bunfig.toml` preloads the loader.

`packages/hosts/html/tsconfig.json` maps `@mxlang/parser` to
`../parser/src/public.d.ts` in its `paths`, for typechecking against the
parser's public types without requiring `dist/` to be built first. Bun's
`bun run` also honours `tsconfig.json` `paths` at runtime, and does so per
imported file's own directory, not just the entry point's — so a plain `bun
run` of any script that imports `@mxlang/html` (which imports
`@mxlang/parser`) fails with `Export named 'X' not found in module
".../public.d.ts"`, because Bun resolves the bare `@mxlang/parser` specifier
against `packages/hosts/html/tsconfig.json`'s `paths` regardless of where the
importing file lives. Work around it with `bun run
--tsconfig-override=<path to a tsconfig with no such paths>`; `examples/mx-site`'s
`dev` and `build` scripts do this against the root `tsconfig.base.json`. This
is a property of `translator`'s tsconfig, not a bug in `@mxlang/html`
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
component (the renderer's own error, since Astro raises none — see the
package section above). Both pages live in `error-fixtures/`, **outside**
`src/pages/`, and each is copied in for a single build and removed afterwards
— a page that is meant to break the build cannot also be part of the build
every other test depends on. `vitest.config.ts` sets `fileParallelism: false`,
since each spec runs a real `astro build`.

**`.mx` pages** (decision 76b, `packages/hosts/astro/src/index.ts` +
`packages/hosts/astro/src/vite-pages.ts`): the integration calls Astro's
`addPageExtension(".mx")` — `.marko` is not a registered extension for this
integration at all (see "`.mx` is the only template extension" above), so
there is no separate question of whether it is a page. A second Vite plugin (`mxPages`,
`enforce: "post"`, scoped to `<srcDir>/pages/`) runs after
`@mxlang/vite-plugin`'s own `.mx` → TS compile in the *same* transform pass
and rewrites the already-compiled module — by the time this stage runs the
bundler has already stripped TypeScript types from the code (measured: no
`: Input`/`: string` annotations survive), so the rewrite injects plain JS,
not TS. It matches `@mxlang/html`'s exact branded tail (`function
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
HTML. `vite.config.ts`'s `ssr.external: ["@mxlang/html"]` keeps that
package's own `import { escape } from "@mxlang/html"` (present in
every compiled `.mx` page) out of the rolldown bundle — left un-external,
rolldown would try to bundle `@mxlang/html`'s raw TS source itself,
pulling in `@marko/compiler`'s transitive syntax the same way the plugin's
own dynamic `import()` has to route around (see the Vite plugin section
above).
