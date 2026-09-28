# typescript-plugin — agent instructions

## Exact-pin policy detail (typescript peer)

**A published package's `peerDependencies` is the one exception to the root exact-pin policy, and `typescript` is the case.** `@mxlang/tsc` and `@mxlang/typescript-plugin` declare `peerDependencies.typescript: ">=5.9.0 <7"`, because a peer is resolved from the *consumer's* project and an exact peer makes the package uninstallable for anyone on a different patch. The exact-pin policy still holds for every `devDependencies`/`dependencies` entry, including those packages' own exact `devDependencies.typescript` — the range is what a consumer may satisfy, the pin is what CI and local builds actually run (`typescript@6.0.3` today, bumped from `5.9.3`).

TypeScript must resolve to **one** copy: the TS plugin is handed the `ts` object by tsserver, and `mx-tsc` passes `require('typescript')` to Volar's `runTsc`, so a nested second copy breaks `instanceof` across that boundary and silently mistypes every file. `packages/tooling/tsc/src/peer-typescript.test.ts` asserts the property rather than the manifest text — every package declaring the peer resolves the same file on disk, and it is the workspace's own copy. Note the `examples/*` apps pin `typescript` themselves and are deliberately not covered.

**`@mxlang/language-server` declares no `typescript` peer**, deliberately. It has no reference to `typescript` anywhere in its source: TypeScript is only its *build tool*, running `tsc --emitDeclarationOnly` to produce `dist/*.d.ts`. It therefore keeps an exact `devDependencies.typescript` and nothing else — a peer would force every consumer to resolve a module the package never loads. The same test pins this, so the distinction cannot rot into a copy-paste peer.

**A package that emits declarations sets `rootDir` explicitly in its `tsconfig.build.json`.** TS 6 stopped inferring a common source directory when a build config and the `tsconfig.json` it extends disagree about one (`TS5011`) — which they do whenever `include` covers `test` and the build config excludes it, as `packages/hosts/angular` does. It belongs in the *build* config: putting `rootDir: "src"` in the base `tsconfig.json` instead makes the ordinary typecheck fail with `TS6059` for every file under `test/`.

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
- **`preventLeadingOffset` must stay unset for both whole-file `.mx` and
  `.solid.mx`.** With that flag set, Volar's `runTsc` parses its
  `SourceFile` from the generated text alone, so `tsc` converts a correctly
  mapped source *offset* into line and column against the *generated*
  file's line table instead of the source's — wrong whenever the two line
  tables disagree. Unset, Volar pads the virtual contents with the source's
  own lines (each line replaced by matching-length spaces, in
  `proxyCreateProgram.js`) so the offset lands on the same line/column in
  both. Whole-file `.mx` needed this from the start, because its compiled
  module drops the source's line structure entirely (measured: a two-error
  fixture reported (3,15)/(4,22) for errors on source lines 2 and 3).
  `.solid.mx` used to keep the flag set, reasoning that its printed output
  preserves the region's line *count* — true, but irrelevant: a line the
  printer reformats (e.g. an `Input` interface losing whitespace) still
  shifts every later column while the line number stays put, which is
  `preventLeadingOffset`'s exact failure mode
  (`solid-mx-tsc-column-against-printed-text`; measured: `export const
  broken` on line 4 reported column 17 against an authored column of 14).

