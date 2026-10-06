# language-server — agent instructions

## `@mxlang/language-server`: diagnostics-only LSP server (decision 71/72)

### Current dispatch (decisions 129/132)

`diagnoseDocument` selects `lookupFor(policy).target(policy.target)` (the built-in set plus a descriptor loaded from a package specifier), calls its
lazy `load(core).compileModule`, and takes strictness from
`descriptor.strict === "always" || policy.strict === true`. No host-name
compiler branches remain. The registry supplies tag discovery/policy wrappers
and file kinds; `fileKindOf` matches suffixes and region language ids only.
The `ng-template` and `astro-template` pipelines are silent by suffix, never
by language id alone. A `region` pipeline uses its `compileRegion` through
parser `print`. Both page and region calls pass `targets: lookupFor(policy)`;
the descriptors forward it rather than narrowing cross-file `AttrTag` sources
to their own package (decision 126 addendum). A descriptor without `load`
stays silent for page compilation too. The registry policy wrapper continues
staging/rejecting the data target. Hand-built policies bypass that staging,
including a raw data policy; `diagnoseDocument`'s TSDoc documents that such a
call is outside the supported language-server policy path.

Both dist and VSIX builds inline the registry and descriptors: their lazy
synchronous `require` must not escape into a source module under Node ESM.
Dist leaves core/parser external and builds index/bin independently. The
index uses explicit exported value bindings: Bun 1.3.14 can emit a re-export-only entry
containing exports with no bindings when the lazy descriptor graph is bundled.
`src/dist-build.test.ts` loads the built index under plain Node and exercises all wired page compilers
and the region pipeline. VSIX externals remain defined only in
`build/bundled-config.ts`; check with the editor's `check-vsix` and `ls-smoke`.

The historical mechanism and policy discussion below predates this dispatch
refactor; its mentions of direct host imports/branches no longer apply.

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

**No TypeScript diagnostics, so nothing here maps a generated position (decision 161).** The server publishes core's compile diagnostics, each carrying its own source position; it never type-checks a generated module, so the "diagnostic with no source mapping is never dropped" rule (spec §12) has nothing to apply to. A thrown error with no position at all is the one thing it does not publish (it goes to `onUnexpectedError`): that is an internal failure, not a diagnostic about the author's file.

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
(the Solid host on `@mxlang/core`, see `packages/hosts/solid/AGENTS.md`), but this server has no
`.solid.mx`-document diagnostics path yet — `.solid.mx` is MX regions inside
a TypeScript module, not a whole-file Marko template the way `@mxlang/html`
compiles, so wiring it needs its own diagnose path, not just a `Policy`
object. `resolveStrict` falls back to the translator's own default rather
than throwing, keeping the rest of a mixed workspace diagnosed.

**Angular and unknown hosts.** `diagnoseDocument` routes by file kind before
host policy: a `.ng.mx` (`hostModuleSegment(basename) === "ng"`, core's helper,
as `mx-tsc` does) and any `host: "angular"` document return no compile
diagnostics (never an Error, never loads `@angular/compiler-cli`; `mx-tsc`
owns those), so a `.ng.mx` never reaches the html compile even under an
unknown `mx.host` that resolved to the html default. An unknown host on an
`.mx` page compiles under the resolver's host plus the warning; the parity
test is `packages/tooling/tsc/src/unknown-host-parity.test.ts`. Real Angular
wiring is TODO `ls-angular-host-wiring`. The `.ng.mx` check is the first
branch, ahead of every host branch and case-insensitive (like the TS plugin's
`isNgMx`). An `.astro.mx` file (decision 134) is routed by kind too, before the
`.ng.mx` check, and is deliberately silent: the server does not load
`@mxlang/astro`, so Astro-template diagnostics come from `mx-tsc --astro` and
the TS plugin, and the file must never reach the `.mx` compile (it ends in
`.mx`). Test: `diagnose.test.ts`, "the Astro template file kind".

