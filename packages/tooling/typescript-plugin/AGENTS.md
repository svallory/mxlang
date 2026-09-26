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