**`.solid.mx`'s virtual TSX gets a synthetic, unmapped import for the Solid
JSX built-ins the emitter prints as a bare tag** (`Show`/`For`/`Switch`/
`Match`/`Repeat`/`Errored`/`Loading` from `solid-js`, `Dynamic` from
`@solidjs/web`) — `language.ts`'s `appendSolidBuiltinImport`, called from
`createSolidMxLanguagePlugin`. `@mxlang/solid`'s own emitter never imports
these (see `packages/hosts/solid/AGENTS.md`): the real build pipeline gets
them from `@solidjs/vite-plugin`'s compiler stage auto-importing every
built-in it sees, a stage that runs *after* `createVirtualCode` and never
inside this package, so without this the projection saw a free identifier
and reported TS2304 on every `<if>`/`<for>`/`<try>` — hiding every real
diagnostic inside that JSX (solid-virtual-code-hidden-errors). The import is
appended after every mapping is computed from the unmodified generated text
(source-map offsets, `attributeTagDiagnosticMappings`), so it cannot shift
an existing line or offset; it is skipped for a name already bound by an
`import`/`const`/`function`/`class` at the top level of the generated file,
so an author's own same-named export is never shadowed. Shadow detection
(`sourceBindings`) parses the generated text with `@mxlang/parser`'s
`parseBabel` and reads each top-level declaration's actual bound name — an
import's *local* name (so `import { Show as MyShow }` binds `MyShow`, never
`Show`), and destructured `const`/`function`/`class` names — rather than
scanning lines for the built-in's name as text: a line-based probe cannot
tell a multi-line `import {\n  Show,\n} from "solid-js"` from an unrelated
line, and cannot tell a bound identifier from a substring inside an alias
clause. **A type-only import never counts as a binding.** Both
`import type { Show } from "x"` (the whole declaration's `importKind`) and
`import { type Show, For } from "x"` (one specifier's own `importKind`) are
excluded, since neither introduces a value named `Show` the emitted `<Show>`
tag could actually resolve to — only `declare const`/`function`/`class` and
an ordinary value import do that.

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

## Attribute-tag call sites and callee dependencies (phase 4a)

A caller's attribute-tag value is emitted with `satisfies
NonNullable<Parameters<typeof Callee>[0]["tag"]>`, so TypeScript checks it
against the callee's declared `AttrTag` type. The emitted *shape* comes from
core reading the callee's `Input`; the *types* come from TypeScript resolving
the callee module.

**A test that reports through Volar cannot prove what the emitted
TypeScript checks.** Volar drops a diagnostic whose position has no mapping,
and most of an attribute-tag value is generated code. The Solid and Preact
emitters once applied `satisfies` to the wrong expression (`() => x
satisfies T`), every valid caller's virtual code carried a TS1360, and
`mx-tsc` and the plugin service both stayed clean. `emittedDiagnostics`
(`src/index.test.ts`) type-checks the emitted text itself and returns every
diagnostic; use it for anything about the generated code's types.

- **Never register a callee through `CodegenContext.getAssociatedScript`.**
  A Volar associated script is a file whose content is embedded in its
  target's virtual code, and `@volar/typescript`'s `getServiceScript`
  (`lib/node/utils.js`) answers for any script with `targetIds` using the
  *target's* service script. A callee is a program file with virtual code of
  its own, so associating it maps the callee's diagnostics through the
  caller's mappings and reports them in the caller's file. Measured on
  `examples/todomvc`: `TodoItem.solid.mx` and `Footer.solid.mx` diagnostics
  sitting in unmapped generated code (normally dropped) surfaced as seven
  errors in `App.solid.mx` at unrelated lines, and `mx-tsc` exited 2. The
  same routing is used by every proxied tsserver method, so an editor was
  affected too. Regression tests: `reports a %s callee's own type error
  against the callee` (`src/index.test.ts`) and the `callee-diagnostic-*`
  fixtures in `packages/tooling/tsc`.
- **`compileWithDependencies` reads dependency text through `readSource`**
  (`DependencyLanguagePluginOptions`, `src/language.ts`). The tsserver plugin
  passes a reader over `info.project.getScriptInfo(...)`, which returns an
  open callee's unsaved buffer; `mx-tsc` passes none and compiles once,
  because a one-shot run has only the files on disk and core reads those
  itself. With a reader, each pass uses the accumulated sources every
  previous pass has read, and a changed dependency set triggers another pass
  unless the host holds nothing new for it — iterating to a fixed point
  rather than stopping after one retry, capped at `MAX_COMPILE_PASSES` (8) so
  a dependency cycle or a pathological chain still terminates (fix for
  `compile-with-dependencies-nesting-limit`, filed from PR #149). **A real
  chain reaches this**: a callee's `AttrTag<Alias>` — the whole type
  argument, not a nested field reference like `AttrTag<{ attrs: Alias }>` —
  can itself alias a type `import type`-ed from a further file, which
  `readCalleeInput`'s own `resolveNamedType`
  (`packages/core/src/callee-input.ts`) follows across files up to
  `MAX_ALIAS_DEPTH` (4), independently of this loop's own pass count. Before
  the fix, a chain three hops deep (caller → callee → alias file → a further
  aliased file) could have its deepest hop discovered only by the single
  retry's own compile, with no further pass to read it fresh — pinned by
  `compileWithDependencies against a real readCalleeInput compile` in
  `src/index.test.ts`, driven through the real `readCalleeInput`, not a
  synthetic callback. **The nested-field-reference shape
  (`AttrTag<{ attrs: Alias }>`) is not subject to this at all**: measured by
  instrumenting `compileWithDependencies` directly, a type referenced only
  that way never enters `ctx.dependencies` in the first place — it is
  resolved entirely through the emitted `satisfies
  NonNullable<Parameters<typeof Callee>[0]["tag"]>` reference, which
  TypeScript's own live module graph re-checks on every edit regardless of
  this function (decision 107, option A, next bullet).
  **Reaching the cap without settling is not silent (compile-deps-cap-warning,
  fix-forward for PR #150).** When the loop falls through all
  `MAX_COMPILE_PASSES` passes still finding a new dependency set or new
  source text each time, `compileWithDependencies` pushes an `MxWarning` onto
  `result.warnings` (when the generic result type carries one) naming every
  dependency discovered across the unsettled chain, positioned at the file's
  own start (line 1, column 1) — there is no single call site that owns an
  unsettled chain spanning the whole compile. Every caller
  (`mx-language.ts`, `amx-language.ts`, and this file's own
  `createSolidMxLanguagePlugin`) already destructures `warnings`
  unconditionally from the result and maps it through `warningDiagnostic`
  into `compileDiagnostics`, so the warning reaches `getCompileDiagnostics`
  with no caller-side change.
  **The cap's own final (8th) compile must be checked for settling too,
  not just passes 1–7 (round-2 fix, same TODO).** The loop's fixed-point
  check (`sameDependencies`/`sameSources`) runs at the *top* of each
  iteration, against the *previous* pass's result — so it validates compiles
  #1 through #7 but never the compile produced *inside* the 7th iteration
  (the one that runs right before the loop condition fails at `pass ===
  MAX_COMPILE_PASSES`). A chain that discovers a new dependency every pass
  through pass 7 and then genuinely settles on pass 8 used to still get a
  false-positive warning, because nothing re-ran the settle check against
  that last result before falling through to the push. Fixed by repeating
  the same `sameDependencies`/`sameSources` check once more after the loop,
  against the final `result` — pinned by `produces no warning when the chain
  genuinely settles on its 8th (final) compile` in `src/index.test.ts`.
  **Measured: a real attribute-tag alias chain cannot organically drive this
  loop to the cap.** `readCalleeInput`'s own `resolveNamedType` bounds
  alias-following to `MAX_ALIAS_DEPTH` (4) within a single compile,
  independent of this loop's pass count — a chain of 5+ aliased hops fails
  `attrTagConfig`'s "declare this attribute tag's config literally" check on
  the very first pass that needs the 5th hop, before `compileWithDependencies`
  ever gets a chance to retry. The cap therefore exists for a dependency set
  that keeps changing for reasons other than alias depth (a pathological
  chain elsewhere, or a future dependency producer); the unit tests in
  `src/index.test.ts`'s `compileWithDependencies` describe block cover the
  cap with a synthetic `compile` callback for this reason, not a real
  `readCalleeInput`-driven chain. **The real-caller plumbing is still proven
  end to end**, in `src/compile-deps-cap-warning.test.ts` (a dedicated file
  so its `vi.mock("@mxlang/preact", …)` cannot leak into any other suite):
  it mocks only `compilePreactMx` — the one host compile function
  `mx-language.ts` calls for the "preact" host policy — to report one more
  dependency every pass, and drives everything else for real
  (`createMxLanguagePlugin`, the genuine `compileWithDependencies` loop, and
  `getCompileDiagnostics`), asserting the cap warning lands as a single
  diagnostic with the chain text at the caller's own file.
- **What follows a callee change in tsserver (decision 107, option A).** A
  change to the callee's *types* re-checks the caller at once, through
  TypeScript's own module graph (tests: `a callee's Input changing under an
  unchanged caller`). What the caller *compiled to* (the emitted shape and
  its stored compile warnings) is replaced only when the caller itself is
  compiled again; Volar gives a language plugin no way to invalidate another
  file's virtual code. The language server re-diagnoses every open dependent
  and covers that case. Documented for authors in
  `apps/docs/docs/language/attr-tag.md`.
- **The mapping pass does not report warnings.** `createHtmlMappings` lowers
  the source a second time; handing it the compile's own `warnings` array
  reported every warning twice.
- **Fixed: `solid-attr-tag-attr-offset`.** On the Solid host, a wrong
  attribute type inside `<@tab title=1/>` used to be reported on the tag
  name (`tab`), not on `title`; a missing attribute is still reported on
  the tag name by design (there is no attribute text to point at).
  `decodeMappings`'s text-equality walk can map an attribute's *value*
  exactly (it is copied verbatim into the generated object literal, e.g.
  `title=1`'s `1`), but never its *key*: the printer re-quotes it (`title`
  becomes `"title"`), so no generated/source text ever matches. TypeScript
  can position a property type-mismatch diagnostic anywhere from the quoted
  key through the value, and a *range* diagnostic only resolves through
  Volar's `toSourceRange` when the same mapping covers both ends
  (`findMatchingStartEnd` translates the range's end through whichever
  mapping matched its start) — so `attributeTagDiagnosticMappings` now adds
  one supplemental mapping per attribute, spanning its whole `"key": value`
  generated text back to its authored `key=value` source span, with the
  surrounding whole-object fallback mapping punched to exclude that range.
  The punch is required, not cosmetic: `@volar/source-map`'s lookup yields
  every mapping containing a generated offset in *array* order, so an
  overlapping wider span, if it sorted first, always won over a narrower
  one sorted after it by `createVirtualCode`'s ascending
  `generatedOffsets[0]` sort — two mappings must never share a generated
  offset, or the wider one silently wins regardless of which is "more
  specific". html and preact apply `MappedCode` offsets directly and were
  never affected.
- **Fixed: `custom-tags-template-error-positions`.** A `TranslateError`
  raised while compiling a tag template (`tags/x.mx`) was always reported
  against the *caller's* file and text at the call's own offset — the three
  `toSyntaxError` functions (`mx-language.ts`, `amx-language.ts`,
  `language.ts`) read only `error.line`/`error.column` and ignored
  `error.file`, the field `template-tag.ts` stamps with the template's path
  when a unit's metadata compile fails (spec §2's third position rule; see
  `packages/core/AGENTS.md`). `foreignTemplateError` (`language.ts`) now
  detects a `TranslateError` whose `file` names another file, reads that
  file's current text (the supplied `readSource`, else disk — the same
  fallback order `readCalleeInput` uses), and returns two diagnostics: the
  real one, keyed under the template's own filename in the plugin's
  `compileDiagnostics` map, and a pointer diagnostic on the caller naming the
  template — matching `diagnoseDocument`'s `related`/pointer split exactly.
  All three `createVirtualCode` catch blocks call it before falling back to
  their own `toSyntaxError`. `mx-tsc` needed no separate wiring: it already
  aggregates every language plugin's `getCompileDiagnostics()` with no
  filename filter, so a diagnostic keyed under the template's path is
  reported under that path automatically. The same shape (a `TranslateError`
  carrying `.file`) is separately handled in `@mxlang/vite-plugin`'s
  `transform` catch and `@mxlang/astro`'s `AstroTemplateError`/
  `vite-templates.ts` (that package's own `AGENTS.md`), for the dev-server
  and build path rather than the editor.
  **Known limitation: tsserver's pull model, not this package's diagnostic
  routing.** `templateDiagnostic` is only ever *returned* from
  `getCompileDiagnostics(templateFileName)` — it is up to tsserver to call
  that with the template's own filename, which in practice only happens for
  a file the editor has open (or explicitly queries), because
  `getSyntacticDiagnostics` (`index.ts`'s `withSyntaxDiagnostics`) is a pull,
  not a push. The language server does not have this gap: it *pushes*
  diagnostics for the template's own URI unconditionally over LSP
  (`connection.sendDiagnostics`, `packages/tooling/language-server/src/server.ts`),
  regardless of whether that document is open. So in an editor using only
  this plugin (no language server alongside it), a broken template that is
  not itself open in a tab shows nothing directly on the template — only the
  caller's pointer diagnostic, which is why that diagnostic's message names
  both the template's file *and* its exact `line:column` (`foreignTemplateError`
  in `language.ts`) rather than just the filename: it has to be enough to find
  the error without ever opening the template. There is no tsserver-side fix
  for the underlying gap; running `@mxlang/language-server` alongside this
  plugin (both are supported together, see that package's `AGENTS.md`)
  closes it.