**Zed finding** (brief item 4): there is **no zero-Rust path** to register a
second `[language_servers.*]` entry in Zed's `extension.toml`. Reading
`marko-js/zed`'s own `extension.toml` and `src/lib.rs` (via `gh api
repos/marko-js/zed/contents/...`, no local checkout) confirms
`[language_servers.marko]` binds `languages = ["Marko"]` to that extension's
own `zed::Extension::language_server_command` implementation — a
`Cargo.toml`-backed Rust extension is what makes the entry work, not the TOML
table alone. At the time of this finding, `packages/editors/zed` was
grammar-only (no `Cargo.toml`) *because* it registered no language server;
adding this server's registration was therefore new scope (a Rust crate) for
that package, tracked as follow-up rather than done in this task (time
budget) — see the update note below for the scaffold that now exists.
`extension.toml` gained a comment
documenting this finding at `[grammars.marko]` (gone since extension 0.2.0,
where `[grammars.mx]` replaced it). Both VS Code
(`LanguageClient` targeting `language: "marko"`, a second registration
alongside Marko's own) and Zed (`[language_servers.<key>]`, once the Rust
scaffold exists) support the second-server pattern once wired; see the
package's own `README.md` "Editors" for the concrete snippets, including the
generic-LSP-client `settings.json` shape for VS Code (which ships no
dedicated extension from this task, per brief scope).

*(Update, task `zed-ls-registration`, decision 77: the Rust scaffold this
paragraph names as follow-up now exists — see `packages/editors/zed/AGENTS.md`. VS
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
fresh-worktree caveat as `@mxlang/parser`'s `dist/index.js` (see "Build
before downstream tests" in the root `AGENTS.md`): `bun run verify` builds before it tests,
so this only bites a standalone `vitest run` of this package.

**Dependent re-diagnosis** (phase 4 tooling, decision 106/107's LS half).
`server.ts` keeps `callerDependencies`/`dependencyCallers`, a bidirectional
edge map between a document URI and the filesystem paths its last compile's
`dependencies` named. `scheduleDependents(changedUri)` walks
`dependencyCallers` and re-schedules every *open* document depending on the
changed path — called from `onDidChangeContent`, `onDidSave`, and
`onDidChangeWatchedFiles` alike, so an unsaved edit to an open callee, a save,
and an on-disk change reported only through the watcher (another editor, a
checkout, codegen) all reach the same path. `openSources()` feeds
`withCalleeInputSources` on every diagnose, so a dependency that is itself an
*open* document is read from its live buffer rather than disk. Dynamic
watcher registration (`onInitialized`, gated on the client's
`workspace.didChangeWatchedFiles.dynamicRegistration` capability) only
affects whether the server *asks* the client to send `didChangeWatchedFiles`
in the first place — `onDidChangeWatchedFiles` itself runs on any incoming
notification regardless, which is why `server.test.ts`'s watcher test omits
that capability and sends the notification directly (no
`client/registerCapability` handler needed in the test's minimal JSON-RPC
client).
**`recordDependencies` must run even when a compile fails**, or the edge a
previous *successful* diagnosis recorded is silently dropped the next time
that same document fails to compile — measured as the exact bug behind the
"invalidates and regenerates" cycle test hanging on its final revert: the
"required" round's diagnosis (which itself reports "missing required
attribute tag", a compile error) recorded zero dependencies, wiping the edge
the earlier successful "optional" round had recorded, so the *next* callee
edit found no caller left to re-diagnose. Fixed in `@mxlang/core`
(`TranslateError.dependencies`, see `packages/core/AGENTS.md`) and forwarded
here in `diagnoseDocument`'s `catch` block before building the diagnostic.

**Scan evidence is a dependency too** (`mx.contracts` PR 2, decision 142).
`diagnoseDocument` adds every `scan.files[].path` to the caller's dependency
set before compiling: contracts modules, sidecars and scanned tag files do
not necessarily appear among the compiler's callee-input dependencies.
Recording them early retains these watcher edges even when compilation fails.
Discovery errors carry partial scan evidence and the last complete scan's
inputs through `TranslateError.dependencies`, consumed by the same catch path.
`src/contracts.test.ts` proves module-only and sidecar-only watched-file edits
re-publish the caller's diagnostics over Bun stdio, through error-to-error,
error-to-success and success-to-error cycles without editing the page, plus
valid → invalid declaration → repair and initially-invalid discovery → repair.
Dynamic registration includes `.js`, `.mjs` and `.cjs`; a real Node stdio client
asserts the registered globs and drives a `.cjs` module edit through them.
Scan-level template dependency fan-out is intentionally deferred to space TODO
`ls-scan-dependency-fanout`.
Node's ESM/TS module reload still requires restart (`sync-esm-reload-node`);
watcher scheduling does not bypass the runtime's export cache.

**Host-policy diagnostic location.** A `package.json` problem (unknown `mx.host`, malformed file, bad `mx.tags`) has *package.json's* coordinates, not the document's. `diagnose.ts`'s `scanDiagnosticToLsp` therefore returns it on the document at 1:1, message `<package.json>:<line>:<col>: <message>`, with `relatedInformation` at the real range, and pushes the same diagnostic onto `related` so `server.ts` publishes it on the `package.json` URI. `server.ts` merges entries per URI and only clears a URI when no other open document still publishes it (`publishedByOther`). `mx-tsc` does not print these warnings at all, so there is no tsc wording to match. `diagnoseDocument` compiles with the filesystem path (`documentPath(uri)`), never the URI.

**Code frame in `data`.** Babel/Marko errors arrive as `\n    at <path>:L:C\n    > 1 | <src>\n        | ^^^ <text>\n      2 | ...`. `diagnose.ts`'s `splitCodeFrame` keeps only `<text>` (the caret line's text) as the diagnostic `message` and puts the ANSI-stripped frame, dedented to its `> 1 |` marker, in `data.codeFrame` (decision: audit item 21, an agent pays per token). No frame, or a caret line with no text, leaves the message untouched with no `data`. Not `relatedInformation`: VS Code would render a repeat of the message. The unknown-host parity test compares `data.codeFrame` with `mx-tsc`'s frame and the compact text with `mx-tsc`'s caret line. Because the `at <path>` line is dropped, the file-URI tests assert absence of `file:`/`../` leaks rather than the path.

**Callee parse errors.** Core converts a callee template's Marko parse error to a `TranslateError` with `file`, `line` and `column` measured in that template. The server publishes it on the template URI even when only the caller is open, moves its frame to `data.codeFrame`, and leaves a caller pointer at 1:1 with `(in <abs>:L:C)` (printed positions 1-based) and `relatedInformation` at the real range. `splitCodeFrame` retains its `at`-header fallback for legacy wrapped errors without `file`. A callee with several Marko parser errors is one error whose message carries one frame each; the published message names only the first frame's reason, so it ends with `(+N more)` when the frame holds N further ones — on the callee diagnostic, its `relatedInformation`, and the caller pointer alike. The stdio regression in `server.test.ts` uses a real discovered child with an unclosed `<div>` on line 3 and, in its aggregate case, `<div a=(x +)/>\n<span>`.
