# @mxlang/core

## 0.1.0-alpha.16 — 2026-10-10

- **Changed (core-cold-start):** `@mxlang/core` loads its heavy dependencies lazily: importing the package no longer loads `@babel/parser` (it now loads on the first parse), `@babel/plugin-transform-typescript` (on the first strip, which every lowering with an expression payload runs) or `cosmiconfig` (on the first MX config read; `MX_CONFIG_SEARCH_PLACES` now spells out cosmiconfig 10.0.1's defaults, pinned by a test). Importing `@mxlang/core` in a fresh process is ~10 ms faster on Node and Bun. A dialect's first `lowerSource` no longer loads `dist/marko-frontend.cjs`: validating a dialect's syntax table uses the template parser the dist already inlines (`@mxlang/parser` under its `./lexer` export, so core's type program still sees only the curated `public.d.ts`), which cut ~50 ms (forge, Bun) off a dialect's first call — the bulk of the regression Mesh reported. `@mxlang/typescript-plugin` and `@mxlang/language-server` declare `cosmiconfig` and list it (with `@babel/parser`) in `BUNDLED_INSTALLED`, so the VSIX bundles ship the requires the bundler cannot follow.

- **Changed (dialect-1b):** Dialect routing and MX's config now guard what belongs to MX, to other languages and to the dialect. - A dialect cannot claim, and `mx.extensions` cannot route, `.mx` in any spelling (`.MX`, `.page.Mx`), a host's file kind (`.solid.mx`, `.ng.mx`: the segments the caller's targets declare, which `compileSource` passes in, and `parseFragment` when given its new `targets` option, which every host's region entry passes), or an extension whose last segment is TypeScript's, JavaScript's or Marko's (`.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.marko`). Each is an error at `mx.dialect.extensions` or at the `mx.extensions` entry. `.mesh.mx` stays claimable. - MX's config setting `tagRules`, or `tagRules` or `name` under a dialect's id, is an error at its key: those belong to the dialect. A top-level key that is none of MX's keys, no target's or host's settings block and no discovered dialect's id is an `unknown-config-key` error at its key; a `$` key (`$schema`) is JSON metadata and is not checked. - `compileSource` and `parseFragment` parse a dialect's files under the tag rules the dialect states, as `lowerSource` already did; MX's own files keep their target's rules. - An installed dialect whose `mx.dialect.module` is TypeScript is an error saying the module must be JavaScript Node can load, and a `module` written as a package specifier is an error saying it is a file path inside the package. - The reference `syntax/mesh` module states `tagRules: "none"`.

- **Changed (dialect-one-process):** A syntax-table row in attribute or line position now goes through one claim process. At a match, the parser asks the row's node type to claim the text: the type's `parse(text, span, ctx)` returns the node's fields, or `undefined` to decline. A claimed node stays in the MX AST at its position, typed by its registry key (`ref:Ref`), and lowering calls the `lower` of that type. A declined text parses as if no row had matched: an attribute name, or a tag on its line. - `NodeType.parse` takes a `ClaimContext` (`position`, `tag`, `attribute`, `fail`) in place of `NodeKit`, and may return `undefined`. `NodeKit` is no longer exported; `ClaimContext` and `ClaimPosition` are. - `{ call }` rows and the `"attribute"` spelling are core's `mx:Trigger` node type. A row may also name `mx:Trigger` (the same as `{ call }`) or `mx:Expression` (declines every text in these positions). - The one error the claim owns is a row naming a type that is not registered: ``the `ref` trigger names `ref:Path`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)``. A row naming another dialect's types gets a note that this is not supported yet. This replaces the earlier per-case texts ("which the dialect does not register", "core's own node types are not trigger targets", "no dialect registers node types here"). - A claimed node's `=value` and arguments are stripped of TypeScript like a `{ call }` row's, and a dialect type's registry `keys` end with `value` and `args`. - Line and attribute hooks (a node type's `lower`, a `{ call }` row's `lowerTrigger`) run once each, in source order; a body's line trigger is lowered when the walk reaches it, no longer after the rest of the body it sits in. The first failing trigger in the source is the file's error. - A node type's `parse` errors are raised while the file parses, at the trigger, and stop the parse: such an error is the file's error even when an earlier line holds a parse error. Their texts now say `ctx.fail`; a non-object result says "…, or `undefined` to decline the text"; a result holding core's fields names only the fields it holds. - `@mxlang/parser`: `createParser` and the front end's `parse` take a `claim` option (`TriggerClaim`). With the default table it is never called. - `@mxlang/babel`: the MX AST gains `MxRegisteredNode`, a dialect's node in an attribute list or body.

- **Changed (dialect-value-position):** The attribute value is a third claim position. A dialect's `valueTriggers` rows are armed on the first character of an attribute's `=value` and of a tag's default value; a row whose `match` covers the whole value asks its node type to claim it, exactly as attribute and line rows do. A claimed node is the attribute's value in the MX AST; `undefined` declines, and the value parses as if no row matched. A `:=` value, a spread, a trigger's own `=value` and a statement's words are never claimed. With no value row nothing changes. - `mx:String` (`MxString`: `value`, `raw`, `span`, `start`, `end`) is a core node type a value row can name. It claims a quoted value as its contents with the one-character escapes resolved (and declines `\x`, `\u`, octal escapes and template literals), and any other text as itself. Only a claimed value becomes an `MxString`; an unclaimed value keeps its `MxExpression`. - A value node lowers through its type: `mx:String` to its `value`, any other type through its `lower(node, ctx)` with `ctx.position` `"value"`, which returns a string (a static attribute) or `ctx.expression(node)` (the attribute the expression makes: dynamic, or static and atom-marked for a marked string literal, as the atom trigger's). Any other result is ``the `<id>` trigger's `lower` (node type `<key>`) must return a string or `ctx.expression(node)` for an attribute value``. For a string, the IR `Attr.node` carries the claimed node beside the string `value`. - `MxAttribute.value` may hold the claimed node (`MxValueNode`). `MxAttribute.dialectNode` is removed, and so is the attribute value `{ kind: "node", node, value }` a node type's `lower` could build: a node on an attribute is now a value row's node. The `ctx.attribute` value error now reads ``the `<id>` trigger's `<hook>`: an attribute value is `true`, a string, a `ctx.expression` result, the trigger's own method value, or `{ kind: "atom" | "member", name }` ``. - The "not registered" error knows positions: a row naming a type registered only for other positions says ``…, which is not a registered node type in value position (a row there can name `mx:String`, `mx:Expression`, `ref:Ref`)``, and the list of types a row can name is filtered by the row's position. `valueTriggers` rows may not be armed on `=` and may not be `{ call }` rows. - A tag's default value that a value row claims ends at a space followed by a `terminatesValue` attribute row: `belongs-to=:List :list` reads as the default `:List` and the attribute `:list`, where with no value row it is the error ``Expected a single expression, but found `:` after it.`` - The reference `syntax/mesh` module gains the value row `atom-value` (`:name` as a whole attribute value, `mesh:Atom`, lowered to the atom-marked string literal the `atom` row builds). Under it, Mesh's `belongs-to=:List :list` (old-relationship) is again ``` `<belongs-to>`: unknown attribute `value` ``` at 5:14, where alpha.15 gave ``Expected a single expression, but found `:` after it.`` at 5:21; the rest of Mesh's corpus lowers as before. Mesh vendors its syntax, so it must copy the value row and the `Atom` node type into its own `MESH_SYNTAX`. - `ContractAttr` (the `LoweredUnit` view the contract hooks read) is the attribute's `name`, `nameSpan`, `label` and `value`, where `value` is a node: `mx:String` (`value`, `span`), `mx:Expression` (`node`, `code`, `span`, `bound`), a value row's claimed node that its type lowered to a string, or `null` for a boolean attribute. A claimed node its type lowered to `ctx.expression` is the value that expression makes, as if written there: `mx:Expression`, or `mx:String` for a string literal (`mx:Atom` when it is atom-marked). A spread is `{ spread: true, span }`. The `kind`-tagged forms (`static`, `expression`, `boolean`, `atom`, `member`, `spread`) are gone. Removal work, not part of the view: the atom and member sugars' leftover marks show as `mx:Atom`/`mx:Member` values until the atoms-and-members dialect carries them as its own value nodes; do not build on them. - `ClaimContext.position` adds `"value"`, and `ClaimContext.attribute` names the attribute a value belongs to (`null` for a default value). `lowerTrigger`'s `ctx.position` type is `CallPosition` (never `"value"`); `TriggerPosition`, `CallPosition`, `ContractValue`, `ContractString`, `ContractExpression`, `ContractAtomOrMember` and `parseMxString` are exported. - `@mxlang/parser`: syntax tables take `valueTriggers`; the `claim` option is also asked in `"value"` position with the attribute's name, and `onAttrValue` carries the claiming row's `trigger` and `claim`. - `@mxlang/babel`: the MX AST gains `MxValueNode` and `MxString`; `MxAttribute.value` includes `MxValueNode`.

## 0.1.0-alpha.15 — 2026-10-10

- **Changed (after-value-text):** The "sugar right after a default value" error no longer cites internal notes: it drops the "(decision 151, ruling 2)" parenthetical and the pointer to divergences.md, keeping only the plain reason and the fix ("put it before the value or on the tag"). The text is the same from `compile`, a fragment parse and `lowerSource`.

- **Fixed (ambient-types-followups):** A host's `ambientTypes` is now asked through each root file's own lookup (the nearest `package.json` above the file, as every other host operation resolves it), then the tsconfig directory's, and its package files resolve first from the directory of the first root file whose policy selects it (so the root order never picks which install answers), so a package below a monorepo's root tsconfig, or one whose host is installed only beside its files, gets its ambient types. A host whose `ambientTypes` returns no iterable of files (a number, `undefined`, an object without an iterator, a string), an entry that is not a file path (`[undefined]` from `resolve` of a missing file, `[42]`), or a generator that throws while read, is one `TS80004` error naming the package instead of a crash, in `mx-tsc` and the editor. `mx-tsc -w` reports a throwing host on every build while it throws, counted in that build's summary (the first build's summary no longer says "Found 0 errors" above it), and resets the exit code once a rebuild is clean.

- **Changed (beta-readme-note):** Every published package's README now carries the same beta note right after its title/intro: the package is at 0.x and its API may change in any release until 1.0.0 (npm publishes plain `0.1.0` on the `latest` dist-tag for the beta).

- **Changed (core-errors-neutral):** Core's construct diagnostics no longer name the underlying template language or its origin project: a dialect built on the machinery may hide what it is built on, and a dialect author sees these errors. The reworded messages, each stating the rule itself with meaning, position, severity and error codes unchanged: the invalid tag name and invalid attribute name errors drop their "Marko rejects it too" clause; the `[(name)]` attribute hint now says "two-way binding is written `name:=expr`"; the `<const>`/`<id>` `value=` error and the two `<for>` `key=`/string-`by=` errors drop their links to the origin project's docs site; `<x>` declared by a taglib with no template no longer says "Marko taglib"; `import typeof` is refused with "imports here are TypeScript"; the `class { … }` refusal says "a component class" has no equivalent on any target; the `(not yours: an MX bug)` internal-error suffix became `(not yours: an internal bug)` on the lowering boundary, `payloadOf`, the trigger-row lookup and the no-lowering error; the bare-`:` fix-it now reads "for an attribute named `value:`, write `value:`" (in core and in the ported parser front end's copy, so the parse differential stays byte-identical between the two paths); a syntax table needing more than the `.mx` default row now asks for "a template parser with the syntax-table API"; and a target descriptor outside version 0 is refused with "this compiler supports descriptor version 0".

- **Added (data-attr-args):** - core: the IR `Attr` (every kind but `spread`) carries `args?: Expr[]` for an attribute written with arguments, so a target can read them; no existing host emits them. `x a(b)` is a boolean `a` with `args: [b]`, `x a(b, c)` has two, `x a(&b)` carries the member the syntax module built, and `x a()` carries `args: []`. The field is present only when the parentheses were written. The method shorthand (`isOverdue() { … }`) is unchanged: it stays a function-expression `value` and never routes through `args`.

- **Changed (dialect-manifest-mx-key):** A target's config key (`configKey`, else its name) cannot be `dialect`: `mx.dialect` is a dialect package's identity block, never a target's config block. `createTargetLookup` refuses such a descriptor with the new `reserved-config-key` rule, and a loaded `mx.target` / `mx.host` descriptor that takes it is a positioned error at that key.

- **Added (dialect-registration-added):** **Dialect discovery (decision 212, `@unstable`).** New exports from `@mxlang/core`: - `DIALECT_MANIFEST_KEY` (`"mx.dialect"`) and the `DialectManifest` type. - `discoverDialects(projectFile)`: the dialects a project's direct dependencies declare, read statically from their `package.json` files without loading any dialect's code. Tools use it to learn a dialect's extensions. - `routeDialect(filename)`: the dialect that claims a file's extension, or `undefined`. - `MX_DIALECT`: MX's own dialect identity, `{ id: "mx", name: "MX" }`. - `DialectModule`: the type of a dialect module's default export. It is a `Dialect` whose `id` and `name` may be left to the manifest. **The node-type registry (decision 202 item 3, `@unstable`).** One key space, `id:Type`, covers every node the MX AST holds. Core is dialect zero (`mx`), and its MX AST types are registered with their child keys. Core still lowers its own types directly. - `Dialect.id` and `Dialect.name` are required. The `id` is the registry namespace. - `Dialect.nodeTypes`: `{ Type: { keys, parse(text, span, kit), print(node), lower(node, ctx) } }`. - A syntax table row names one with `node: { type, dialect }`, in an attribute or line list only. The row's `match` ends the node. - Core calls `parse` once per trigger, sets `type` and `span` on the fields it returns, freezes the node, and hands it to `lower`. `lower` gets the same `ctx` constructors as `lowerTrigger`. - A whole attribute value keeps the node: `ctx.attribute(name, { kind: "node", node, value })` becomes a static `Attr` with a new `node?: DialectNode` field beside its `value`. `IR_VERSION` goes from `1` to `2` for it. - `kit.fail(message, { at?, code? })` raises a positioned error. - A malformed node type, or a row naming an unregistered type, another dialect's type or core's `mx:` types, is an error in the dialect's module at 1:0. A node-type row in an expression list is refused by the parser. - New exports from `@mxlang/core`: `CORE_DIALECT`, `nodeTypeRegistry`, and the types `Dialect`, `DialectNode`, `DialectNodes` (augmentable), `NodeKit`, `NodeType` and `RegisteredNodeType`. - `Dialect.tagRules?: "html" | "markup" | "none"`: the core tag-rule preset a dialect's files parse with (decision 204, ruling 211; decision 212 item 8). A dialect that states none gets `html`. The field is validated today; the preset wiring lands with core's tag-preset tables. - `@mxlang/parser`'s table validation accepts `node: { type, dialect }`.

- **Changed (dialect-registration-hint):** The hint for JSX-style braces around an attribute value no longer names MX, because a dialect's files see it too (decision 212 item 10): `Attribute values in MX are plain TypeScript expressions, not JSX; remove the wrapping { }.` becomes `Attribute values are plain TypeScript expressions, not JSX; remove the wrapping { }.`

- **Removed (dialect-registration-removed):** **BREAKING (decisions 202 and 212; decision 195, no aliases):** - The `SyntaxModule` type is removed; use `Dialect`. - `normalizeMxSyntax` is removed. - `package.json#mx.syntax` is removed in both forms, an inline table and a module string. No setting selects a file's syntax any more: a dialect package claims extensions instead. Either form is now a positioned error at its key: ``` `mx.syntax` is removed: a syntax of your own is a dialect, a package that declares itself in its `package.json#mx.dialect` (`id`, `name`, the `extensions` it claims, its `module`) and is one of the project's dependencies; a file goes to the dialect that claims its extension. `.mx` files are always MX's. ```

- **Changed (dialect-registration):** **BREAKING (decisions 202 and 212): a syntax module is now a dialect, and a file reaches its dialect by its extension.** - **A dialect is a package.** It declares itself in its own `package.json`, under `mx.dialect`: `{ "id", "name", "extensions", "module" }`. `mx.dialect` is an identity block, never project configuration: the project's own `mx` settings are read as if it were not there. - `id` is lower-case words joined by `-`, never `mx`. It keys the dialect's node types and the project's `mx.extensions`. - `name` is the name tooling shows the dialect's users. - `extensions` lists the file extensions the dialect claims, each with its leading dot. `.mx` is always MX's. - `module` is a path, relative to that `package.json`, to the module whose default export is the dialect. It must stay inside the package: an absolute path, or one that climbs out with `..`, is an error. - A malformed manifest is a positioned error at the field, in the dialect's `package.json`. - **Discovery reads only the project's direct dependencies.** The project is a file's nearest `package.json`. Core reads its `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, finds each package where Node would, and keeps the ones that declare `mx.dialect`. It never scans `node_modules`. A dialect package routes its own files too. A dialect's module loads only when a file it claims is compiled. Discovery follows the dependencies on disk: an install, an upgrade or an edited dependency `mx.dialect` is seen at the next compile. - Two dialects with one `id` is an error at the second one's dependency entry, naming both: `` two dialects have the id `mesh`: mesh-a and mesh-b. A dialect's id is its identity; keep one of these dependencies ``. - A package listed under an alias (`"b": "npm:@real/b@1"`) is positioned at its key and named `` @real/b, as `b` ``. - **Routing.** A file goes to the dialect that claims the longest extension its name ends with. Every other file parses with MX's default row, as before. - Two dialects claiming one extension is an error at the second one's dependency entry, naming both: `` two dialects claim `.x`: `a` (a-dialect) and `b` (b-dialect). Choose one in `package.json#mx.extensions`: `"extensions": { ".x": "a" }` ``. - `package.json#mx.extensions` (`{ ".x": "<dialect id>" }`) settles a clash, or routes an extension to a dialect the project uses. A value that is not an object is an error at `mx.extensions`; a malformed entry is an error at its own key. - **The dialect's identity comes from its manifest.** Core stamps the manifest's `id` and `name` on the loaded dialect. A module that states either must match the manifest. A module that does not resolve is an error at `mx.dialect.module`. A problem with the module's own shape or table is an error in the module file at 1:0, as before. A module that fails to load keeps reporting its own error until the file changes, on every supported Node (before 22.20, Node cannot `require` an ES module again once its evaluation threw). An edited dialect module is reloaded on Bun, and on Node for a CommonJS module; Node keeps an ES module it has loaded, so an edited `.mjs` or `.ts` dialect is picked up after a restart, as for `mx.contracts` modules. - **`Dialect.productName` is removed.** Diagnostics on a dialect's files use the dialect's `name` where core's wording says "MX". The `productName` compile option still wins. A file no dialect claims says `MX`. - **`Dialect.tagRules` defaults to `html`.** A dialect that states no preset gets `html`, not `none`. `lowerSource` reads it: a call with no `tagRules` option parses under the `dialect` option's preset, else the routed dialect's. - **The explicit option is renamed from `syntax` to `dialect`.** This applies to `compileSource` (`HostOptions.dialect`), `parseFragment` and `lowerSource` (`LowerSourceOptions.dialect`). It takes a `Dialect` or a bare `SyntaxTable`. A `Dialect` passed this way must carry `id` and `name`. Its messages change: - `` the `syntax` option must be a syntax table object, not null; omit it to use the file's `package.json#mx.syntax` `` becomes `` the `dialect` option must be a dialect or a syntax table object, not null; omit it to use the dialect that claims the file's extension ``. - `` the `syntax` option is not a valid syntax table: `syntax.<field>` … `` becomes `` the `dialect` option is not a valid syntax table: `dialect.<field>` … ``. - `` the `syntax` option is not a valid syntax module: `` becomes `` the `dialect` option is not a valid dialect: ``. - Wording follows the rename. `` the syntax module's `afterLower` `` and `` `checkContract` `` become `` the dialect's … ``. `` … and the module exports no `lowerTrigger` `` becomes `` … and the dialect exports no `lowerTrigger` ``, in the dialect's module at 1:0. - The reference modules `@mxlang/core/syntax/{member,atoms-sugars,mesh}` are dialects. Their ids are `member`, `atoms-sugars` and `mesh`. Their names are `Mesh`, `MX` and `Mesh`.

- **Added (move-sugars-a):** Atoms and the name sugars as a layer-2 syntax module (`lang-ext-move-sugars-to-mesh`, slice a1; decisions 183 and 196). Ships in the next alpha. Nothing is removed: a `.mx` file with no `mx.syntax` parses and lowers exactly as before. - `@mxlang/core/syntax/atoms-sugars`: a reference syntax module carrying atoms (`:name` values, decision 156), the `:name` attribute sugar and spaced `#id` / `.class` (decision 146) as triggers, on the public hook API only. `@mxlang/core/syntax/mesh` combines it with `@mxlang/core/syntax/member`: the module Mesh copies as its own. While core still has its built-in handling, a loaded row on a character (`:` in an expression; `:`, `#` or `.` in an attribute list) replaces it for that character. What the module path reads differently is checked in as `scripts/sugar-module/deltas.json` and run by `bun run test:sugar-module` (in `verify`): `#x=1`, `.x=1` and `#x(p) { b }` are refused (decision 183); `kind=:X :x` no longer splits (decision 182 addendum 1); a `${…}` inside a spaced sugar is the generic trigger error. - Syntax table: `Trigger.value?: "refuse"` (attribute triggers): `=`, `:=` or `(` after the trigger is the parser error ``The `#main` shorthand takes no value.`` at the operator. An attribute trigger followed by `(params) { body }` takes it as its value. A trigger on `:` no longer arms right after a `?` that TypeScript reads as its optional marker (`a?:T`), and a trigger whose match would be continued by a word character now declines silently instead of erroring (`:aé`), as atoms always did. - Hook contract (all additive, `@unstable`): `ctx.value` may be an opaque method value (`TriggerMethod`); an attribute-list hook may return a non-empty list of attributes and shorthands; `ctx.attribute(null, value)` sets the tag's default value; `ctx.attribute`'s options `authored` (named by the trigger's token, as a sugar is), `once` (a second attribute of that name is the module's error) and `at` (the part of the token that spells it); `ctx.shorthand("id" | "class", name)` (Marko's tag-adjacent shorthand rules); `ctx.use` and `ctx.operator` (how an expression trigger's operand is used: member object, callee, unary, spread, property name); `ctx.fail(message, { at?, code? })`, a positioned error in the module's words carrying it on the `TranslateError` as the new optional `diagnosticCode` (not `code`, which Babel's convention already sets to `BABEL_TRANSFORM_ERROR` on translator errors). A replacement marked `extra.mxAtom` is spliced and mapped as an atom. New exported types: `TriggerMethod`, `TriggerShorthand`, `TriggerAttributeOptions`, `TriggerFailOptions`, `TriggerUse`. `Atom` and `MxAtomMark` are now documented `@unstable` as values a syntax module builds. - `ctx.valueForm` (`"="`, `":="`, `"method"`, `"arguments"` or `null`): how an attribute or line trigger's own value is written. A bound value or `(args)` with no body cannot be placed: core refuses them after the hook (``takes no bound value``, ``takes no arguments``), which may refuse first in its own words. `once` treats the default value as one name however it is written (`<x=1>`, `value=1`, `value:=y`), and its message may name `{written}` (the later attribute as written) and `{first}` (the earlier one's line:column). `ctx.fail`'s and `ctx.attribute`'s `at` must lie inside the document, else the hook-contract error at the trigger. A dropped method value is named "method value", not "`=value`". - `MxTrigger.value` (`@mxlang/babel` MX AST) is `MxExpression | MxMethod | null`; `MxTrigger.operator` and `MxTrigger.args` carry a `:=` value and `(args)` with no body. - Fixed: a trigger inside a dynamic tag name (`<${&a}/>`) is lowered; it was refused as having no lowering. - Mesh-visible: with the member module, `&a(x)` with no body is now refused in lowering (``takes no arguments``), and `&a(p) { b }` reports that the hook did not use the method value; both were parser errors on alpha.13.

- **Added (move-sugars-a2):** Atom contract checks movable into a syntax module (`lang-ext-move-sugars-to-mesh`, slice a2; decisions 183 and 196). Ships in the next alpha. Nothing is removed: a file with no syntax module, or with a module that claims no contract keys, is checked exactly as before. - `SyntaxModule.contractFields?: { attribute?: string[]; tag?: string[] }` (new, `@unstable`): the contract keys a module owns. Core accepts a listed key at registration as opaque data, in `customTags`, `mx.contracts` and tag sidecars alike, and never checks it. A key core does not know is still a registration error unless the file's module lists it. Of core's own keys only an attribute's `values`, `pattern` and `ref` and a tag's `declares` can be listed; listing one turns off core's registration check and its file-level check of that key. Core keeps the whole-value shape check (`type: "atom"` / `"member"`, decision 156 addendum 6) and `ctx.declare` in `analyze`. The claim follows the file's syntax: the `syntax` option, or the nearest `package.json#mx.syntax`. A discovery scan (`tags/`, `mx.tags`, `mx.contracts`) reads only the manifest, so `mx.contracts` may carry a claimed `declares`; an explicit `syntax` option is invisible to it, and a scanned contract using a key only that option's module claims is refused at the scan, positioned in the sidecar or the contracts module. - `SyntaxModule.checkContract?(tag, contract, ctx)` (new, `@unstable`): the module's registration check, called for every contract that uses a key the module claims, at any depth (attribute tags, inline `children["*"]` contracts), whether the file calls the tag or not, from the `customTags` option, `mx.contracts` modules and sidecars alike. `ctx.fail(message, { code? })` raises a registration error where core's own lands: the sidecar's file, an `mx.contracts` module at 1:0, no position for the `customTags` option; `code` is kept as `diagnosticCode`. New exported type: `ContractCheckContext`. - `SyntaxModule.describeAttribute?(declaration)` (new, `@unstable`): words what an attribute declaration that uses a claimed key accepts, for core's whole-value shape error (`" (one of :a, :b)"`). Core never reads a claimed key to word that error; without the hook it names only what it knows. Core's shape check stays core's for claimed keys too: a plain string against a claimed `ref` is left to the module's `afterLower`, with core's own shape error queued behind it. Claims are per key and independent (claiming `declares` without `ref`, or any other subset, does not break valid input). Contract data handed to a module is a deep-frozen copy of the registered contract, and always carries `declares`. When the file's `mx.syntax` module fails to load, a discovery scan reports that error instead of refusing a contract key the module might have claimed. - `SyntaxModule.afterLower`'s parameter is now `unit: LoweredUnit` (`@unstable`), a frozen read-only view of the lowered unit, instead of core's internal context. It has `file`, `source`, `calls` and `declared`, plus `fail(message, { at?, code?, also? })` and `warn(message, at?)`: - `calls` lists every custom tag call with a declaration. Each `ContractCall` has its `contract` (deep-frozen copies of `attributes`, `attributeTags`, `children`, `declares`, plus the claimed tag keys), its `attrs` as written, and its `attributeTags` at any depth with the declaration each matched. It also has its `ancestors`, outermost first, each with an opaque `scope` per tag instance. - `ContractAttr`'s kinds are `string`, `atom`, `member`, `boolean`, `expression` and `spread`. - `declared` lists what `analyze` hooks declared with `ctx.declare`. - `fail` throws the positioned `TranslateError` lowering reports. `code` becomes `diagnosticCode`, `also` becomes `spans`, and without `at` the error is file-level. - New exported types: `LoweredUnit`, `LoweredUnitFailOptions`, `ContractCall`, `ContractAttr`, `ContractAttributeTag`, `ContractAncestor`, `ContractData`, `DeclaredName`, `ContractFields`. - `@mxlang/core/syntax/atoms-sugars` (and so `@mxlang/core/syntax/mesh`) claims the four atom keys, checks their shape in its `checkContract` (the registration errors core gives, same text and position) and their use from its `afterLower`, through the public API only: `declares` and its scopes (the file scope last), `values`, `pattern`, `ref`, did-you-mean, the candidate lists, the string-for-`ref` error and both spans on a duplicate. The diagnostics are core's built-in ones, word for word and at the same positions. `bun run test:sugar-module` now also runs the contract suite of the IR entry point (`packages/core/src/ir-entry/contracts.test.ts`). - Completion facts stay on core's built-in path (lead ruling): for a unit whose module claims the atom keys, `CompileResult.atomFacts` is empty and `TranslateError.atomFacts` unset, so `atomCandidates` offers nothing. Both leave with slice c. - Mesh-visible: `SyntaxModule.afterLower`'s parameter becomes `LoweredUnit` (Mesh's module defines no `afterLower` today). `contractFields`, `checkContract` and `describeAttribute` are new, and `ContractData` carries `children` and `declares`, frozen. Contracts carrying `values`, `pattern`, `ref` or `declares` keep working through the mesh module, which claims them; a malformed value of one of them is reported at registration, called or not, with core's wording and position.

- **Removed (pr6-s1-babel-removed):** `markoBabel()` and its type `MarkoBabel` are no longer exported from `@mxlang/core` (decision 197, PR 6 slice S1). A host that parses JavaScript depends on `@babel/parser` itself; printing stays `printExpression`.

- **Changed (pr6-s1-babel):** Core lowers, prints and strips TypeScript with stock Babel instead of `@marko/compiler`'s bundled copy (decision 197, PR 6 slice S1). `@babel/parser`, `@babel/core` (its `traverse`, `types` and `File`), `@babel/generator`, `@babel/code-frame` and `@babel/plugin-transform-typescript` are exact-pinned runtime dependencies of `@mxlang/core`, external to its bundle and loaded lazily (the VS Code extension ships them beside its bundles); no published `.d.ts` names a `@babel/*` type. The `CompileError` text is byte-identical (the kleur colour rule and `cwd` are ported), and the stock generator prints every payload of the repo's `.mx` corpus as Marko's did (`babel.test.ts`). `@mxlang/html` and `@mxlang/angular` parse their modules and expressions with `@babel/parser` directly (a new dependency of each); `@mxlang/typescript-plugin`, whose dist inlines the Angular host, keeps `@babel/parser` external and declares it, so its bundles carry no second parser. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Removed (pr6-s2-lexer-removed):** `markoHtmljsParser()` and its type `HtmljsParser` are no longer exported from `@mxlang/core` (decision 197, PR 6 slice S2); nothing inside or outside core called them. A tool that needs MX's template lexer uses `@mxlang/parser`'s.

- **Changed (pr6-s2-lexer):** Core's parse-error rewrites (the mismatched-close opener, a failure inside a tag's `|params|`, sugar right after a default value, the atom hints, the shorthand-word probe) replay the source with MX's own template lexer (`@mxlang/parser/lexer`) on every run, never with `htmljs-parser` through `@marko/compiler` (decision 197, PR 6 slice S2). The dist already lexed with MX's parser; running from source now does too. No diagnostic text or position changes. `@mxlang/tsx-bridge` declares the `htmljs-parser` 5.18.0 its region walk bundles, which it used to resolve from the install around it; its output is unchanged. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Added (pr6-s3a-tagtable-added):** `tagTable(translator, nativeTags)` and its types `TagTable`, `TagEntry`, `TagParseOptions`, `NativeTag`, `NativeTags` and `NativeBodyMode` (`@unstable`): core's own tag table, which a compile, `parseFragment` and `parseMxDocument` now read for each tag's parse shape and for element resolution (decision 197, PR 6 slice S3a). A target hands core its native elements through the new optional `HostDeclarations.nativeTags` (also `parseFragment`'s base field `nativeTags` and `parseMxDocument`'s fifth argument); every built-in target passes `@mxlang/web-elements`' `WEB_ELEMENTS`. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Fixed (pr6-s3a-tagtable-fixed):** A custom tag's `ctx.build.element(name)` without a `void` option is now void exactly when an authored `<name>` is: the target's `nativeTags` declares it void, else core's own HTML void elements. It defaulted to `void: false` before, so `ctx.build.element("br")` rendered `<br></br>` on `@mxlang/angular` and `@mxlang/astro` (`@mxlang/html` hid it by re-reading core's void names, which its emitter no longer does). An explicit `void` still wins (review 475 r3, decision 197). A void element built with children, by default or with `{ void: true }`, is now a compile error at the tag ("`<br>` is void and takes no children; pass { void: false } to emit an end tag"): `@mxlang/html` dropped those children silently; `@mxlang/angular` and `@mxlang/astro` emitted `<br>child</br>`; and the JSX hosts (`@mxlang/preact`, `@mxlang/react`, `@mxlang/hono`, `@mxlang/solid`) compiled it to `<br>child</br>` JSX, which React rejects at runtime.

- **Removed (pr6-s3a-tagtable-removed):** A `marko.json` (or `marko-tag.json`) taglib is no longer read (decision 197, PR 6 slice S3a). A tag only a `marko.json` maps (`template`, `renderer`, `tags-dir`) is an unknown tag like any other: `@mxlang/html`'s "Unable to find entry point for custom tag" error, the native element on Preact, React, Hono and Angular. It was imported and called before. With it go `@mxlang/html`'s and `@mxlang/preact`'s `resolveDiscoveredTagModule` implementations; the optional hook stays on `HostDeclarations` for a third-party target. A `tags/x.marko` file is still the decision 172 error, now found by core's own discovery on every host. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Changed (pr6-s3a-tagtable):** A compile no longer builds `@marko/compiler`'s taglib lookup (decision 197, PR 6 slice S3a): core's own tag table, the target's taglibs over its `nativeTags`, gives the MX front end each tag's shape and tells lowering an element from a tag. It reproduces the lookup's merge for every translator MX builds, pinned against the live lookup (`tag-table.test.ts`). `@mxlang/preact`, `@mxlang/angular`, `@mxlang/solid` and `@mxlang/astro` now depend on `@mxlang/web-elements` and pass its table as their `nativeTags`. A `.<host>.mx` region reads the same table, so `<param>` is a native element in a region as it already was in a whole file. The `typescript-plugin` mapping pass builds core's table instead of Marko's lookup, and so does `@mxlang/core`'s `defaultTag` check (a tag only a `marko.json` maps is not a valid `defaultTag`). A target that declares no `nativeTags` now gets core's own HTML elements as its native layer, in a whole file, a region and the `defaultTag` check alike: the HTML element names and void names core already used, with `pre`'s preserved whitespace and `script`, `style`, `textarea` and `title` read as text. Before, Marko's lookup gave it HTML, SVG and MathML; a third-party target that renders SVG or MathML now passes `@mxlang/web-elements`' `WEB_ELEMENTS`. Lowering reads the same table for which elements are void, so a target's own `nativeTags` decides that in the IR too (it read core's fixed void names before, and dropped the body of an element the target's table did not declare void); `@mxlang/html`'s emitter trusts the IR's `void`. A registered translator-taglib tag with a same-named import or `<define>` in scope calls the module `resolveDiscoveredTagModule` returns for it (decision 164 addendum 1), and that hook's `.marko` answer is the decision 172 error.

- **Changed (pr6-s3b-translator-changed):** The lowering context's tag table is `Ctx.tagTable`, renamed from `Ctx.lookup` (decision 197, PR 6 slice S3b), along with `newCtx`'s matching parameter and `WildcardContext`'s picked field. It has been core's own tag table since slice S3a; the old name described the Marko lookup S3b deleted. A host or tool that reads or sets `ctx.lookup` must use `ctx.tagTable`. `parseMx`'s `lookup` option keeps its name. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Removed (pr6-s3b-translator):** Marko's taglib lookup and its cache surface are gone from `@mxlang/core` (decision 197, PR 6 slice S3b). `buildMarkoLookup` and the `Lookup` type are no longer exported: core's own `tagTable(translator, nativeTags)` is the lookup, and its comparison with Marko 5.42.11's lookup is now a frozen fixture (`tag-table.expected.json`) instead of a live call, for the same six translator shapes and every name they hold. `evictTaglibCaches` is removed with the Marko half of the scan cache it cleared. `clearScanCache` and the per-map cache of loaded custom tags are unchanged. `Translator` no longer has a `tagDiscoveryDirs` field, so neither do `createTranslator`'s result or the `translator` objects `@mxlang/target-html` and `@mxlang/host-preact` export. Nothing read the field once `@marko/compiler` stopped running a compile; tags beside a file still reach a compile as `customTags`, found by the integration. `TranslatorOptions.tagDiscoveryDirs` is still accepted, but unread and `@deprecated`. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Changed (pr6-s4-host-view):** No user-visible change. Core now builds, internally, a plain-data view of a tag and its attributes for host hooks to receive later; nothing new is exported and no hook receives it yet. No diagnostic text or position changes. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged.

- **Changed (spec-182):** Docs only: the core README and package description no longer say core parses with Marko's parser (it parses and lowers with its own front end; Marko's syntax is the default, `.marko` files are not an input), and the html README no longer claims to be stock Marko or to compile Marko templates unchanged (divergences are listed in `divergences.md`). The specification gains the layer-2 syntax table section (decision 182): `package.json#mx.syntax`, syntax modules, the trigger hooks, the `"member"` contract type and `DataTag.trigger`.

- **Fixed (sugars-followup):** Follow-ups to the atoms-and-sugars syntax module (PR 460) from Mesh's review of it. Two additions are visible to a syntax module such as Mesh's: `TriggerMethod.async` and the `"async-method"` value of `TriggerContext.valueForm` (with the new exported type `TriggerValueForm`). - core, parser: `async` before a method-valued attribute trigger (`kind async :name(p) { b }`) reaches the hook as a method with `async: true` and `ctx.valueForm` `"async-method"`. The trigger's text and span are its own token, never `async`, and the method value's span starts at its `(` or `<`; before, the method's text included the trigger. A `ctx.fail` with no position points at the trigger. `async` with no method after it is still a plain boolean attribute. - core: `@mxlang/core/syntax/atoms-sugars` and `@mxlang/core/syntax/mesh` refuse an async `:name` method at the `:name`, naming the form. Core's built-in sugar keeps alpha.14's behavior (`async` is an attribute). - core: the two reference modules' messages no longer quote MX decision numbers. `syntax/member` refuses a value after an attribute member (`&dueOn=1`, `&dueOn(x) { … }`) as "`&dueOn` is a member reference and takes no value". That refusal is reported at the member, not at the value (it was at the value before: column 12 for `sort asc &a=1`, now column 9), because a hook gets no span for a method or argument value. Core's generic error for a trigger value the hook drops now reads "`<text>` takes no `=value` here: the `<id>` trigger does not place it", at the value, and no longer names `lowerTrigger`. - core: Mesh's entity files and docs blocks are checked in as a golden parse corpus (`src/fixtures/syntax/mesh-corpus/`, MIT, attributed) and parsed by `packages/core/src/ir-entry/mesh-corpus.test.ts` through `syntax/mesh`. - The lifetime of the two reference modules is documented: exported, `@unstable`, through the beta; Mesh vendors them at the alpha.15 pin. - `bun run test:sugar-module` exits 2 with a "not built" message when a needed `dist` is missing, and writes its report under `node_modules/.cache/sugar-module/` instead of the system temp directory.

- **Changed (tree-ir-entry):** The tree target is replaced by core's IR entry point (decision 204). A program that reads a `.mx` file as a tree (a dialect such as Mesh's resource definitions) now calls `@mxlang/core`'s `lowerSource` and walks core's own IR; there is no second projection of it. - Removed: the `@mxlang/data` package, with `parseData`, `parseDataFile`, `serializeDataDocument`, `dataDeclarations`, `dataTaglib`, `neutralizations`, `DATA_TAGLIB_ID`, `RESERVED_NAMES`, `ParseDataOptions`, `ParseDataResult`, `DataDiagnostic` and the `Data*` tree types (`DataDocument`, `DataNode`, `DataTag`, `DataAttr`, `DataAttrTag`, `DataExpr`, `DataImport`, `DataStatement`, …). `@mxlang/targets` no longer registers the `tree` descriptor, and `mx.target: "tree"` in a `package.json` is an error in every tool: ``mx.target "tree" was removed (decision 204); a consumer that reads the tree calls lowerSource from @mxlang/core``. The hint for the reserved name `data` (in `mx.target` and in a descriptor's `builtOn`) ends the same way instead of pointing at `"tree"`. The `mx-tsc` check of a data package goes with it: a project with `mx.target: "tree"` now gets an ordinary `tsc` run plus that error. Dialect files are not checked by the tools until the dialect API lands. `@mxlang/data` is deprecated on the registry at the next publish. - Added (`@unstable`): `lowerSource(source, filename, options?)` and `lowerFile(path, options?)` return `{ ir, diagnostics }`: a `SpannedIr`, or `undefined` when any error was reported (never a partial IR), and every independent diagnostic as an `IrDiagnostic` (`severity`, `message`, `line`, `column`, `offset`, `file?`, `code?`). No source input makes either throw. Options: `customTags`, `syntax`, `tagRules`, `defaultTag`, `structural`, `imports`, `unknownTags`, `warnings`; all but `tagRules` have `parseData`'s meanings. With `tagRules: "none"`, every diagnostic `parseData` reported is reported at the same text and position, including the messages that still say "data tree"; under the default `html` rules a file `parseData` accepted can fail (`<input><child/></input>` is ``The closing "input" tag was not expected``). - Added (`@unstable`): tag rules presets, `tagRulesPreset(name, nativeTags?)` with `TagRules` and `TagRulesPreset`. An absent `tagRules` is `html`, the full HTML rules (decision 212 item 8); a dialect whose tags are not HTML passes `none` (Mesh does). `none` has no native elements, so Marko's 19 HTML parse rules (void, raw text, preserved whitespace) are off and `source`, `input` or `title` is an ordinary tag; it declares the module statements and an open-tag-only `<const>`/`<return>`. `markup` adds the web elements and core's statement tags; `html` is the html target's whole table. `tagRules` is a `lowerSource` option only, never a project or host setting (ruling 209). - Added (`@unstable`): `IR_VERSION` (today `1`), the version of the IR's shape, which goes up by one with every change a reader of the IR can observe. - New exports of `@mxlang/core`, all `@unstable`: the functions `lowerSource`, `lowerFile` and `tagRulesPreset`; the values `IR_VERSION` and `TAG_RULES_PRESETS` (`["html", "markup", "none"]`); the types `LowerSourceOptions`, `LowerSourceResult`, `IrDiagnostic`, `Spanned`, `SpannedIr`, `ImportName`, `TagRules` and `TagRulesPreset`. - Changed: spans are guaranteed where a consumer needs them. `Attr.span` is set on every attribute kind (name through value, arguments with their parentheses included, a spread from `...`, a name sugar's token, a default attribute from its `=`; a synthesized attribute, such as a shorthand with a placeholder or a shorthand class merged into `class`, has none, and `lowerSource` reports those forms as positioned errors, as `parseData` did), and `AttributeTagIf`/`AttributeTagFor` carry the span of the whole `<if>` chain or `<for>`. `Import` gains `from`, `names` (`ImportName`: `imported`, `local`, `kind`, `span`, `localSpan?`, `typeOnly?`) and `typeOnly`, read from the parsed declaration. `SpannedIr` makes every `span` required in its type, and with it a static attribute's `valueSpan` and an `Import`'s `from` and `names`, and the IR `lowerSource` returns is a fresh copy whose `DelegatedTag`/`AttributeTag` spans end at the tag (the trailing line terminator of a concise tag is trimmed) and whose `DelegatedTag.args` is always present (`[]` with none). - Migration from `parseData`: pass `tagRules: "none"` to keep `parseData`'s parse rules (the default is `html`). A tag is `ir.body[i].tag` (a `DelegatedTag`; attribute tags are `attributeTags`/`attributeTagTree`); attribute kind `string` is `static` and `expression` is `dynamic`, and a whole-value atom or member is a `static` attribute carrying `atom`/`member`; a wildcard-matched child's `tag.name` is the canonical contract name, with the authored spelling in `tag.alias.authored`; `statements`/`imports` are `ir.imports` and `ir.hoisted`.

- **Added (mx-config):** MX's settings now load from a config file found with cosmiconfig under the name `mx`: `mx.config.ts`, `.js`, `.cjs`, `.mjs`, `.mts`, `.cts`, `.json`, `.yaml` or `.yml`, `.mxrc` and `.mxrc.*`, the same names under `.config/`, or the `mx` key of `package.json`, which stays valid with the same positioned errors. One file serves the whole project: MX reads it from the directory of the compiled file's nearest `package.json` only, never from a subdirectory or from above, so every tool resolves the same config for a file. In that directory `package.json#mx` wins, and every other config file there gets a `shadowed-config` warning naming the one in force. Configs are never merged. A config that is not an object (an array, a scalar, a module exporting a function or a promise) is a `malformed-config` error. The config is optional: with none, the target still comes from the `@mxlang/*` dependency or defaults to `html`. `mx.host` and `mx.target` are read the same way in every format. Relative paths (`tags`, `contracts`, a target package) resolve from the config's directory. Settings for a dialect live under the dialect's id, and MX passes them through without reading them. `extensions`, which maps a file extension to a dialect, is read from the config in every format. `mx.dialect`, a dialect package's identity block, is never read as MX's config. `provideMxConfig(root, config, { file })` lets a dialect or tool hand MX a config it built itself, without a file search. `findMxConfig(dir)` returns the config that applies to a directory and where it came from, and `isMxConfigFile(path)` tells a watcher whether a changed file is a config file. The language server, the Vite plugin and the Angular watcher pick up an edit to the config, or a config file created or deleted, without a restart. While an edit leaves the config unreadable, the last revision that loaded stays in force, and the problem is reported as a `malformed-config` error at its position in the file. Configs load synchronously, so a module config cannot use top-level `await`. An ES module config needs Node 22.12 or later (22.18 for TypeScript) or Bun; on an older Node, MX's error says so instead of the runtime's. On Node, an edited ES module config needs a restart to apply, and MX says so; reverting it to the text that last loaded clears the error. The Angular watcher now also rebuilds on an edit under `.config/`.

- **Fixed (lowercase-local-component):** A lowercase tag naming a local binding is now Marko's own error, in core, on every target — same message verbatim, same position (the tag name): `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`.` The rule covers every local binding: a default or named `import` (a `.mx` tag module or a `.ts` value alike), a lowercase `<define>`, a `<const>`, a `<for>`/`<define>` tag param, a `static` declaration (`static const layout = 1` then `<layout/>`, plain or destructured), and an `export const`/`function`/`class` declaration. A core taglib name (`<debug>`, `<log>`) keeps its own routing — as in Marko — even when bound: no error and no "native element" warning. A native-element name stays native (silently for a value binding, with the existing warning for a tag binding); a registered custom tag, a taglib tag or a host claim still wins whatever is imported. `_`/`$`-prefixed names follow Marko's message, whose naive capitalization offers "rename to `_row`". Before, the error existed only for a tag binding (a `<define>` or a `.mx` default import) and in core's own wording ("`<layout>` is not a tag here…"), a lowercase **value** import (`import layout from "./layout.ts"` then `<layout/>`) was a silent pass on preact, react, hono, solid and astro (a literal lowercase element was emitted) and only html rejected it, through its own `rejectComponentTag` hook (now removed — core covers it). The `<const>`, `static` and tag-param forms fell to the unknown-tag path at best (html) or passed silently (the JSX hosts); a core taglib name bound by an import drew the local-variable error on the JSX hosts, where Marko compiles the tag. The message and position are measured on the stock parser (`@marko/compiler` 5.42.11 / `marko` 6.4.4): identical for a tag import, a value import, a `static const` local, an `export const` local, a `<const>` and a `<for>` param. The rest of the lowercase-tag rules are unchanged. One boundary, matching the existing import behaviour: a use *before* the `import`/`static`/`export` statement is not covered — bindings register in document order.

## 0.1.0-alpha.14 — 2026-10-09

- **Fixed (html-publish-prep):** Publish prep for `@mxlang/html` and the repository metadata: `@mxlang/html` ships its `LICENSE` and declares `publishConfig.access: public`; every `repository` URL points at `github.com/svallory/mxlang`; the README and docs example import the named `translator` and lead with `compile`; `@mxlang/core` writes `dist/THIRD-PARTY-NOTICES.md` with the licence text of the vendored `@babel/parser`, `@babel/helper-validator-identifier` and `charcodes` that `dist/index.js` bundles.

- **Changed (marko-644-pin):** Pin `@marko/compiler` 5.42.11 in `@mxlang/core` and `@mxlang/html`, and `marko` / `@marko/runtime-tags` 6.4.4 in the oracle, so the html oracle goldens and every parity claim run against Marko 6.4.4.

- **Added (mesh-alpha14-asks):** - `@mxlang/core/syntax/member`: Mesh's `&` member sigil module (all three trigger positions) ships in the tarball as a documented reference for extension authors (`dist/syntax/member.js` and `.d.ts`; the README shows the `import` and the copy-and-rename path). It is built on the public hook API only; core stays host-agnostic. - core: an IR tag a syntax module builds with `ctx.child` carries `trigger: { id, span, text }` (the trigger row's id, its source span and authored text, the facts `extra.mxTrigger` carries on expression stand-ins). Authored tags have none. Additive. - data: `DataTag.trigger?: { id: string; span: Span; text: string }` exposes it, so `&title` and an authored `<member name="title"/>` are told apart without comparing spans. - data: `DataImportName` gains `span` (the imported name as written; the binding for a default or namespace import) and `localSpan` (the alias, only when the local differs from the imported name). `parseData`'s option shape is unchanged. All additions are optional/additive.

- **Fixed (try-placement):** Refuse the `<try>` shapes Marko 6.4 refuses: a `<try>` with no body content, and a `<try>` with neither `<@catch>` nor `<@placeholder>` (it would have no effect), each positioned at the `<try>` tag on every target. A `<@catch>`/`<@placeholder>` written under `<if>`/`<for>` was already refused at the misplaced tag.

## 0.1.0-alpha.13 — 2026-10-09

- **Fixed (fix-426-nested-attr-tag-pos):** A legacy host's "nested attribute tags aren't supported" error points at the first nested attribute tag again (`<@icon>` in `<Panel><@item><@icon/></@item></Panel>`, column 14), not at the outer `<@item>`, as before the attribute-tag lowering moved to child selection. New public export `firstAttributeTag(node)`: the first attribute tag a tag carries, from Marko's `attributeTags` field or from `MxAttributeTag` children, for a host diagnostic to point at.

- **Added (lang-ext-lowering-half):** Layer-2 syntax modules (decision 182 addendum 5). `package.json#mx.syntax` may name a module (a package name or a path relative to the manifest, resolved like `mx.contracts`) whose default export is a `SyntaxModule`: `{ table, lowerTrigger?, lowerBlockTag?, lowerFilter?, afterLower?, productName? }`. The `syntax` option of `compileSource`, `parseFragment` and `parseData` takes a module too. An inline `mx.syntax` stays table-only: a `{ call }` trigger there, or in a module that exports no `lowerTrigger`, is an error at the `mx.syntax` key. Triggers lower before anything reads the tree. An expression trigger's stand-in becomes the node `ctx.expression(node)` carries, and the expression's emitted `code` carries that node printed (`&status` becomes `self.status`), as it carries an atom's string literal. An attribute trigger becomes the attribute `ctx.attribute(name, value)` builds. A tagless-line trigger becomes the child tag `ctx.child(tagName, attrs)` builds, which then goes through the normal tag path. `ctx.position` and `ctx.value` (the lowered `=value`) are read-only. The built-in node kinds (`"string"` and `"identifier"` in expressions, `"attribute"` in attribute lists) lower without a hook. Block tags and filters go to `lowerBlockTag`/`lowerFilter` with `ctx.build`. Positioned errors cover a result that does not fit its position, a hand-made result, a hook that throws, a `=value` the hook drops, a trigger in binding position (`(&a) => 1`), a trigger as a property name (`{ &a }`, `{ &a: 1 }`), a `ctx.expression` node that is not an expression, and a built-in kind in a position where it has no meaning. A `{ call }` trigger nothing lowers keeps "`<id>` trigger has no lowering yet". New IR: `Member`, `MxMemberMark`, and `member?` on a static `Attr`. New contract type `type: "member"`: it accepts a member in either form, the static value after a kind or a dynamic value that is exactly one marked member (`load=&visible`). An `"expression"` slot accepts a member too, an `"atom"` slot refuses both forms ("must be an atom, got a member"), and `values`/`pattern`/`ref` stay atom-only. A second member in one name slot (`sort asc &c &d`) is a positioned error ("one member per slot"), not a dropped duplicate. `@mxlang/data`'s `DataAttr` gains the variant `{ kind: "member"; name; value; nameSpan?; span }`, a sibling of the atom variant.

- **Changed (port-pr4-slice2):** No behaviour change; lowering retyped to the MX AST for node kinds and spans (parser port PR 4, slice 2): the child dispatch, layout and statement scans accept the MX node kinds beside Marko's, and positions read an MX node's UTF-16 offsets where a Marko node has `loc`. `TranslateError` gains an optional `span` (`SourceSpan`, file offsets): set when the error was raised on an MX AST node, kept after `line`/`column` are filled in from the source.

- **Changed (port-pr4-slice3):** No behaviour change; lowering retyped to the MX AST for tags (parser port PR 4, slice 3): tag names (`MxTagName` static, dynamic and unnamed), the attribute list (comments dropped), the tag variable, arguments, params, type arguments and the child list are read from either AST through `tag-fields.ts`, the MX containers unwrapped with `payloadOf`. Type arguments on an MX tag are refused like Marko's, not dropped.

- **Changed (port-pr4-slice4):** No behaviour change; lowering retyped to the MX AST for families 2 and 3 (attributes and name sugar): attribute values, methods, bound attributes and the default value read from `MxAttribute`, and `#id`/`.class`/`:name` sugar from `MxShorthand` through a pre-pass that never mutates the MX tree.

- **Changed (port-pr4-slice5):** No behaviour change; lowering retyped to the MX AST for text, placeholders, comments and embedded payloads (parser port PR 4, slice 5): a placeholder's expression and a scriptlet's statements are read from their MX containers, and an MX comment's `kind` decides whether it is an HTML comment instead of re-reading its source. New, MX-path only: `payloadOf` unwraps a container and fails, positioned, on an expression trigger (decision 182, no lowering yet), on the container's parse error, or on a container with neither (an MX bug).

- **Changed (port-pr4-slice6):** No behaviour change; lowering retyped to the MX AST for module statements and its own signature (parser port PR 4, slice 6). An `MxModuleStatement` (`import`, `export`, `static`, `server`, `client`, `class`) lowers exactly where Marko's statement tag did, by its keyword. A statement is a statement because of its node kind, not because it has `rawValue`. Its IR `end` comes from `untrimmedEnd`. The internal walk takes `readonly MxChild[]`. `lower` and `lowerChildren` are published as `readonly Node[]`, which accepts everything the old `Node[]` did. New, MX path only: a child-level `MxTrigger`, `MxBlockTag` or `MxFilter` fails, positioned, with the syntax pre-pass's "has no lowering yet" wording (decision 182). An offset-only error about another file (`TranslateError.file`) is no longer positioned against the file being compiled.

- **Changed (port-pr5-mx-path):** `compileSource`, `parseFragment` and `parseData` (its compile and its `unknownTags: "reject"` tag scan) now parse with the MX front end (`@mxlang/parser/frontend`, inlined into core's dist) instead of `@marko/compiler`: no production call site parses through `@marko/compiler` any more, which stays only as a test oracle; `parseFragmentNative` now delegates to `parseFragment`. New `parseMxDocument` (`@unstable`, for data's scan): a file's MX document as `compileSource` parses it, without lowering, or `undefined` when the template does not parse. One parse per compile: the syntax-table pre-pass is gone, and its "`<id>` trigger has no lowering yet" error comes from the compile's single document. `FragmentResult.body` is the MX body and `FragmentResult.ast` the `MxDocument`; an expression error in a fragment stays on its container and is raised by `lower`, and `parseFragment` throws for the same inputs as before (a template error, a bare `,` line, a method's type-parameter error). Host hooks (`resolveDelegatedTag`, `rejectModifier`, `resolveDefaultTag`, …) still receive Marko-shaped nodes, now a read-only view of the MX node. Error text and positions are unchanged, with one exception: the `CompileErrors` aggregate message is Node's form on every runtime (no Bun/JSC stack frames inside `@marko/compiler`). Removed: decision 151's stock-parser diagnostics (a stock `htmljs-parser` never parses MX input).

- **Added (tree-imports-parsed):** Each `DataDocument.imports` entry now carries `from` (the module specifier) and `names` (`{ imported, local, kind: "default" | "named" | "namespace" }`, with `typeOnly: true` on a name written `{ type X }`) beside `code` and `span`, plus `typeOnly: true` on a whole `import type`. They are read from the Babel `ImportDeclaration` the MX front end parsed, never from the statement text. To carry it, core's `Import` IR node gains an optional `declaration` (the parsed `ImportDeclaration`, as the author wrote it: type-only marks included, although the compile strips them from the payload before lowering); it is absent on a synthesized import. An `import` that is not one ES import declaration (`import x = …`, several statements in one `import`, Flow's `import typeof`) is now a positioned error at the statement on every target (decision 193); `import x = require("y")` no longer shows Babel's CommonJS advice.

## 0.1.0-alpha.12 — 2026-10-09

- **Added (lang-ext-syntax-table-parser-c):** `package.json#mx.syntax` (decision 182, PR C): core resolves a file's syntax table from its nearest manifest (a dependency's files use the dependency's manifest), overlaid on the `.mx` default row, validated with positioned diagnostics at the manifest's `mx.syntax` key (`tagTypes` is refused: tag types are taglib-owned), frozen and interned by hash. `compileSource`, `parseFragment` and `@mxlang/data`'s `parseData` accept an explicit `syntax`. Core lowers no trigger yet: a file whose table produces a trigger, block tag or filter fails with one positioned error ("`<id>` trigger has no lowering yet"), and a project on the default row runs no extra parse. New exports: `SyntaxTable`, `Trigger`, `StandIn`, `TriggerNode`, `SyntaxDiagnostic`, `defaultSyntax`, `normalizeMxSyntax`, `resolveSyntax`, `syntaxHash`.

- **Changed (release-changelog-in-package):** `CHANGELOG.md` is now part of every published tarball (`files` lists it in all packed packages); `bun pm pack` honours `files` only, so the alpha.11 tarballs carried just `README.md` and `dist`.

- **Fixed (tree-reject-invalid-tag-names):** A tag name outside letters (any script), digits and `-._:$` (`&title`, `a!b`) is now a positioned error on the name ("Invalid tag name `&title`; Marko rejects it too — …"), next to the existing attribute-name error, on every target. Stock Marko lexes such a name and fails only later in its translator ("Unable to find entry point for custom tag"); `parseData("div\n &title\n")` used to return a child tag named `&title` with no diagnostic.

## 0.1.0-alpha.11 — 2026-10-09

- **Added (data-attribute-tags-wildcard, decision 147 extended to attribute tags):** `attributeTags["*"]`, the `children["*"]` wildcard for attribute tags. An entry is `{ pattern?, repeatable?, attributes?, attributeTags?, children?, defaultTag? }`, object or ordered list; `pattern` is a regex source anchored as `^(?:pattern)$`, an entry with no `pattern` is a catch-all. Check order per authored attribute tag: explicit `attributeTags` entry first, then the `"*"` entries in order, then the usual unknown-name error. `repeatable` applies per matched name; `required` is rejected at registration (a wildcard has no single name to require). Entries are always inline contracts (no `contract:` form — attribute tags carry no transform). Registration rejects unknown keys, non-string/non-compiling/non-whole patterns, self-containing entries and non-object values. New exports `WildcardAttributeTagEntry`, `WildcardAttributeTags`, `CustomTagAttributeTags`; the validators (`validateAttributeTags`, `validateCustomAttributeTagBodies`, atom contracts, wildcard-resolve scope walk, `defaultTag` chain) all resolve through the same match.
- **Added (`from` on builders):** every `ctx.build.*` builder in `IrBuilders` (except `expr`, which produces no positioned node, and `template`, which routes the template's own positioned output) accepts an optional last argument `from` — an `IrNode` already in the tree, an `AttributeTag`, a `TagCall`, or a `{ loc, nameSpan?, span?, valueSpan? }` object (an attribute of the call is the common one). The built node takes `loc` from it, plus `span` and `nameSpan` where the source and the built kind have them; a node built with only a name span reports that range as its span. A static attribute built `from` an authored attribute also takes its `valueSpan`. Without `from`, today's stamping (the call site's `loc`, zero `nameSpan`) stays, byte for byte, so existing callers compile and emit unchanged. New exported type `BuildFrom`.
- **Fix (dynamic-tag-var-silent-drop):** a tag variable a host cannot bind (`/n` on a dynamic tag on the JSX hosts and Solid, on a `.ts` component anywhere) is reported at the `/var` itself, not at the whole tag — the construct the author wrote wrong is the binding, and on a long call the tag's start can be far from it. Message unchanged.
- **Fix (html-comment-body-markup):** `parseFragment` (every region host's front door) registers core's raw-text parse options itself, through the new `mx-parse-options` taglib (`PARSE_OPTIONS_TAGLIB`), so a tag body the parser must read as text no longer needs a host taglib to reach the parser. `<html-comment>`'s markup body is text (`<html-comment>x <i>z</html-comment>` renders `<!--x <i&gt;z-->`, not Marko's close-tag mismatch), an unterminated `<!--` is Marko's "Missing ending" error, and a nested `<!-- b -->` keeps its surrounding whitespace. The same slice carries `<script>`, `<style>` (`rawOpenTag`, `html: false`), `<html-script>` and `<html-style>`, so their bodies are raw text on the fragment path too, matching Marko; `controlFlow` is deliberately excluded, so `<if=x><@a/></if>` keeps its element shape and `@tag` nesting.
- **Added (`afterLower` seam):** `Ctx.afterLower`'s default list is seeded in `newCtx`, so the atom-contract check runs on every lowering path — a `.solid.mx`/`.preact.mx` region, a `.ng.mx` or `.astro.mx` template and a template unit's metadata compile enforce an atom contract the same way `compileSource` does. Callers append host hooks to `afterLower`, never replace it.
- **Added (`productName` option):** diagnostics that name the product read `productOf(ctx)` (now exported), so `productName` renames them too; default output is byte-identical.
- **Changed (tag-argument messages):** tag-argument diagnostics are Marko-exact.
- **Added (shorthand-class-diagnostics, decision 174):** positioned errors with a `class="…"` hint for the class/id shorthand's silent wrong outputs, on every target. A shorthand part with an unbalanced `[` or `]` (`.bg-[#fff]` read as `class="bg-[" id="fff]"`; `.data-[state=open]:flex`, `.bg-[url('/x.png')]`, `.[&>*]:p-4` and `.w-[calc(100%-2rem)]` died in Marko's group reader with "Mismatched group" or "Missing ending tag") is one error at the part; a purely numeric class part split off by a `.` (`.w-1.5` read as `class="w-1 5"`) is the same error, while a digit-leading part (`.2xl`) stays valid; a `/` right after a shorthand followed by a non-identifier (`.w-1/2`) names the shorthand and `class="…"` instead of Marko's tag-variable text and link. `.hover:bg-red`, `.a.b#c` and `.w-1` stay valid with no diagnostic.
- **Added (shorthand-class-diagnostics, decision 174):** positioned errors with a `class="…"` hint for the class/id shorthand's silent wrong outputs, on every target. A shorthand part with an unbalanced `[` or `]` (`.bg-[#fff]` read as `class="bg-[" id="fff]"`; `.data-[state=open]:flex`, `.bg-[url('/x.png')]`, `.[&>*]:p-4` and `.w-[calc(100%-2rem)]` died in Marko's group reader with "Mismatched group" or "Missing ending tag") is one error at the part; a class part that starts with a digit (`.w-1.5` read as `class="w-1 5"`) is the same error, and makes `.2xl` an error where it was valid; a `/` right after a shorthand followed by a non-identifier (`.w-1/2`) names the shorthand and `class="…"` instead of Marko's tag-variable text and link. `.hover:bg-red`, `.a.b#c` and `.w-1` stay valid with no diagnostic.
- **Fix (routed-template-call-namespan):** a discovered template tag's call, routed to its generated `$mx_X1` binding, keeps the authored tag name's span in `Component.nameSpan` (it was `null`; `TagCall.nameSpan` was dropped). `nameSpan` is `null` there only for a synthesized call with no source. IR spec 5.6 updated. A host that maps an imported component's name now maps the routed call's name the same way: a type error on a discovered-tag call (a missing prop) has an authored position.

- **Fix, behaviour change (unresolved-tags-dir-diagnostic, decision 172):** a `.marko` file used as a tag is one positioned error at the tag on every target, naming the file and saying to convert it to `.mx`, with the same text everywhere: a `tags/x.marko` or `tags/x/index.marko` found by Marko's lookup, a `marko.json` template, an authored default import of a `.marko` file. It is never compiled as MX, never a silent native element and never an emitted import. A `tags/x/index.mx` directory tag (Marko's lookup finds it; MX imports flat `tags/<name>.mx` files only) is a positioned error too, where it compiled as the native element (Solid, Astro, Angular) or as a call to an unbound name (html). New `markoFileTagMessage` export and `uncalled-tag-file.ts`. The same error for a `.marko` import used as a direct dynamic tag (`<${X}/>`); `tags/<name>/<name>.<ext>` directory tags are covered; a `marko.json` tag with no template (a `renderer`) is a positioned error.

- **Fixed (define-param-default-empty-error):** a parse failure inside a tag's `|params|` (`<define/Foo|{a=}|>`, `<for|{a=}| of=x>`) is a positioned `TranslateError` at the param with Babel's reason ("Unexpected token"), on every target. Marko threw its `CompileError` at 0:0 with a message that opens with an empty line (whole-file entries), and a region (`parseFragment`) lowered the unreadable param as one that binds nothing.

- **Changed (rename-data-target-to-tree):** **BREAKING (decision 187):** the registered target name `"data"` is now `"tree"`: `mx.target: "tree"` selects it, a third-party host declares `builtOn: "tree"`, and every diagnostic names `tree`. The literal `"data"` is reserved for the future evaluated tree target and is refused with a positioned error (`"data" is reserved for the evaluated tree target (decision 187); the static tree target is "tree"`), under `mx.target` and `builtOn` alike. `mx.data.*` config is unchanged — including `defaultTag` (`mx.tree.*` is read by no tool) — and the package name stays `@mxlang/data` (`parseData` keeps its name).

- **Added (target-descriptor-config-key):** `TargetDescriptor.configKey?: string` names the `mx[<key>]` config block a target reads (`defaultTag` today), when it is not the target's own `name`; defaults to the target's name. A bare word, validated at load. The tree target sets `configKey: "data"`, so the decision-187 rename does not move `mx.data.*`.

## 0.1.0-alpha.10

- **Fixed (regression in 0.1.0-alpha.7 to alpha.9; decision 156 addendum 13):** in a body, text after a non-breaking space (or other Unicode whitespace) followed by `//` or `/*` is text again, as in Marko. `<p>Visit<NBSP>//cdn.example/x.js</p>` had been read as a comment that swallowed `</p>`.
- **Fixed (decision 156 addendum 13):** the word class the bundled template parser uses when it looks behind or ahead is exact: a code point at or above U+0080 counts only when it is an identifier character (Unicode `ID_Continue`, U+200C, U+200D; a surrogate pair is one code point). Symbols and emoji (`©`, `×`, `…`) no longer count, so `<div x=a >©>c</div>` parses as in Marko.
- **Fixed (decision 165):** a tag that never gets a name (`<,>a`) is reported through the parser's error callback instead of throwing.
- **Unchanged, stated for clarity (decision 156 addendum 15):** the after-value rule's `:name` test stays ASCII-only; `x=(a) :É => a` is one value.

## 0.1.0-alpha.9

- **Added (bound-attribute-refinement):** `Attr` `bound` carries `refinement?: Expr`, the `fn` of `<Foo v:fn:=q/>`: Marko binds `v` and its change handler runs `q = fn(next)`. The `Expr` is an identifier over the modifier's text (`node: null`, `span` on the modifier). A modifier that is no valid JavaScript identifier (`x::=q`, `v:no-update:=q`, `v:class:=q`) is Marko's error, "Bound attribute refinement shorthand must be a valid JavaScript identifier.", at the modifier, on every tag shape (native, dynamic, component, contracted custom-tag call and its attribute tags, control tags). A host that applies the refinement (Angular: `[v]` plus `(vChange)`) does; html ignores it (render-once, like Marko's server html); the hosts that refuse `:=` refuse the refined form with their own error. Replaces the positioned error alpha.8 raised for a modifier on a bound attribute (decision 169, withdrawn).

- **Fix (statement-followup, decision 168):** a decorator in a `static`/`export`/`server`/`client` statement is read again (`decorators-legacy` in the statement parse), so `static class K { @d m() {} }` compiles on every host as before #395; the class text reaches the module intact. JSX in a statement stays an error, now with MX's own message positioned at the first element's `<` ("JSX is not read inside a `static` statement: its text is TypeScript. Write the markup as a tag in the template, or in a `<define>`") instead of Babel's "Unterminated regular expression."; a `<` right after a `>` (a join with the template line below) keeps Babel's own message. Measured table: `scratch/reports/squad-targets/measure-395-jsx-decorator.md`.

- **Added (data-check-keys-on-base-target):** `TargetDescriptor.builtOn?: string` (`@unstable`), the registered target a descriptor is built on, and `TargetLookup.baseTargetOf?(target)`, the end of the chain. `createTargetLookup` resolves it: an unregistered name (`built-on-unknown`, with a hint naming the target when the name is a host name) and a target built on itself or a loop (`built-on-loop`) are `TargetLookupError`s naming the targets; `validateDescriptor` rejects a `builtOn` that is not a bare word. Any target can be built on any other; core names none. Also: optional `TargetLookup.allTargetNames?()` (every name `target()` answers, a target kept from selection included), which a loaded descriptor's registration check lists for an unknown `builtOn`; and the policy diagnostic code `default-tag-overridden`. `TargetPolicy.defaultTag` may now come from the base target's key when a registry folds it in.

- **Fix (statement-tags r3, decision 168):** a `server` or `client` statement's text gets the same Marko-matching syntax check as `static`/`import`/`export`, before a host runs, drops or refuses it, so an invalid join can no longer pull the next template line into it silently.

- **Fix, behaviour change (statement-tags r2, decision 168):** (1) `withStatementTags` (exported) adds the statement entries to any translator `buildMarkoLookup` is given, and `lowerStatement` refuses a `static`/`import`/`export` the parser read as attributes (a translator built without them) with a positioned error naming `createTranslator`; the by-name recovery of such a tag is gone. `Translator.statementTags?: false` marks a translator that declares its own (data). The TS plugin's mapping pass builds its lookup through `buildMarkoLookup`. (2) A statement's text is parsed as TypeScript like Marko does: a syntax error is positioned at the offending character on every target (JSX or a decorator in a statement, `{ k: :name }`), and a line ending in `>` that swallows the next template line is Marko's own error at that line instead of a silent drop; a valid join (`1 +⏎2`) compiles. html, Solid and Astro used to emit such text unchecked.

- **Fix (statement-tags, decision 168):** `createTranslator` and `parseFragment` register core's statement taglib (the six entries with `parseOptions.statement`; `statementTags: false` opts a translator out, as data does) on every parse, so `import`, `static`, `export`, `client`, `server` and `class` are statement tags to the parser on every target, not only html. A typed `static function f(a: number): string {…}`, a `<T,>` generic, JSX or an atom in a statement used to throw a Babel syntax error on Preact, React, Hono and Angular (the text was read as attributes). `class { … }` is one positioned "not supported in MX" error on every target.

- **Fixed (main-differential-crashes):** a top-level concise line holding only `,` (also `, --x`) is a positioned `TranslateError` on every target, "a `,` continues the attributes of the tag above; there is no tag here", instead of Marko's uncaught `TypeError: undefined is not an object (evaluating 'tag.name.value')`. `parseFragment` also surfaces Marko's own positioned parse error for a method whose type parameters are not a type-parameter list (`<div x<A<B>>(a) {b}/>`; a valid nested list is `x<A extends B<C>>`) instead of the printer's `unknown node of type undefined with constructor "Array"`.
- **Added (core-error-recovery, decision 162):** `lower` recovers per tag: a tag that raises is recorded, skipped with its whole subtree, and lowering continues. `compileSource` throws a `TranslateError` carrying an additive `errors: readonly TranslateError[]` (the thrown error first, exactly the single throw of before; the rest by position), and the new `otherErrorsText(error)` renders the others for a tool that can show one error. A tag template's own lower and fragments still throw at once. Error-free files are byte-identical. A failed `<define>` head still binds its name (no cascade on later calls), and a file with an `analyze` tag reports the walk's errors, not the hook's. A failing compile may now list a callee it read after its first error among `dependencies`.

## 0.1.0-alpha.8

- **Added (solid-whole-file-typecheck, #362):** two additive optional IR fields: `Expr.unrewrittenCode?`, the text of `code` before a reads rewrite changed it (set only when it did), and `InputInterface.span?`, the authored statement's file-absolute span. `mappedExpr` uses `unrewrittenCode` to map the unchanged runs of a rewritten expression one to one, so a host's typecheck projection keeps positions inside rewritten values.


- **Added (jsx-method-shorthand, decision 167):** `mappedMethod(expr)`, which returns an attribute method shorthand's printed `function` expression with its head unmapped and its body mapped token by token against `Expr.bodySpan`/`bodySource` (`undefined` for any other expression). The split uses the printed function's own parsed body position, so a body holding `) {` is safe. `@mxlang/preact` (so React and Hono) uses it.

- **Fixed:** a target installed or built after a `not-found` now loads on the next `loadTargetDescriptor` in the same process (language server, tsserver, `mx-tsc -w`, dev server), in Bun and Node, and it is the file a fresh process would load. Both runtimes keep resolution state for the life of a process: Bun keeps a miss once the project has a `node_modules`, and Node keeps a missing `package.json`, so after an install it resolved the package's `index.js` and ignored its `main`. The runtime's own `require.resolve` still resolves every specifier; once one has missed in this process, it is resolved again by the same runtime (`process.execPath`, with its `--conditions` and other resolution flags) in a fresh child process (`resolve-after-miss.ts`). The child runs once per change to a stamp (inode, mtime, size) of each `node_modules`, scope and package directory from `fromDir` up, the package's `package.json` and the entry files it names (`main`, `exports` targets) with their directories, and each directory's `package.json`, `tsconfig.json`, `jsconfig.json` and `.pnp.cjs`; while the stamp is unchanged, a not-found answer is re-asked on a backoff (5 s after it, doubling to 60 s), for changes the stamp cannot see. `node:child_process` is loaded on that path only. New `not-found` diagnostics name why the child gave no answer: no `node:child_process`, a 15-second timeout, a failed start, a crash, no answer, or an answer that is not an existing absolute file. The "restart after installing" note is gone.

- **Fixed:** a built-in module specifier with a slash (`mx.target "fs/promises"`) no longer hangs the loader when no `package.json` is above the working directory; it is `invalid-descriptor`.

- **Behaviour change:** a package the runtime rejects as invalid (`ERR_INVALID_PACKAGE_TARGET`, `ERR_INVALID_PACKAGE_CONFIG`: an invalid `exports` target or config, or on Node a `package.json` that is not a JSON object) is `load-failed`, where it was `not-found`. Every other resolution error is still `not-found`.

- **Fix (jsx-handler-prop-names):** the `onDoubleClick` warning suggests `onDblClick`, a host-independent spelling that lowercases to `dblclick` (it named `onDblclick`, a spelling Preact and hono no longer emit).

- **Behaviour change (decision 169, withdrawn in 0.1.0-alpha.9):** in this release a modifier on a bound attribute (`<Foo v:fn:=q/>`, `<div is:raw:=x/>`) was a positioned error. alpha.9 replaces the error with the refinement.
- **Fixed:** a tag-adjacent class or id Marko builds rather than reads as one token (`<div.a.${x}/>`, `<div.${x}.${y}/>`, `<div.a${x}/>`, `<div.${x}a/>`, `<div#a${x}/>`) lowered with `nameSpan` `{NaN, NaN}`. The span now runs from the first sigil to the end of the last token of that kind (`.a.${x}`).
- **Changed (types only):** `Expr.node` is `Node | null`, as the IR spec says; the three `null as unknown as Node` casts are gone.

- **Added (mx-tsc-astro-ambient-types):** `TargetHost.ambientTypes?({ rootNames, resolve })` and its `AmbientTypesProgram` type, an optional, additive descriptor field: a host's ambient declaration files, the ones its framework's tooling adds to every program it checks, answered per program (`[]` for a program holding none of the host's files). `resolve("<package>/<file>")` looks in the project, then in the tool's install. `validateDescriptor` checks it is a function.

- **Added (solid-method-shorthand, decision 167):** `Expr.bodySpan?` and `Expr.bodySource?`, additive optional IR fields. `exprOf` (`lower.ts`, `methodBodySpan`) sets them only for an attribute method shorthand (`onClick() { … }`, `async onClick<T>(…) { … }`), whose `code` is the `function` expression the compiler printed. `bodySpan` is the file-absolute span of the authored `{ … }` body, taken from the method node's own body position (Marko gives the text between the braces; it is widened onto them). `bodySource` is that span's authored text. Both are absent for every other expression, an authored `function` expression included. A host that emits the printed function maps its body against them; Solid does. `mappedRewrite(after, before, span)` is exported for that: it maps reprinted text token by token against the authored text.

- **Fixed (decision 164):** a lowercase tag is a native element whatever `import` or `<define>` binding of that name is in scope, on every target (an imported `input` no longer turned `<input>` into a component call). Core skips the host `isComponent` for a lowercase name bound only by an import or define; a PascalCase binding, a dynamic tag, a registered custom tag (including a taglib tag) and a contract child are unchanged. Addendum 1: the diagnostic fires only for a binding that can be a tag (a `<define>`, or a default import of a `.mx`/`.marko` module). A native-element name warns at the tag, with the binding's L:C on every target; a name that is no element is one positioned error on every target ("`<row>` is not a tag here…"), raised before any host's unknown-tag path (the JSX hosts used to render a literal `<row>`, html reported "Unable to find entry point"). A `<define>` no longer warns outside its scope; the gate is Marko's `!/^[A-Z]/`, and a `_x`/`$x` name is offered only the dynamic tag. A registered taglib tag is called through its own template on every target, whatever is imported, and its return shape, `Input`, attribute tags and `/var` rule are read from that template, never from the same-named import. Without a taglib lookup, "native" covers Marko's full `marko-svg`/`marko-math` lists. Adds `Ctx.bindingSites`.

## 0.1.0-alpha.7

- **Fixed (decision 165):** the bundled template parser no longer throws on a closing tag after a concise tag that never got its name (`,--/</e>`); it reports `EXTRA_CLOSING_TAG` through its error callback. Inherited from htmljs-parser 5.18.0.
- **Fixed (decision 156 addendum 11):** Unicode whitespace and line terminators behave as ASCII whitespace in every look-behind of the template parser, not only the atom one. `(é)<NBSP>/ 2` divides; before, `/` was read as a regex start.
- **Fixed (decision 156 addendum 8):** a comment before `of`, `yield` or `await` is skipped as whitespace is, so `f(/*c*/ await :b)` lexes no atom, as `f( await :b)` does not.
- **Behaviour change (addendum 11):** in a body, text after a non-breaking space and `//` is a line comment, as after an ASCII space (`<div>a<NBSP>// c</div>` no longer renders `// c`).
- **Behaviour change (addendum 12):** in concise mode, `--` after Unicode whitespace starts the text block instead of being read as an attribute; the attribute's range keeps the trailing whitespace.

## 0.1.0-alpha.6

- **Fixed (template-parser-ascii-only-lookbehinds):** every look-behind in the bundled template parser treats a non-ASCII letter (U+0080 and above, except Unicode whitespace and line terminators) as a word character. `x=é / 2` and `${é / 2}` read `/` as division instead of a regex start, and `<div x=énew y=1/>` no longer swallows the next attribute (`énew` was read as ending in the keyword `new`). Valid TypeScript with non-English identifiers failed to parse before.
- **Fixed (decision 156 addendum 10):** Unicode whitespace and line terminators behave as ASCII whitespace in the atom look-behind. `({ a<NBSP>:b })` no longer lexes a silent atom. Two shapes that compiled stop compiling, as they already did with an ASCII space (addendum 4): `(a?<NBSP>:b : c)` and `(Array<T><NBSP>:b)`; write `: b`.
- **Fixed (template-parser-comment-in-text-tag-open-crash):** a `//` or `/* */` comment inside the open tag of a text tag (`script`, `style`, ...) that contains the tag's closing sequence no longer ends the tag or throws; the parser reports through `onError` and never throws there.
- **Fixed:** the reserved-name error for `::name` covers only the name (`<a::b${x}/>` reported `::b$`), and `[...await :b]` lexes the atom (the spread's third dot was counted as a member dot).

## 0.1.0-alpha.5

- **Fixed (atom-lookbehind-non-ascii, decision 156 addendum 9):** a non-ASCII letter before a `:` is a word character for the atom look-behind, so `x=({ é:a })`, `x=(é :b)` and `x=(éin :b)` lex no atom (TypeScript owns that colon). alpha.4 lexed an atom there, silently changing the meaning of valid TypeScript with non-English identifiers. Unicode whitespace and line terminators are not word characters.
- **Added:** `cloneIr(ir)`, a deep copy of an `Ir` for an emitter that needs to adjust nodes for its own output; emitters must not mutate the IR they are given (IR spec 10.2, pinned by each host's `ir-readonly.test.ts`).
- **Added (jsx-define-call-drops-attrs, decision 160):** lowering warns, positioned at the call's tag name, when a `<define>` with 2 or more params is called without tag arguments but with attributes, attribute tags or a body: only the first param receives the attributes object (Marko 6.3.51), so `<Card title="a"/>` against `|title, head|` no longer binds `title` to `"a"` on the JSX hosts.
- **Added (jsx-define-call-drops-attrs, decision 160):** `HostDeclarations.defineCallPassesAttrs?: true`, an optional, additive capability marker (the `acceptsForeignAttrNames` precedent). Decision 160 is a language rule for every target; the flag only marks the hosts that implement it (html, preact, react, hono, regions included) and is removed when every host implements decision 160 (`define-call-attrs-solid`, `define-call-attrs-angular`). The warning above is gated on it, so Solid and Angular, which still bind per param, get none.
- **Changed (third-party-data-host, decision 148):** a loaded third-party descriptor may declare `host.fileKinds`. The registration verdict no longer refuses them ("file kinds are supported for built-in targets only (for now)" is gone); `createTargetLookup`'s set rules apply as for built-ins: a bad segment or missing `diagnosticSource` is a positioned `target-invalid-descriptor`, and a segment another host owns is refused naming both hosts. Joining a built-in host stays refused.
- **Added:** `HostDeclarations.builtinTags?`: the tag names a target provides without a taglib entry. A registry check of `defaultTag`/`host.defaultTag` counts them as reachable, so a descriptor reusing a target's declarations keeps its built-in. Additive, `@unstable`.

## 0.1.0-alpha.4

- Added `children["*"]` wildcard children (decision 147): a parent's `children` accepts an entry or ordered list of `{ pattern?, contract }` / inline-contract entries that claim child names nothing else resolves, validate them by another tag's contract (E1, E4, E2, `defaultTag`), and record the authored name as the additive `alias` (`TagAlias`) on the IR node. Exports `TagAlias`, `CustomTagChildren`, `WildcardChildEntry`, `WildcardChildren`, `isWildcardEligible`, `matchWildcardChild`, `scopeForChildren`, `WILDCARD_NEAR_EXPLICIT`. A name the target's own taglib holds as a built-in is never claimed; core keeps no list of them.
- Added registration errors for malformed `"*"` entries (unknown key, bad or non-compiling `pattern`, unreachable or raw-text `contract`, `contract` plus inline contract, an inline contract that contains itself) and for a self-containing attribute-tag declaration, which previously never terminated.
- Added the did-you-mean guard (decision 147): a wildcard child one typo from an explicit sibling is a compile error on every target and in every tool, not a warning.
- Built-ins are never wildcard-matched on any target: entries of core's own taglib (`let`, `effect`, `script`, `style`, ...), names a host declares a disposition for, and non-elements of the target's lookup. Added `CORE_TAG_NAMES`. A pattern must be a whole regex on its own (`a)|(?:b` is refused). An inline `children["*"]` contract matched on a target that needs a transform gets a targeted error. Wildcard messages say "a built-in tag" or "a registered tag" and no longer "declared". The wildcard helpers exported for data's scan are `@unstable`.
- **Added: atoms (decision 156, PR #342).** `:name` in an expression position is a value that represents itself: `mode=:strict`, `accept=[:title, :body]`, `${:a}`, `x === :a`, in method-shorthand bodies too. MX's template parser lexes it and hands Babel a same-length numeric stand-in; core converts every stand-in to a `StringLiteral` with `extra.mxAtom = { span }` (public, nested cases included) and asserts none survives. Every target emits the name as a string literal. A whole-value atom is a `static` attribute with an `atom` field; nested atoms are listed on `Expr`. Misuse (member access, calls, unary operators, spreading, a non-computed object key, binding or assignment) is a positioned MX error; `::name` is reserved. The typecheck code splices `"name"` at each atom with per-atom mappings (`mappedExpr`, exported). Published core parses atoms through its bundled parse layer (decision 159). Known limits (decision 156 addendum 4): a spaced `c ? a < b > :z`, a conditional type inside cast type arguments, and a `<` inside a string or comment within type arguments lex `:z` as an atom; write `: z`, and the error says so.
- **Added: a sugar after a single-atom default value (decision 146 addendum 5, PR #346).** `belongs-to=:Customer :customer` is default value `:Customer` plus `name` `:customer`; every other default value keeps decision 151 ruling 2.
- **Added: a sugar followed by `=value` or `(params) { body }` sets the default attribute (decision 146 addendum 4).** `#name=expr`, `:name=expr`, `.class=expr` and `kind #name(params) { body }`; an error only when the tag already has a default value.
- **Fixed:** a tag's shorthand attributes carry a real `nameSpan`.
- Atom contracts (decision 156 PR 2): `CustomTagAttribute` takes `type: "atom"` with `values`, `pattern` and `ref`; `CustomTag.declares` (`ContractDeclaration`, exported) states what a tag declares; `AnalyzeContext.declare(kind, name, { span, scope? })` adds derived declarations. Checking runs in two phases per unit (declare, then check): unknown names are positioned errors with a did-you-mean, duplicates are errors carrying both spans (new optional `TranslateError.spans`), an atom against a non-atom type (and the reverse) is a type error. The `:name` sugar keeps its atom-ness but, for contract checks (decision 156 addendum 6), its `name` satisfies `string` and `enum` as its string and `atom` as the atom; an explicit `x=:a` against `string` and `name="title"` against an atom-typed `name` are errors. Emitter output is unchanged.
- Atom contracts, fix round (decision 156 addendum 7): the default scope of a declaration is the file, searched last by every reference (top-level siblings share names; a `ctx.declare` outside every call is visible); `values`, `pattern` and `ref` are checked on attribute-tag attributes at any depth; an atom type error is positioned at the value (the string, the expression, the atom).
- Atom candidates (decision 156 PR 2 part B): new `atomCandidates(atomFacts, offset)` returns what an atom can be at a position: a contract's `values`, or the visible `ref` names (innermost scope first, the file last, each once with its kind as `kind`); `values` and `ref` together intersect and `pattern` filters, so it never offers a name the checker would reject, and the `ref` diagnostic lists the same filtered names. It never throws. Its input is the new opaque `AtomFacts` (names, kinds, spans and scope data only: no syntax node, contract definition or hook, so a kept `CompileResult` does not keep its AST), on `CompileResult.atomFacts` and on `TranslateError.atomFacts`; the error carries it only when the file-level atom check ran (every call was seen, the facts are complete); an error thrown earlier (type error, missing attribute, `analyze` failure) leaves it unset, so keep the last good result's facts. Exported types: `AtomCandidate`, `AtomFacts`. The unknown-atom diagnostic lists the candidates (sorted, at most ten, then `+N more`; `(none declared)` for an empty `ref`); a type error against `values` ends with the values. A plain string against a `ref` atom is now reported by the file-level check, so it lists the declared names and ends with ``write it as `:<name>` ``.

## 0.1.0-alpha.3

- **Changed (decision 159): core ships its own Marko parse layer.** The build bundles `@marko/compiler` (with its Babel) into `dist/marko-frontend.cjs`, with the `htmljs-parser` specifier resolved to MX's own template parser (`@mxlang/parser`'s `src/template/`, htmljs-parser 5.18.0 plus the decision 146 rule). A registry install of core therefore parses `.mx` with MX's rules: after-value sugar (`<input type="email" :email>`, `x=a.b .c`) works for consumers. `@marko/compiler` and `htmljs-parser` are no longer dependencies (devDependencies only, for this repo's source runs); the bundle requires only Node built-ins. Licence texts of the bundled code: `dist/marko-frontend.NOTICES.md`. Tarball 173,218 to 610,153 bytes (unpacked 613,385 to 3,047,048); a consumer no longer installs `@marko/compiler` and its dependency tree. Babel's `browserslist` lookup is stubbed to "no config file" (MX passes no targets); `@babel/preset-typescript` (only for a `.cts` Babel config file) is not bundled.
- **Added:** `markoCompiler()`, `markoBabel()` (now exported from the index, previously internal) and `markoHtmljsParser()`, with types `MarkoCompiler`, `MarkoBabel`, `HtmljsParser`: the one compiler instance core compiles with. Every MX package that needs Marko's compiler or its Babel goes through them, so one compiler loads per process. From source they resolve the workspace's `@marko/compiler` as before. Additive, `@unstable`.
- The decision 151 stock-parser diagnostic stays; it now fires only for a caller that bypasses core's bundle (for example a tool that hands core a stock compiler).

## 0.1.0-alpha.2

2026-10-05. Identical to alpha.1; republished because the alpha.1 tarballs lacked `dist/` when installed by Bun. No code change.

## 0.1.0-alpha.1

First npm prerelease (dist-tag `alpha`), with everything listed under 0.1.0 below. `@mxlang/core` is no longer `private`; `exports["."]` now carries a `types` condition so a `moduleResolution: bundler` consumer finds `dist/index.d.ts`. No code change. Unstable API.

## 0.1.0 (unreleased)

- **Added (react-region):** `Component.varBindings?` and `TagCall.varBindings?`: each identifier a `/var` pattern declares, with its authored span (empty without `/var`), filled by `lower.ts` and carried by `template-tag.ts`, so an emitter that lifts bindings into one scope can refuse a duplicate at the authored name. Additive, optional, `@unstable`; documented in `ir-spec.md` §5.6. A `/var` pattern the parser cannot read (`{ a, b: a }`) now fails in lowering at the parser's position.

- **Fix (statement-tag-name-sugar):** a `:name` sugar on a statement tag (`<import:x/>`, `<export:x/>`, `<static:x/>`) is a positioned error naming the statement tag ("a `:name` is not supported on the statement tag `import`: its text is code, not attributes — write `import …` at the root of the template instead"), reported on the colon. The rewrite used to make `<import name="x"/>`, which lowers to a statement node wherever the tag sits; inside a body that is an IR shape no target can describe, so every host reported it as an internal error rather than source feedback (`@mxlang/data: unexpected IR node kind \`Import\` in a body`, `@mxlang/core: unexpected module-level node kind "Import" in the body walk`). A tag the parse calls a statement is still otherwise left alone (its text is code, not attributes), and an attribute tag's namespaced name (`<@svg:rect>`) is untouched.

- **Added (bridge-host, decision 154):** `HostFileKind.completeTypecheckModule?(code)`, an optional hook a region file kind uses to rewrite its printed module for type-checking only (what the host's own compiler stage adds that the type-check cannot see), validated by `createTargetLookup`; and `HostRegionInput.warnings`, the warning sink tools already passed to a region compile, now declared. Additive, `@unstable`.

- **Fix (shorthand-attr-name-span):** a tag's own shorthand attributes (`<a#x.y/>`, `a#x.y`) now carry a real `nameSpan` over the sigil and the token (`#x`, `.y.z`), like the spaced name-sugar form (` .y`); they used to carry `NaN` offsets. A **dynamic** tag-adjacent shorthand (`<a.${x}/>`, `<a#${y}>`) carries the same span — the sigil and the whole `${…}` — where it used to cover the expression alone (`x`). Editor mappings and diagnostics now reach shorthand attributes. A shorthand `class` merged with an authored `class` still has no span.
- **Fix (name-sugar-default-value r2):** a bound `value:=y` counts as the tag's default value, so `value:=y #x=1` and `#x=1 value:=y` are the positioned double-default error; an Angular attribute-position `#ref=x` (a host-claimed `#`) no longer turns on the authored-default counting; the default attribute a sugar produced carries `sugarValueOf` on the IR (`Attr`, additive) and a contract error says `` `value` (set by `#x=…`) ``; the double-default message gives the first default as `line:column`.

- **Feat (name-sugar-default-value, decision 146 addendum 4):** a sugar followed directly by `=value` or `(params) { body }` sets the tag's default attribute (`value`): `<a #x=1>` is `id="x"` plus `value=1`; `kind #name(p) { b }`, `kind #name (p) { b }` and `kind (p) { b } #name` are one tag, id plus `value=function`; `:name` and `.class` the same. It replaces PR 2's "sugar takes no value" errors (`#x=1`, `:x=1`, the sugar-plus-method case); the bare `:`/`#`/`.` errors stay and `#x(p)` with arguments and no body is an `arguments are not allowed` error. A tag that already has a default value (an authored `kind=1`/`value=1`/`kind (p) {}` or another sugar's value) is a positioned error at the second; the default-attribute exemption (decision 151 ruling 2) is unchanged. Marko already parses every form, so there is no htmljs-parser change: core moves the value to a default attribute positioned at the value (or the `(`).

- **Fix (imported-tag-var-binding):** `/var` on a call to an imported `.mx` tag is now accepted when the callee declares `<return>` (Marko 6.3.51 binds it), and lowers like a discovered tag's: the `Component` node carries `var` and `returnsValue`, the binding is pre-registered for the read-before-call and out-of-scope checks, and every host's existing `/var` emission applies. New `calleeReturnShape(target, ctx)` (`returns` / `none` / `unknown`; `calleeReturnsValue` is now `=== "returns"`). `/var` on a `.mx` callee with no `<return>` is the discovered tag's positioned error (`` `<X>` does not return a value ``; Marko binds `undefined` silently, MX keeps its documented refusal); a callee MX cannot read (`.ts`, barrel, dynamic, unresolved, mid-compile) keeps the generic ``tag variable `/n` … is not supported`` rejection. `.astro.mx` still cannot bind a `/var` (Astro's fence runs first).

- **Fix (name-sugar-tooling r3):** the name-sugar rewrite no longer skips six hard-coded statement names: a tag is skipped only when it is a statement in that parse (the Marko lookup's `parseOptions.statement` when there is one, else the core taglib's own `statement` entries), so a data vocabulary's `<class :User/>` is `name="User"` again and a custom tag with `parseOptions.statement` is left alone. A non-string authored literal beside `.x` folds like Marko's class value (`false`, `0`, `null`, `undefined` drop; other numbers and `true` stringify). The `htmljs-parser` patch notes list two valid TS spellings it changes (`(a) :T` and `(a) :` before a newline). Docs state the class-order rule.

- **Fix (name-sugar-tooling r2, review of PR 3):** an authored literal `class` beside a `.x` sugar stays a literal (so `enum`/`literalOnly`/type contracts judge the real value) and a merged class carries a sugar label and reports at the first sugar token (also onto a tag-adjacent class); the duplicate-attribute warning names the sugar for the dropped and the winning attribute (shared `attrLabel`); the dynamic-shorthand message splits only outside `${…}` and quotes the authored token. **A bare `:` in attribute position is a positioned error** ("`:` is name sugar and needs a name"), where Marko read it as `value:` (write `value:`); the `htmljs-parser` patch now also ends an attribute value at a bare `:` before `/>`, `>`, a newline or the end of the source.

- **Feat (name-sugar-tooling, decision 146 PR 3):** an E1 error on an attribute the name sugar made names the token the author wrote with what it stands for: ``attribute `:email` (`name`) must be number, got string``, ``unknown attribute `#main` (`id`)``. The IR `Attr` (every kind but `spread`) gains an optional `sugar` (the authored token; an additive field, absent on an attribute written out). Positions are unchanged. No other behaviour change.

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, now lowers with `returnsValue` on its `Component` node, like a discovered template call, so the emitters unwrap `{ value, output }` instead of concatenating the pair (`[object Object]` on `@mxlang/html`, a dropped object on the JSX hosts). New `calleeReturnsValue(target, ctx)` in `callee-input.ts` reads the callee's cached template metadata through the same resolution `readCalleeInput` uses; it is false for a `.ts` module, a barrel re-export, an unresolved specifier, a host module file and a unit still mid-compile. `/var` on an imported call is still rejected. A dynamic tag or `.ts` barrel route to such a unit is a documented gap (`divergences.md`).

- **Fix (name-sugar-core r2, review of decision 146):** `sugarTagName(raw)` is exported (the pure tag-name split) and the data target's parse-only unknown-tag scan uses it, so `resource:post` is the known tag `resource` and `<:title>` gets the default tag instead of a false "unknown tag". Sugar right after a default value (`<if=x :b>`, `<let/x=1 :b/>`) is one MX error on every parser ("not supported (decision 151, ruling 2); put it before the value or on the tag"), found from a recovered `MarkoParseError` too (`.solid.mx` regions), and the stock-parser advice no longer fires for it. A rewritten shorthand's value span stops before the colon; a class merged from non-contiguous tokens keeps its first token's span. Sugar is appended to the shorthand part of the class (`<div.c class="x" .d>` is `<div.c.d class="x">`). `#x` and `.x` in attribute position take exactly Marko's shorthand charset (probed against its parser; chains split like tag-adjacent ones). A `:` before a `${…}` in a shorthand is a positioned error. `:b:c` and `:b(x)` get sugar messages. **Angular gets the sugar** (decision 146, addendum 3): the skip on `acceptsForeignAttrNames` is gone; a new `HostDeclarations.claimsAttributeHash` (Angular sets it) leaves attribute-position `#x` to the host; `<svg:rect>` is tag `svg` plus a name on every target. Attribute tags keep `<@svg:rect>` whole; attribute-position sugar on them applies. A failed parser probe is memoised.

- **Feat (name-sugar-core, decisions 146 and 151):** `:name`, `#id` and `.class` sugar. `:val` sets `name="val"` as `#val` sets `id` and `.val` sets `class`, tag-adjacent (`<input:email>`, `<a.c:b#d>`, `<:email>` = the unnamed tag, decision 145, with `name="email"`), first in the attribute list and after any attribute (`<input type="email" :email>`). New `name-sugar.ts` rewrites the parsed tree once per tag, in the `resolveUnnamedTags` walk, before a tag name is read: a static tag name splits at its first `:`, the static part of the shorthand `class`/`id` values splits the same way (a dynamic shorthand only its static tail), and attributes named `#x`, `.x`, `:x` (and `.c:y`, `#d:y`) become `id`, class and `name` before the shorthand merge, so `<div.a #m .b>` is `<div.a.b#m>`. A sugar attribute reports its whole token as `nameSpan` and the identifier as `valueSpan`. Errors, all positioned: a second `:` in the tag head, a value on the sugar (`:x=1`), a token that is not an identifier. Untouched: the named forms (`class:x`, `style:x`, `value:x`, `value:fn:=x`), a bare `:`, dynamic tag names, attribute tags (`<@svg:rect>`), bound attributes, and every tag on a host with `acceptsForeignAttrNames` (core names no host). **Breaking, four `divergences.md` rows:** a tag name cannot contain `:`; bare `:x` is `name`, not Marko's `value:x` (write `value:x`); the parser after-value rule; a shorthand class/id cannot contain `:` (write `class="hover:x"`).

- **Feat (name-sugar-core, decision 151 ruling 1):** a consumer on a stock `htmljs-parser` gets a positioned error for `:name` after an attribute value instead of Marko's "exactly one expression" failure. `stock-parser.ts` probes the parser `@marko/compiler` resolves, once per process; `compileSource` and `parseFragment` throw a `TranslateError` that names the rule, says these positions need the patched parser and points at `<input:email type="email">`. `x=a.b .c` stays silently member access on a stock parser (not detectable). The `htmljs-parser` patch (`patches/htmljs-parser@5.15.0.patch`, repo-only) now exempts the default attribute (`<if=a .b>`, `<const/x=…\n  .filter()/>` keep Marko's meaning).

- **Fix (name-sugar-core, Mesh):** a valueless colon-named attribute (`x:foo`, `x:`, `value:foo`) lowers to a static attribute with a zero-width `valueSpan` at the end of its name. It had none, so `parseData('entity value:Todo …', …, { structural: "reject" })` threw "core IR invariant broken — static attribute … carries no span". (The Mesh spelling `entity :Todo` is `name="Todo"` since the sugar.)

- **Fix (default-tag-contracts r3):** `TargetHost.allowContractDefaultTag` (added earlier in this series, unreleased) is removed: the permit flag has one source, the target's declarations (`HostDeclarations.allowContractDefaultTag`), read by registration and by every compile. New: `CORE_TAGLIB` (Marko's core tags, moved here from `@mxlang/html`'s `taglib/marko.json`: one copy) and `judgingLookup`, which keeps it behind every lookup a default tag is judged in, so `else-if`, `html-script`, `html-style`, `html-comment` are never native custom elements on a host whose translator has no core taglib. An unnamed tag whose parent contract's `defaultTag` was invalid and fell through carries the hint "(the parent's `defaultTag` `x` is invalid; see the declaration)" in a use-site E2.

- **Feat (default-tag-contracts r2):** a dashed custom-element name (`sl-card`) is a valid `defaultTag` (`DefaultTagScope.isNativeElement`, `isCustomElementName`) exactly where the host compiles an unknown dashed name as a native element: the host's own `isElement` answers, no host name in core. Marko core tags and non-dashed unknown names stay rejected.

- **Fix (default-tag-contracts r2):** the contract-parent lookup sees through `if`/`else-if`/`else`/`for` (`CONTROL_FLOW_TAGS`, shared with the lowerer) and core-owned `try` before consulting a lookup's tag def, so it works on every target; `contractDefaultTag(parents, context, builtins)` takes the resolver's `DefaultTagContext` and returns `undefined` for a value `validateDefaultTag` rejects (an invalid contract value falls through to the next rung) or when the host forbids the rung (`HostDeclarations.allowContractDefaultTag: false` -> `context.contractRung: false`). `DefaultTagContext` gains `contractRung` and `scope`; a compile with no Marko lookup judges default tags in Marko's own element taglibs. `ownDefaultTag` also runs the contracts' registration check for entries that scan for themselves (`tags`, `hostName`).

- **Feat (default-tag-contracts, decision 145):** `defaultTag` is a declaration key beside `children` in sidecars and `mx.contracts`, top level and on attribute-tag declarations at any depth; a value that is not a non-empty string is a registration error naming the owner chain. New exports: `contractDefaultTag(parents, customTags)` (the nearest authored parent's declaration, structural parents skipped by Marko's tag def, an attribute-tag parent reads its declaration in the owner's `attributeTags`) and `contractDefaultTagDiagnostics`. `CustomTag.defaultTag`, `CustomTagAttributeTag.defaultTag`, `DefaultTagParent.tagDef`.

- **Fix (default-tag-ladder r3):** an element is a valid `defaultTag` only when the host's `isElement` says so and Marko's tag def carries its `html` flag (a taglib property), so a casing-only host (Solid) and a target with no declarations no longer accept `await`, `try`, `define` or `effect`. A failed scan makes the custom tags unknown (`customTagsUnknown`, `defaultTagScopeFor({ customTags: () => … })`): the parse-shape check still runs and a verdict that needs the custom tags is skipped; any other failure building the scope throws.

- **Fix (default-tag-ladder r2):** `checkConfiguredDefaultTag`, `ownDefaultTag`, `defaultTagDiagnostic` and `defaultTagScopeFor` are the one read-then-validate path every compile entry shares; a scope that throws (a malformed `mx.contracts`) skips the reachability check instead of escaping from a policy call. `validateDefaultTag` takes `isElement`, so core and translator tags (`await`, `try`, `define`, `effect`) are no valid built-in, and a target with no elements (data) answers parse shape only. A shorthand attribute's contract error (E1) is positioned at its tag, not 0:0. The descriptor error names what `defaultTag` is for.

- **Feat (default-tag-ladder, decision 145):** every target descriptor declares a required `defaultTag` (`validateDescriptor`, `createTargetLookup` and the third-party loader refuse a descriptor without a non-empty string, positioned at the `mx.target`/`mx.host` value); `TargetHost` gains an optional `defaultTag` override and an optional `allowContractDefaultTag` (default true), and descriptors an optional `parseTranslator`. The target policy reads `mx.<target>.defaultTag` (`TargetPolicy.defaultTag`, `defaultTagAt`, `descriptorAt`, `PolicyLocation`); any non-string or empty value is one `invalid-default-tag` diagnostic positioned at the value, and `readTargetDefaultTag` reads another target's key. `resolveDefaultTag` receives a third argument, `DefaultTagContext` (`configured`, `customTags`); the configured name travels as `HostOptions.defaultTag`, `Ctx.defaultTag`, `TargetCompileOptions.defaultTag` and `HostRegionInput.defaultTag`. New: `validateDefaultTag` (is a name a reachable, plain-parsing tag, read from the lookup's own `parseOptions`) and `buildMarkoLookup`; `resolveTargetPolicyDetailed` takes `{ quiet }`. Core names no tag.

- **Feat (default-tag-core, decision 145):** the unnamed tag (`<#id>`, `<.class>`, concise `#id`/`.class`) is no longer silently `div`. Core recognises it by its empty name span and calls the new optional `HostDeclarations.resolveDefaultTag(node, parents)` once per unnamed tag; the answer lowers like an authored tag of that name. New export: `DefaultTagParent`. Without the hook the shorthand is a positioned `TranslateError`. No behaviour change for any host that answers `div`.

- **Fix (astro-fence-top-level-return):** `checkReservedSource` takes an optional fourth argument carrying `allowReturnOutsideFunction`, for authored source a host compiles inside a function body (Astro's `---` frontmatter), where a top-level `return` is legal. The default is off, so Marko statement tags and every other caller keep rejecting a stray `return` in real module scope. Core stays host-agnostic (decision 126): the host states the fact about its own grammar, and the reservation check itself is unchanged — `__mx*` bindings are still rejected inside such a fence. New export: `CheckReservedSourceOptions`.

- **Fix (reserve-mx-identifiers):** reject authored `__mx*` bindings, including destructuring, tag parameters and parsed statements, at the authored identifier. Host code regions share the check and actionable diagnostic; property keys and references remain legal. New exports: `checkReservedBindings`, `checkReservedSource` and `reservedBindingMessage`. Statement tags are reparsed with Marko 6.3.51's own plugin list (decorators included), so a decorated `static @d() class C {}` is checked rather than skipped; a tag that still fails to parse is skipped, never rejected. Type-only names — type parameters and `declare function` parameters — stay legal, since no emitted binding can collide with them. This is intentionally stricter than Marko 6.3.51.

- **Fix (translate-error-callee-file):** callee-template parse failures now carry the template's path and coordinates on the existing `TranslateError` fields, including through nested template calls. Marko aggregates retain all frames at their first parser error's position, without repeated path headers or compiler stacks. Scan errors carry sidecar/manifest paths structurally, without repeating them in the message. No new fields or exports.
- **Fix (attr-value-parity review):** classify builtin value syntax independently of host rendering disposition, including HTML's delegated `<let>`. Native guards reject functions/symbols with Marko debug text; spread guards reference the once-per-module value helper. Remove the unused public guard-body export.

- **Fix (attr-value-parity):** validate builtin duplicate values before a host drops or claims the tag. `<let>`/`<return>` use Marko 6.3.51's duplicate-value text at the second value; `<const>`/`<id>` retain their linked tag-specific diagnostic at the tag name. Delegated vocabulary retains ordinary attribute normalization. Export host-neutral, inlinable native-attribute coercion helpers; class/style and controlled writers are exempt.

- **Fix (colon-attr-followups round 2):** every non-reserved colon name (`x:foo`, `data:x`, `attr:x`, etc.) is ordinary and retains its complete spelling; only native `class:`/`style:`/`on:` prefixes reach modifier hooks. Ordinary native colon-name methods and function values now report Marko's exact function diagnostic before argument diagnostics, at the authored attribute name. Component callable props and event attributes retain their existing policies.

- **Fix (colon-attr-followups):** reject non-reference bound attributes at Marko's value position on dynamic tags, ordinary components and built-in controls, including controls containing attribute tags, before any attribute can be silently discarded. Registered custom-tag and attribute-tag contracts keep decision 138's bound-literal checks. Preserve empty modifiers on ordinary names (`x:`), including static, dynamic and valueless attributes; reserved `class:`, `style:` and `on:` still reject and event suffixes are not dropped.

- **Fix (marko-parity-trio review):** preserve the empty `:` shorthand as `value:` and explicit last-colon names such as `value:foo:bar`; attribute-name spans measure the spelling actually authored. Arguments on these ordinary attributes report Marko's full-name error (``Unsupported arguments on the `value:foo` attribute.``) at the attribute. A non-reference native-element `:=` target, including `<div :="x"/>`, now reports `Attributes may only be bound to identifiers or member expressions` at the value instead of silently emitting only the initial value. Identifier and non-private member targets (including optional members) keep their existing host-defined binding behavior; custom-tag and attribute-tag contracts keep their E1 bound-value checks (including literal arrays).

- **Fix (proto-names): a tag named after an `Object.prototype` member (`<toString/>`, `<constructor/>`, `<__proto__/>`, …) no longer crashes the compile.** Marko 6.3.51 throws a raw `TypeError: undefined is not an object (evaluating 'filePath.length')` for it, because its taglib lookup indexes a plain object. `compileSource` and `parseFragment` now strip the prototype from the lookup's tag map, so the name is an ordinary tag name on every target (recorded in `divergences.md`); `lower.ts` guards two more plain-object lookups (`declarations.tags`, the non-DOM event spellings) with own-property checks. A declared `customTags` entry of that name is a contract.

### Fixed: a comment before an attribute tag is a child comment (body-beside)

Marko's parser moves a comment written right before an `@tag` into the parent's `attributeTags`. `lowerAttributeTags` lowered it as an attribute tag with an empty name and a NaN `nameSpan`, which every target then emitted: the HTML target passed a `"": () => ...` prop, the Preact/React/Hono/Solid targets emitted `<Card ={undefined} ...>` (invalid JSX), and the Angular and Astro targets threw `<@/> has no body`. The comment now lowers as an ordinary child `Comment` in the parent's content, in source order, so no empty-name attribute tag exists and each target treats it as it treats any other child comment. This holds after an attribute-tag `<if>` chain too (a comment skipped by the chain scan is no longer lost). Emitted output changes only for a template with a comment directly before an attribute tag, from broken to correct (Marko strips such a comment; `oracle:marko` fixture `comment-before-attribute-tag`).

### Fixed: an empty `{}` declaration is a contract (empty-declaration)

`customTags: { pub: {} }` was treated as contract-less ("custom tag has neither a `transform` nor a template file ...") while `pub: { attributes: {} }` passed. `isContractOnlyDelegated` no longer looks for a declaration key: a definition with no `transform` and no template is contract-only whatever it declares, `{}` and a hooks-only definition included (an empty declaration is a tag with no attributes and no body rules). It still needs a target that delegates the name; on a target that does not, the "neither a `transform` nor a template" error is unchanged. Covers `customTags`, `mx.contracts` entries and sidecars through the one predicate.

### Fixed: every printed position is 1-based (zero-based-cols-in-message-text)

Ruling #227: a position MX **prints** — in a message's text as much as in a `file(line,column)` header — is 1-based line and column, the basis `mx-tsc` and every editor use. This completes the pass that started with the duplicate-attribute warning and the Angular build prefixes; the structured `line`/`column` on `MxWarning`, `ScanDiagnostic`, `TargetPolicyDiagnostic` and `TranslateError` are unchanged and stay 0-based (Babel's base), because every consumer subtracts one on the way to an LSP range.

- `warn()`'s `console.warn` fallback printed `file:line:column` with the raw 0-based column (`test.mx:5:20`), one left of the position a build reports and an editor underlines. Now `test.mx:5:21`; the recorded `MxWarning` is untouched, so the language server, `mx-tsc` and every host's `warnings` list see the same value as before.
- `spanPosition` (the `file:line:column` a callee's unreadable `Input` names) now returns a 1-based column, so the unreadable-`Input` message `... (card.mx:2:24): Unexpected token` points at the 24th character rather than the 23rd.
- The `parseFragment` padding-contract errors (`assertBaseContract`, `positionRegionSource`) print their position 1-based too, clamped at column 1 rather than printing a negative one; `TranslateError.line`/`column` still carry the raw numbers.
- `readParseOptions` drops Babel's trailing 0-based ` (L:C)` from the message it embeds (`could not be parsed: Unexpected token`), reusing `dropOwnParserPosition` — the same helper the TypeScript plugin and the language server already share, so a sidecar parse failure names one position instead of two.

Tests: `src/warning-position.test.ts`, the padding-contract rows in `src/fragment.test.ts`, and the two `Input`-unreadable rows whose expected columns are corrected to the 1-based value they were always meant to be.

### Added: `nearestName` export (unknown-tags)

`nearestName(name, candidates)` — the unambiguous-nearest-name helper behind core's did-you-mean hints — is now exported so a target can hint at a declared name (the data target's `unknownTags: "reject"`). Additive; no behaviour change.

### Fixed: a failed target load is retried on every resolution (registration PR 7 round 3)

Round 2's failure cache is removed: it was keyed on the entry file, so a fix to a module the entry requires was never picked up. A throwing or invalid target is re-evaluated per resolution, as in round 1, and reloads after a fix to any file. The registration-verdict cache stays. After installing a missing target, restart the language server, TS server or dev server: both Bun and Node keep a resolution miss once the project has a `node_modules` (TODO `target-loader-sticky-not-found`).

### Fixed/Changed: third-party targets, round 2 (registration PR 7)

Rule 3 compares host names for loaded descriptors: a bare `mx.host` naming the loaded target's host selects it with no `unknown-host` warning, and two loaded specifiers of one host agree. A loaded descriptor is rejected with `target-invalid-descriptor` when it declares `host.fileKinds` (`file kinds are supported for built-in targets only (for now)`, TODO `third-party-file-kinds`) or names a built-in host (`host "solid" belongs to the built-in targets; a third-party target cannot join it (for now)`, TODO `third-party-join-builtin-host`). The registration verdict is cached per descriptor and lookup shape, and a load failure (throws, invalid) is cached under the target package's manifest and entry-file stamp, so a throwing module is not re-evaluated per file; a fixed package reloads.

### Added: load a third-party target from `package.json#mx.target` / `mx.host` (registration PR 7, decisions 129/132)

A package specifier under `mx.target` or `mx.host` (containing `/` or starting with `@`, `.` or `/`) is now loaded through `loadTargetDescriptor(spec, fromDir)`, resolved from the project's `package.json`, replacing the "loading a target package is not supported yet" staging error. `TargetPolicy` gains the optional `descriptor` (the loaded descriptor, absent for built-ins; read it as `policy.descriptor ?? lookup.target(policy.target)`), and `TargetPolicyDiagnosticCode` gains `target-not-found`, `target-load-failed`, `target-invalid-descriptor` and `host-invalid-descriptor`. A specifier that resolves and then fails is an error with no fallback to a guessed target (OQ2 c); a bare unknown word under `mx.host` keeps its warning (OQ10 unchanged: the tool calls `descriptor.load(core)` with its own core). A descriptor is also checked against the caller's lookup, so it cannot reuse a built-in's name, package, host or file-kind segment, nor a name the registry reserved. `TargetLookup` gains the optional `reservedNames()` (what `createTargetLookup` was given), which the loader passes on. Messages are one line then the action, positioned at the key's value with `length`. Core names no host and no target; spec §13.5 and the "Third-party targets" docs page.

### Fixed: mutable scriptlet replacement advice (scriptlet-hint-let-var)

Both the parse-error and lowering paths preserve the declared `const`/`let`/`var` keyword through `HostDeclarations.scriptletReplacement(name, keyword)`. The default suggests `<const>` only for `const`, and `<let>` for `let`/`var`; hosts that reject `<let>` override the advice or omit it by returning an empty string. Host choices remain outside core (decision 126); scriptlets are still rejected (decision 54). Lead ruling 2026-10-03 (question 37): the default says what Marko says (`<let>` is the mutable binding), so a host that cannot do `<let>` must override the hook (documented on `scriptletReplacement`); the `keyword` parameter is additive and no published host is affected.

### Fixed: preserve normalized whitespace-only bodies (jsx-whitespace-body-parity, decision 141)

`hasContent` now tests Marko-normalized text for nonemptiness rather than trimming it again. Same-line spaces/tabs supply one-space content through imported components, discovered template tags and attribute-tag bodies; newline indentation already removed by Marko stays absent. Host-independent, with no second normalization pass. `openTagOnly` consequently rejects retained same-line spaces on transform tags too; dropped newline indentation stays accepted. Rendered regressions cover all seven hosts; the data target retains the same text and still rejects it under `structural: "reject"`.

### Added: package-level contract modules (`mx.contracts`, decision 142)

`package.json#mx.contracts` accepts a module string, `{ module, hosts? }`, or an array. Modules default-export the new `ContractMap` type: declarations plus optional `analyze`, never transforms, finalizers or templates. Both discovery walks load them synchronously after local `tags/` and `mx.tags`, with whole-entry replacement and positioned shadow/duplicate warnings. Configuration and resolution errors point at the manifest's `"contracts"` key; module load and declaration errors point at the module file. Module paths and parser options participate in signatures, preserving content-aware hash invalidation and stable unchanged maps. Transitive imports are not tracked; keep modules self-contained. Spec §9.2/§9.7, `divergences.md`, and core regression tests; no host-specific code.

Round 2: host restrictions are applied before resolving entry precedence and module duplicate/shadow warnings, so restricted entries cannot hide unrestricted fallback contracts for other hosts or hostless callers. Module validation and stamps still cover ineligible entries. Broken-manifest warnings name both settings and explicitly say that none load without a previous valid revision; otherwise the last good settings stay in force. Absent `mx.contracts` avoids key-position tokenization. The spec documents `require`/`default` export conditions and limits Node's restart requirement to ESM/TS modules; `.cjs` reloads correctly.

### Added: `dropOwnParserPosition(error, message)` (ts-plugin-ts80001-babel-suffix)

Drops Babel's trailing 0-based ` (line:column)` from a parse error's message only when it provably repeats the error's own parser `loc`; a `TranslateError`, a plain `Error` or a suffix that differs from `loc` keeps its text. Generic; used by `@mxlang/typescript-plugin` and `@mxlang/language-server` so every surface prints the same `TS80001` text.

### Fixed: scan and target-descriptor caches detect same-tick edits (scan-cache-content-aware)

`scanCached` now compares the text of every already-tracked template and sidecar on an mtime hit. The loaded tag-map signature also includes a text hash, so unchanged parser options cannot reuse a sidecar's memoized old hooks. An unchanged scan adds one read per tracked tag file; manifest text reads and directory-entry comparisons were already content-aware (directory mtimes are not used). `loadTargetDescriptor` confirms the nearest manifest's mtime against its path and text, costing one manifest read per lookup, and reloads package-owned modules after a same-tick or pinned-mtime manifest edit. Source-only edits without a manifest change remain outside the installed-target reload contract. Pinned-mtime, same-size regressions cover templates, sidecar options, hook-only changes, target package internals, and directory add/remove. This supersedes the earlier mtime-only cache-family descriptions below; `template-tag.ts` and `callee-input.ts` already compare source and are unchanged.

Round 2: scan snapshots now retain SHA-256 hashes instead of template, sidecar or manifest text per directory key; the loaded signature reuses the snapshot's hashes. Each unchanged scan reads and hashes each already-tracked tag file and manifest once, with fixed-size 64-character hashes rather than file-sized retained text. Target-loader manifest stamps likewise retain hashes only; an unreadable nearest manifest (including a directory named `package.json`) stays cached while its path, mtime and readability are unchanged, and a readability or mtime change still reloads it.

### Added: attributes and children on declared attribute tags (contract-e4, decision 138)

`CustomTagAttributeTag` gains recursive `attributes`, `attributeTags` and `children` maps (including the lead's 16:50 children ruling). The shared attribute validator checks the full vocabulary, E1's `array` / `function` / `items` included, at every depth; defaults on attribute-tag attributes are not applied. The E2 checker validates authored plain children before lowering, with `#text`, required/repeatable paths through `<if>` / `<for>` and complete owner-chain diagnostics such as `` `<card>`: `<@row>`: unknown attribute `bogus` ``. Nested attribute-tag cardinality uses the preserved control-flow tree. No-map declarations keep the prior no-template shape and control-flow rejections. Unknown declaration keys and E1 contradictions are checked recursively at registration; plain child declarations remain cardinality-only. Spec §9.7/§9.8, sidecar/reference docs, `divergences.md`, and core/data tests; no host-specific core code (decision 126).

### Added: explicit target selection (target-select, decisions 129/132)

`mx.target` selects a registered target, including its host behaviour. When
`mx.host` also resolves, they must agree: `target-host-mismatch` is an error,
positioned at the target value with related information at the host. Unknown
targets and package specifiers are positioned `unknown-target` errors; package
loading is not supported yet. Diagnostic ranges carry the JSON value length.
Core remains open-set. Target names in `mx.tags[].hosts` warn with a host hint.
Existing configurations without `mx.target` resolve unchanged.

### Fixed: a same-tick, same-size `package.json` rewrite is no longer served stale (core-package-json-ctime-cache)

`readPackageJsonCached` keyed its cache on `mtimeMs:ctimeMs:size:ino` alone. Linux before 6.13 stamps ctime at jiffy granularity (4 ms at HZ=250), so an edit that kept the size inside one tick, with the mtime pinned, left the key identical and the old `mx.host` / `mx.tags` kept winning. On a stamp hit the cache now also reads the file and compares its text with the cached text (one read plus a string compare per lookup of an unchanged file; a stamp miss costs what it did). `setPackageJsonStatForTests` lets tests freeze the stat to reproduce coarse timestamps on any OS. The other stat-keyed caches in core (`scan-cache`, `template-tag`, `callee-input`, `target-loader`) key on `mtimeMs` only by design and never depended on ctime.

### Fixed: the scan cache confirms a `package.json` hit against its text (core-package-json-ctime-cache)

`scanCached` compared each scanned `package.json`'s mtime only before returning a cached scan, ahead of the content-aware reader, so a same-tick rewrite (or a pinned mtime) kept serving the old `mx.tags` and diagnostics. The cached entry now also holds each manifest's text and a hit requires the file text to match. `setPackageJsonStatForTests` is typed with a local structural `PackageJsonStat` so no `node:fs` type reaches the emitted `.d.ts` (`pack-hygiene` forbids node builtins there). Tag-file and directory-listing freshness in `scan-cache`, and `target-loader`, stay mtime-keyed (TODO `scan-cache-content-aware`).

### Added: allowed authored parents for custom tags (contract-e3, decision 138)

`CustomTag.parents?: string[]` restricts authored direct parents; the reserved `"#root"` key permits a file or template unit's own top level, including recursive calls. `<if>` / `<else-if>` / `<else>` and `<for>` are transparent; all other authored tags break the chain, with `"@row"` naming the parent inside an attribute-tag body. Omitted parents keep placement open; an empty list allows none. A generic lowering-context ancestor stack checks placement before lowering a custom call's body, for transform tags, templates with declaration-only sidecars and parents-only delegated contracts. Discovery carries the declaration. Registration rejects a parent listing a child whose declared parents exclude it, and the converse: a child naming a parent whose closed children exclude it. Both messages name the two tags and end with the two alternative list edits. `<define>` is not transparent, and a dynamic parent never matches a declared parent (even its diagnostic placeholder). Violations report the first positioned error at the authored tag, naming expected and actual parents (or top level). Spec §9.7/§9.8, sidecar docs, `divergences.md`, and core/data regression tests; no host-specific core branch (decision 126).

### Added: allowed authored children for custom tags (contract-e2, decision 138)

`CustomTag.children` is a closed record of `{ required?, repeatable? }` declarations; the reserved key `"#text"` allows non-whitespace text and interpolations. Whitespace, comments, `<const>` and `<define>` declarations do not count. Core validates authored child names before lowering, including transform children, template tags with declaration-only sidecars and contract-only delegated tags. `<if>` / `<else-if>` / `<else>` and `<for>` are transparent: requirements hold on every path and loops need repeatability. Dynamic children are rejected in a closed contract. Unknown children, text, dynamic children, repetitions and missing children report the first positioned error; repeat errors point at the second occurrence (or the sole loop occurrence). Registration rejects children with `parseOptions.text: true` or `openTagOnly: true` and unknown child-declaration keys. Optional `TagCall.childTree` and exported `ChildNode` / `CustomTagChild` expose authored structure to hooks without changing emitted IR. Spec §9.7/§9.8, sidecar docs and `divergences.md`; core and data-target regression tests.

### Added: `array` and `function` attribute types for tag contracts (contract-e1, decision 138)

`CustomTagAttribute.type` accepts `"array"` and `"function"`, plus an optional `items: "string" | "number" | "boolean"` for arrays. The call-site check reads the attribute's Babel node: a literal array is an array (each literal element is checked when `items` is set, a non-literal element passes), an arrow function, a function expression or the method shorthand `value({ post }) { … }` is a function, a string, boolean, number or object literal is the wrong type for either, and an identifier, call, member or conditional is accepted because its type is unknowable (the rule `string` and `number` already follow). Messages: `` attribute `values` must be array, got string `` at the attribute, and `` attribute `values` item 2 must be string, got number `` at the element. Registration rejects `items` without `type: "array"`, an `items` value outside the three literal types, and `enum` with `array` or `function`; `items` joins the allowed-key list. Existing contracts are unchanged. A template literal counts as a string and a bound attribute (`value:=…`) is checked like a dynamic one. A function expression or method shorthand reaches the contract only on a host that resolves attribute methods (`resolveAttributeMethod`). An mx-only check beyond Marko (`divergences.md`); spec §9.7 and §9.8.

### Added: `HostOptions.stripTypes`, a pass-through to Marko's compiler (jsx-handler-typing, decision 140)

Optional and unset by default, so a normal compile is unchanged. Marko's `output: "html"` strips TypeScript annotations from any expression it has to reprint, which dropped the parameter types of attribute-method shorthand handlers (`onClick(a: string) {…}`). A host's tooling mode sets `stripTypes: false` to keep them for type checking. Nothing host-specific lives in core.

### Fixed: a CDATA section or an XML declaration is a positioned error on every target (core-cdata-error, decision 139)

`<![CDATA[…]]>` and `<?…?>` were dropped in lowering on every host — Marko's parser makes a `MarkoCDATA` and a `MarkoDeclaration`, and core's IR has no node for either, so both fell off the end of `lowerChildren`' switch. `<a><![CDATA[ x ]]></a>` compiled to `"<a></a>"` and `<?xml version="1.0"?>` to `"<a></a>"`: wrong output, green build. Lowering now raises a positioned `TranslateError` on both, at the `<` of the construct, with Marko 6.3.51's meaning and MX's wording: `` `<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value `` and `` `<?…?>` (an XML declaration or processing instruction) is not supported: remove it ``. Marko rejects both (`runtime-tags/src/translator/visitors/cdata.ts`, `visitors/declaration.ts`). A **raw-text** body (`<script>`, `<style>`, `<textarea>`, `<title>`) is read by Marko's parser as one `MarkoText`, so the construct there is ordinary text and reaches the output verbatim — probed and pinned, not assumed. Output changes only for templates that contain either construct outside a raw-text body, where the change is from silently wrong to an error. Spec "CDATA sections and XML declarations"; `divergences.md` unchanged, because this matches Marko.

### Added: did-you-mean and where-to-import hints on an unresolved tag (fix-hints-batch, audit item 14)

One short, positioned hint appended to Marko's wording; the error, its position and its count are unchanged.

- **Unresolved tag** (`unresolvedCustomTagMessage(name, { candidates?, hint? })`, additive options, `UnresolvedTagOptions` exported): a lowercase name gets Marko's own ``Did you mean `<div>`?`` wording when exactly one HTML element is nearest (`did-you-mean.ts`: swapped letters count as one edit, two edits only from five characters, ties and names under three characters say nothing; Marko's own pick for `<dvi>` is `<bdi>`); a capitalized name gets the nearest in-scope import or `<define>` the same way, otherwise the host's `hint` saying where the tag can come from.

### Added: host-supplied scriptlet replacement; hint fixes (fix-hints-batch round 2)

`HostDeclarations.scriptletReplacement?(name)` (optional, additive) supplies the replacement for a `$` scriptlet that declares a value; the default stays ``declare a value with `<const/name=…/>` ``. `@mxlang/solid` says to declare it in the surrounding TypeScript module and `@mxlang/astro` in the `---` fence, because their templates reject `<const>`. The sentence is now only added when the statement declares exactly one variable (`const|let|var NAME =`, no second declarator); a call, assignment, class, import or destructuring gets the bare "scriptlets are not supported". The scriptlet hint no longer fires inside a multi-line `{…}` attribute value or `${…}`. A multi-error aggregate puts each fix hint on its own frame (found by the entry's `:line:column`, first un-hinted occurrence). The did-you-mean list drops `search` and `slot`, which `@mxlang/html` cannot resolve.

### Added: fix hints on attribute-value, scriptlet and event-binding errors (fix-hints-batch, audit item 14)

One short, positioned hint per error, appended to the reason; the error, its position and its count are unchanged. Semantics are Marko 6.3.51's, and every suggested form is compiled in a test.

- **Parse errors** (`parse-error-hints.ts`, applied beside the close-tag-opener annotation in `compileSource`, on `message` and `label`): `<div id= class="a">` (`Unexpected token, expected "{"`) now ends ``; `id=` has no value; write `id="…"` or `id=expr`, or drop the `=` ``; a syntax error inside a `$` line ends ``; scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>` `` (Marko 6.3.51 rejects every scriptlet in the tags API), naming the declared variable when the line is `const|let|var NAME =`. The position stays where Marko puts it (the second `=` for the first case, though the missing value is at `id=`).
- **A valid `$` scriptlet** (lowering error, decision 54) carries the same ``declare a value with `<const/x=…/>` `` fix.
- **`(click)="go()"` on an element** now ends ``; for an event handler write `onClick=go` `` on a host that renders handlers (it declares `resolveAttributeMethod`); `go()`/`go` give `go`, anything else `handler`, and only a lone identifier argument qualifies. A host that renders once to a string (`@mxlang/html`) has no handler form to suggest, so its message is unchanged.

### Fixed: a `TranslateError` message no longer starts with the compiled file's path (translate-error-no-repeated-path, audit item 17; no-repeat-path-relative-spellings)

`compileSource` drops the `<filename>: ` prefix Babel adds to a translator error's message. The error already carries `line`/`column` (and `file` for an error in another file), and every surface prints the file itself, so the prefix only repeated it, as an absolute path, in `mx-tsc`'s `TS80001` and the language server's message. The comparison is two-sided: the leading path is extracted from the message and both sides are compared by `resolve`/`realpathSync` identities (a file missing on disk resolves only), so the strip holds however Babel and the caller each spell the file — absolute, relative, symlinked, or two independent aliases of one directory; a prefix naming a different file is kept, never stripped.

### Changed: core resolves targets from a caller-supplied lookup, and names none (refactor/target-open-set, decisions 129 and 132)

**Behaviour-preserving refactor, except for the dotted-name rule below and the ruled own-only warning policy.** Core held a closed list of the seven built-in hosts (`HOST_NAMES`, `HOST_PACKAGES`, `isKnownHost`, `DEFAULT_POLICY`, `HOST_MODULE_SEGMENTS`, `MX_ATTR_TAG_SOURCES`); all are gone, replaced by a required `TargetLookup` (decision 126). Every entry point that needed one now takes it, so forgetting it is a type error rather than a silent loss of validation:

- `resolveTargetPolicy(filePath, lookup)` and `resolveTargetPolicyDetailed(filePath, lookup)` — the lookup is a required second argument. `TargetPolicy` gains `target: string` and `host?: string`; the default policy is `lookup.defaultTarget()`.
- `hostModuleSegment(entry, lookup)` — a required lookup instead of the `HOST_MODULE_SEGMENTS` array, which is no longer exported.
- `ScanOptions` gains a required `targets`; `discoverProjectTagsOptions` likewise. The scan cache stays lookup-free (directory, `stopAt`, `host`); dotted-filename evidence is cached neutrally and diagnostic wording is derived per caller. `host: null` excludes every restricted entry for a target with no filter key, unlike intentionally unfiltered `host: undefined`.
- `ScanResult` gains `hostRestrictions`, every `mx.tags[].hosts` value the scan read, and the scan no longer decides which of them are known. New export `hostRestrictionDiagnostics(restrictions, lookup)` produces the diagnostic for a bare unknown word — today's text, byte-identical — when called by full-registry tooling. Own-only loaders do not call this helper and leave peer restrictions unresolved without a warning (PR 3 round-2 ruling). Package specifiers remain silent. Filtering and malformed-shape checks are unchanged.
- `ResolveContext` gains a required `targets`, `Ctx` too, and `newCtx` takes it as a sixth argument. The `AttrTag` source set is now `@mxlang/core` plus `lookup.attrTagSources()` (every registered target's `packageName`), and the file-kind test in the callee reader asks `lookup.moduleSegments()`. The module-level reader registry (`registerCalleeInputReader`) is unchanged and still generic. Callee analysis is cached per lookup identity as well as the existing path/resolver and dependency snapshots.

The messages do not change: the unknown-`mx.host` list is every non-deprecated `mx.host` value in registration order with the deprecated one named apart (for the built-ins, the same string as before), the malformed-`package.json` clause reads the lookup's default target, and the deprecated-alias warning names the value and the target it selects. `TargetPolicyDiagnosticCode` keeps `unknown-host` and `malformed-package-json` (decision 07 Q9).

### Added: `isTranslateError`, a brand check that survives two copies of core (refactor/target-open-set)

A host resolved from a project brings its own `@mxlang/core`, so an error it throws is not the class a tool checks with `instanceof`; every positioned error from it degraded to a wrapped, positionless one. `TranslateError` now carries a `Symbol.for("mxTranslateError")` brand and core's own `instanceof TranslateError` checks read the new `isTranslateError(error)` export (design note §4.4, mitigation 2). No behaviour change within one copy.

### Changed: a dotted tag file name is rejected, not indexed (refactor/target-open-set, decision 137)

**Behaviour change.** A `<base>.<word>.mx` file under a `tags/` or `mx.tags` directory is no longer indexed as a tag. It could never be called: the tag form `<base.word/>` and the concise form `base.word` both parse as tag `base` with shorthand class `word` (measured on Marko 6.3.51 and on this parser), so the entry was a dead tag with no word to the author.

Such a file is now excluded from the tag map with a positioned diagnostic, in one of two forms. When `<word>` is a file-kind segment a registered target declares (`ng`, `solid`, `astro` for the built-ins) the wording is unchanged — `` `${entry}` is a host module file, not a tag template; tag templates are `.mx` ``. Otherwise: `` `${entry}` cannot be called as a tag: `<${bare}>` parses as tag `${tag}` with class `${classes}`. If it is another host's module file it does not belong under this host; otherwise rename it without the dot. `` Which form applies depends on the caller's lookup: a direct entry that knows only its own targets (a Bun loader, the Angular CLI) sees another host's file kind as the second case and still rejects the file. An mx-only lint beyond Marko, which indexes such a file silently; recorded in `divergences.md`, and spec §9.2 states the rule.

### Added: spans on Text, Comment and structural IR nodes (core-ir-spans)

**Additive only; nothing that exists today changes.** `Text`, `Interpolation`, `Comment`, `IfChain` (and each `Branch`), `For`, `Const`, `Define`, `Import`, `Export` and `Static` gain an optional `span?: SourceSpan` (file-absolute UTF-16 code-unit offsets, the `Expr.span` convention). `Text.span` slices the text exactly as authored, which `value` has Marko-normalized. `Interpolation.span` covers the whole `${…}` / `$!{…}`, delimiters included (`expr.span` still covers the expression only). `Comment.span` includes the delimiters (`<!-- … -->` or the `//` line). `IfChain.span` runs from the `<if>`'s `<` through the last branch's closing tag; each `Branch.span` covers that branch's own tag, body and closing tag included, as do `For.span`, `Const.span` and `Define.span`. `Import`/`Export`/`Static.span` cover the authored statement with the trailing line terminator trimmed, because Marko's statement `loc` ends on the next line's column 0; a trailing same-line comment is part of the span, as it is of the statement's `code`. Synthesized nodes — an inert disposition's or `<return>`'s empty `Text`, builder-produced nodes, a `synthesized: true` `Import` — carry no span. This is the data target's core spans PR (decisions 131/132, 06 answer item 7): consumers such as the data tree and formatters can now slice authored source for every IR kind. Tests in `src/spans.test.ts` slice the source with each span, including under emoji (UTF-16) and CRLF line endings.

### Fixed: opener position on statement tags with TypeScript generics and on aggregate errors (missing-close-tag-opener-position, round 2)

The replay now declares Marko 6.3.51's core taglib parse options (statement: `class client export import server static`; openTagOnly: `const debug id let lifecycle log return`; text: `html-comment html-script html-style script style textarea`), so `export interface Input<T = string>` or `static const xs: Array<string>` above the mismatch no longer defeats it. An aggregate error (several parse errors, no `loc`) has each entry annotated and the same suffix written into the aggregate message. The message is written with `defineProperty` because `CompileError.message`'s setter discards the first assignment.

### Added: a mismatched closing tag names the opener's position (missing-close-tag-opener-position, audit item 12)

`compileSource` appends ` at line:column` (1-based, UTF-16 columns, the `<` of the innermost unclosed tag) to Marko's `The closing "div" tag does not match the corresponding opening "p" tag` error, on `message` and on `label`. The error stays at the closer. Marko 6.3.51's error carries no second location, so core replays the source through `htmljs-parser` (new exact-pinned dependency, 5.15.0, the copy `@marko/compiler` already uses) and only annotates when the replay reproduces the same error at the same position; otherwise the message is untouched. Reaches every Marko-path host (html, preact, react, hono, astro, angular whole-file).

### Feature: a repeated attribute name resolves last-wins in core (dup-attr-last-wins-core, decision 135)

Within one tag the last occurrence of an attribute name now wins on every host: `lowerAttrs` drops the earlier ones, so the IR carries one attribute per resolved name (the last, with its own spans, at its own position) and no emitter or delegated-tag consumer sees a duplicate. This is Marko 6.3.51's behavior (`<div class="a" id="x" class="b">` is `<div id=x class=b>`, the dropped value is never evaluated, `class`/`style` do not merge). The decision-133 warning stays, now positioned on each DROPPED occurrence and naming the survivor: ``duplicate attribute `class`: the later one at 1:16 wins, so this one is dropped`` (1-based in the text, core's 0-based column in the structured position); three occurrences give two warnings. Never an error, `mx.strict` included. Output changes only for templates that already got the warning. A default attribute is named `value`; a spread never counts; `onClick` beside `on-click`, `class` beside `Class` and Angular `x`/`[x]`/`(x)`/`#x` stay distinct. Spec "Duplicate attributes"; `divergences.md`.

### Added: the target descriptor contract and a synchronous loader (target-descriptor, decisions 129 and 132)

**Unstable; nothing consumes it yet.** New exports: `TargetDescriptor`, `TargetHost`, `TargetCompiler`, `TargetCompileOptions`, `TargetCompileResult`, `HostFileKind`, `HostRegionInput`, `HostRegionResult`, `TargetLookup`, `validateDescriptor`, `createTargetLookup`, `TargetDescriptorError`, `TargetLookupError`, `loadTargetDescriptor`, `clearTargetDescriptorCache`, `TargetLoadError`, `TargetLoadErrorCode`, `TargetLookupRule`. A descriptor is plain data plus a lazy `load(core)`; `createTargetLookup` enforces distinct target and host names, caller-supplied `reservedNames`, `packageName` uniqueness (shared only within one host), one `host.default` per multi-target host, and a single non-deprecated `legacyHostValues` entry as a hostless target's filter key. `loadTargetDescriptor` resolves from the project like `loadSidecar` does and caches by resolved path and the nearest `package.json` mtime. When that manifest belongs to the target package, a change re-evaluates the entry and the modules under the package directory (not a nested `node_modules`); when it is the project's own, only the entry file. No existing behaviour changes.

### Feature: a duplicate attribute is a positioned warning on every host (dup-attr-warning)

`<div class="a" class="b">` (or `on-click` twice) now raises one `MxWarning` per repeated attribute, positioned at the repeat's name and naming the earlier occurrence as a 1-based `line:column` (decision 133). Never an error; emitted output is byte-identical to before. Marko 6.3.51 accepts duplicates silently. Names compare case-sensitively on the resolved attribute name; a spread and `onClick` beside `on-click` do not count. The warning reaches `mx-tsc` and the host compile APIs' `warnings` lists through the existing channel, and a Vite build through core's `console.warn` fallback (build still succeeds). An mx-only lint recorded in `divergences.md`; spec §4 "Duplicate attributes".

### Changed: `astro` joins `HOST_MODULE_SEGMENTS` (amx-to-astro-mx, decision 134)

The Astro template kind is renamed from `.amx` to `.astro.mx`, so `hostModuleSegment("card.astro.mx")` is now `"astro"` and a file of that kind under `tags/` is reported as a host module file instead of being silently skipped (it was `.amx`, without the `.mx` suffix). No other core change.

### Breaking: `claimsTag`/`HostTag` renamed to `isDelegatedTag`/`DelegatedTag` (delegated-tag-rename, decision 132)

**Breaking, no aliases.** `HostDeclarations.claimsTag` is now `isDelegatedTag`, `HostDeclarations.resolveHostTag` is now `resolveDelegatedTag`, the IR kind `HostTag` (the `kind` literal and the type) is now `DelegatedTag`, and the `ctx.build.hostTag` builder is now `ctx.build.delegatedTag`. `Emitter.hostTag` is now `Emitter.delegatedTag`; the exported helper `isContractOnlyClaimed` is now `isContractOnlyDelegated`. Hosts must rename these; behaviour, output and diagnostics are unchanged. Earlier entries below keep the names they shipped with. Spec §9.8.

### Fix: reading `input` whole no longer warns that an `<@attribute>` tag was dropped (attr-tag-dropped-false-warning)

**Behaviour change (removed false warnings only):** a template unit that read `input` whole (for example `tags/resource.mx` containing only `<return=input/>`) made every caller warn "`<@attribute>` was dropped; … does not read `input.attribute`" (and "body content was dropped"), although the emitted call passes the value. The metadata counted only `input.<name>` member reads. A bare, unshadowed `input` that is not the object of a member read now counts as reading every attribute tag and the content: returned (`<return=input/>`), assigned (`const copy = input`, `static const p = input`), passed to a call (`fn(input)`), spread (`...input` into an object, an attribute list or a tag call), and destructured with a rest element. A rest-less destructure (`const { a } = input`) still reads only the named properties, so a dropped `<@b>` still warns, as does a member read of another name or a shadowed local named `input`. A destructure with a computed non-literal key now counts as a whole read, and an object literal in expression position (`{ ...input }`) is now scanned (it was a parse failure that hid the spread). Marko 6.3.51 has no such lint (it silently omits the unread attribute tag); the warning remains an MX-only lint, now correct. Fragments are now parsed with the TypeScript plugin and top-level `await` allowed (`input as any`, `input!.x`, `satisfies`, typed arrow parameters, `await input`), a default value inside a destructure (`const { v = input.y } = input`) is scanned, and a fragment that still cannot be parsed but names `input` counts as a whole read, so a parse failure suppresses the warning instead of causing a false one. Not counted as member reads (conservative, a missed warning): an alias (`const i = input; i.x`), `typeof input` and `"y" in input` are whole reads. No emitted code changes.

### Chore: the spelling hints name no framework (core-hints-neutral-names)

**No behaviour change.** The hint shown for a `#…` attribute name now reads "`#…` template reference variables have no meaning in MX" and the one for `*…` reads "`*…` structural directives have no meaning in MX; use `<if=cond>` / `<for|item| of=list>`" (previously "… are Angular syntax"). When the hints fire, where they are positioned and the `onDoubleClick` warning text are unchanged. Internally `REACT_EVENT_SPELLINGS` and `warnOnReactEventSpelling` are now `NON_DOM_EVENT_SPELLINGS` and `warnOnNonDomEventSpelling`.

### Fix: a default attribute's `nameSpan` is zero-width at the `=`, as in Marko; tags and static values gain spans (core-span-fixes)

**Behaviour change (one diagnostic position):** `<x="post">` lowers to `name: "value"` with a `loc` that starts at the `=`, so `attrNameSpan` measured `"value".length` from there and `nameSpan` covered `="pos` (for `resource="post"`: 8–13). A default attribute has no spelled name, and Marko anchors it with an empty range at the attribute start (htmljs-parser 5.18.0 `ensureAttrName`; `@marko/language-tools` 2.7.0 treats the empty range as "default"), so `nameSpan` is now zero-width at the `=` (8–8). Consumers detect the empty range, as Marko does. Method shorthand (`change(ctx) {…}`) was already correct and is pinned by a test. Spelled attributes and `name:modifier` spellings are unchanged.

**Additive IR fields**, all optional, all UTF-16 code-unit offsets into the source string like every existing span: `span` (the whole tag: opening tag, body and closing tag) and `nameSpan` on `HostTag` and `Element`; `span` on `Component` (which already had `nameSpan`) and on `AttributeTag`; `valueSpan` on a `static` attribute (the string literal, quotes included, like `Expr.span`). `HostTag.nameSpan` is `undefined` for a dynamic tag. No emitted code changes.

### Fix: a `.ng.mx` callee reads as untyped, not as an invalid Marko parse; callee-input no longer names `.solid.mx` (core-host-cleanup)

**Behaviour change:** a host module file (`card.ng.mx`, `card.solid.mx`) with no registered callee-input reader used to fall into the plain `.mx` branch of `readCalleeInput` and be Marko-parsed. For `.ng.mx`, which no host registers a reader for, that returned `{ kind: "invalid" }` ("@tags must be nested within another element", or "requires ResolveContext.ctx" without a Ctx), so a valid `.ng.mx` callee put a spurious error on its callers. It now returns `{ kind: "none" }`, the same untyped result an unregistered `.solid.mx` already had (`hostModuleSegment` is the generic test). No emitted code or oracle output changes.

The extension probes are now derived from the readers registered through `registerCalleeInputReader` instead of hard-coding `.solid.mx`. **Precondition:** an extensionless import resolves to `X.solid.mx` only once `@mxlang/solid` is loaded (its reader registration adds the probe); every tool already loads its host package. The `AttrTag` source packages are derived from `HOST_NAMES`, and two error messages say "a host module region" instead of "a `.solid.mx` region".

### Added: contract-only custom tags on a host-claimed name; `ctx.build.hostTag` carries attributes (contract-only-tags, decision 130)

A custom tag that declares only a contract (`attributes`, `attributeTags`, `parseOptions`, no `transform`, no template) is now valid on a name the active host claims (`claimsTag`). Core validates the call against the contract and lowers it to a `HostTag` with its attributes, attribute tags and children intact. On a host that does not claim the name the call still fails with "custom tag has neither a `transform` nor a template file, so a call has nothing to expand to". `ctx.build.hostTag(name, children, attributeTags, attrs?)` takes an optional fourth `attrs` argument; callers that omit it get the same node as before. No output change for any existing host. Spec §9.8. `TagCall` (public, exported from `@mxlang/core`) gains optional `span` and `nameSpan`, the UTF-16 spans of the call and of its tag name; the contract-only `HostTag` carries them like any claimed tag.

### Added: `TargetPolicyDiagnostic.code` (host-policy-diagnostics-tsc-tsserver)

Additive: every diagnostic `resolveTargetPolicyDetailed` returns now carries `code: "unknown-host" | "malformed-package-json"` (type `TargetPolicyDiagnosticCode`, exported), so a caller can word or route one without matching the message text. Messages, positions and the resolved policy are unchanged.

### Fix: `<for by=>` that reads a loop param is a positioned error, not a silent pass (audit-02-for-by-parity)

**Behaviour change:** `<for|x| of=items by=x.id>` compiled silently on html and preact and surfaced only as a stray `TS2304 'x'` at a generated position on solid. `by=` is evaluated once, before the loop, so the tag's params are not in scope there; Marko 6.3.51 rejects it (`runtime-tags` `translator/core/for.ts`, `findLoopParamRead`). `lowerForHead` now fails at the offending name, for `of`, `in`, `to` and `until`, with Marko's message and its hint (`by="id"` or `by=(x) => key`). The walk is Marko's own: a function or class in the value is skipped (`by=(x) => x.id`, `by=(y) => x.id` stay valid), a non-computed member property is a name and not a read, and an outer variable (`by=key`) or function (`by=someFn`) is accepted. Applies to every host, Angular included (its `by=(p => p.id)` and `by="id"` forms are unchanged).

### Fix: an attribute name outside Marko's grammar is a positioned error, not a silent pass-through (audit-01-prop-attr-parity)

**Behaviour change:** `<div [prop]="x">`, `<div #ref>`, `<div *ngIf="x">`, `<div [attr.x]="y">` and `<div @foo=1>` compiled silently on every non-Angular host (html passed every surface; preact then emitted invalid JSX that failed at a generated position). Marko 6.3.51 rejects them ("Invalid attribute name.", `runtime-tags` `normalizeTag`). `lowerAttr` now applies Marko's own name grammar (`[a-z_][a-z0-9._:-]*`, the same for elements and custom tags: Marko 6.3.51 also rejects `<foo $foo=1/>`) and fails at the authored name with a hint (`write \`prop=\``, `<if=cond>`, `class={ a: cond }`, …). `HostDeclarations.acceptsForeignAttrNames` opts a host out; only `@mxlang/angular` sets it.

### Fix: `resolveTargetPolicy` stops at a malformed `package.json` and at `node_modules`; unknown `mx.host` warns (host-policy-walk-edge-cases)

Three silent failures in the upward walk that decides a file's host are closed. **Behaviour change:** the first two can change which host a file compiles under, only in setups that were already misconfigured.

- **A malformed `package.json` no longer hands the file to an unrelated ancestor.** The walk used to skip a `package.json` that failed to parse (or held `null`, `[]`, a string) and keep climbing, so a project with a syntax error in its own manifest silently took a monorepo root's host. It now stops at the nearest `package.json` that *exists*, as Node, TypeScript and `scan.ts` do, and resolves to the default `html` host. The new warning names the broken file, its parse error (positioned when the runtime reports a position: V8 does, Bun does not, then it is 1:0) and the ancestor `package.json` whose host the file would have used before.
- **The walk stops at a `node_modules` directory** (Node's package-scope rule). A `.mx` file in an installed package that ships no `package.json` used to take the consumer's host; it now gets the default `html` host, silently, as Node treats it.
- **An `mx.host` that is not a host now warns** (it was ignored silently and the dependency rule decided). The warning lists the valid hosts, suggests the nearest one within two edits (`"solidd"` → `"solid"`), and is positioned at the value in `package.json`. Resolution is unchanged: the value is still ignored.
- **Unchanged, now written down and pinned by tests:** a directory with no `package.json` of its own (a monorepo member) inherits the nearest ancestor's host. Two or more host dependencies still mean `html`.

New, additive API: `resolveTargetPolicyDetailed(filePath)` returns `{ policy, diagnostics }` (`TargetPolicyDiagnostic` has `ScanDiagnostic`'s shape: `file`, `message`, `line`, `column`); `resolveTargetPolicy` is its `policy` and is otherwise unchanged. Every diagnostic is a warning; none can fail a build that worked. Only the Vite plugin and the language server surface them today — `mx-tsc` and the editor's TypeScript plugin get the new fallback behaviour (html for a malformed `package.json`, no climb out of `node_modules`) without a warning.

Internally `scan.ts` and `host-policy.ts` now read `package.json` through one cached reader keyed on mtime + ctime + size + inode (so an edit that pins the mtime or replaces the file atomically is still seen) (`src/package-json.ts`). `scanCustomTags` output is byte-identical (checked over every `.mx` in the repo plus broken/empty/`null`/`mx.tags`-typo trees).

### Fix: `parseFragment` throws on a broken base position; new `positionRegionSource` (core-parsefragment-contract-check)

`parseFragment` and `parseFragmentNative` now reject a base that cannot describe a real file (non-integer numbers, negative `baseLine`, or `baseOffset < baseLine + baseColumn` when `baseOffset` is given) with a positioned `TranslateError` naming the rule. Before, a host that clamped the impossible filler count mis-mapped line/column-only positions (attribute names) silently. The contract is now written out on `FragmentBase`.

`positionRegionSource(region, at, { wrapper?, filename? })` is new and exported: it returns the host's padded `Ctx` source together with the matching `parseFragment` base, so the two cannot diverge. `@mxlang/angular` and `@mxlang/solid` use it in place of their hand-rolled copies; their output is byte-identical. On line 0 the offset must equal the column; from line 1 it must be at least `baseLine + baseColumn`. A partial base that used to be clamped now throws, by design: `compileSolidMx` with `{ baseLine: 3 }` alone (`baseOffset` defaults to 0) is such a case. `parseFragment` cannot see a host's pad, so a host that builds its own pad is still unchecked.

### Add: `HostDeclarations.resolveDiscoveredTagModule` and `binding` on a named `Component` target (html-tags-marko-import)

Both optional. A host that answers the hook with a taglib-discovered tag's template path gets `import _name from "<relative path>"` added to the module (Marko's own form: default import, extension kept, `_` plus the camelCased name, numeric suffix on a collision, once per module) and `binding` set on the `Component` target, so its emitter can call the imported identifier while `name` stays the authored spelling. Absent, or `undefined`, changes nothing. `Ctx.lookup.getTag`'s return type also gains an optional `template?: string`, the absolute template path `@marko/compiler` already puts on the tag definition it returns (a type-only widening; nothing in MX sets it). Only `@mxlang/html` implements the hook; every other host's output is byte-identical.

### Fix: the tarball ships only `dist/` and the README (pkg-types-g10)

`tsconfig.build.json` now excludes `src/**/fixtures/**` (the scan fixtures' `*.tag.d.ts` no longer land in `dist/fixtures/`) and turns `declarationMap` off (each `.d.ts.map` pointed at a `../src/*.ts` that is not in the tarball, so go-to-definition was dead anyway). `files` drops the `types` and `LICENSE` entries, which name paths that do not exist here. `scripts/pack-hygiene.test.ts` and `scripts/pack-probe.ts` pin the tarball contents and a `skipLibCheck: false` consumer typecheck.

### Added: `TemplateMetadata.hoistedExports` (host-authoring metadata)

An optional `string[]` on `TemplateMetadata`: the verbatim source of each top-level `export` statement a template hoists (not `export interface Input`), in source order, set only when there is at least one. It lets a host read a callee's own `export const` facts from the same parsed statements its module emission uses, instead of re-scanning the callee's text — the Angular host reads a tag's exported `selector` this way. Additive, following `inputAuxCode`.

### Feature: `hostModuleSegment` and `HOST_MODULE_SEGMENTS` are exported (angular-discover-core-ext)

`@mxlang/core` now exports `hostModuleSegment(name)` and `HOST_MODULE_SEGMENTS` (previously module-private in `scan.ts`) as documented host-authoring API. `hostModuleSegment` returns the host segment of a `.mx` file name (`"ng"` for `card.ng.mx`, `"solid"` for `card.solid.mx`) or `undefined` for any other name, so a host can route its own host module files and reject or exclude another host's with core's rule instead of hard-coding suffix checks. Additive; no behaviour change.

### Internal: shared `unresolvedCustomTagMessage(name)` (source-bindings-silent-parse-failure)

Marko's own "Unable to find entry point for custom tag `<Name>`." wording (decision 114) was hand-copied at four separate `rejectUnknownTag` call sites — `@mxlang/html`, `@mxlang/solid`, the shared preact/react/hono JSX emitter, and `@mxlang/astro`. Now exported once from `core.ts` (`unresolvedCustomTagMessage`) and called from all four; no wording change.

### Fix: a non-import local value used as a tag now classifies as function-like or unknown, matching Marko for every unknown case (local extension of decision 116)

Firstmate's ruling extends decision 116 to non-import PascalCase locals (`static`/module-scope declarations, `<const>` bindings, `<for>`/`<define>` tag params): a plain `function Foo(){}`/`class Foo{}`/arrow-valued `const` stays a direct call, while anything core cannot statically prove is a function/arrow/class — a string, a conditional, a call result, or a tag param (always unknown, since its runtime value is never inspectable at lowering time) — now lowers as a dynamic tag instead of throwing `"X is not a function"` at runtime. New `Ctx.unknownLocalValue` and exported `isFunctionLikeValue` in `@mxlang/core`.

### Fix: an `Input`'s `extends` base or intersection alias hitting `MAX_ALIAS_DEPTH` no longer silently degrades (callee-input-alias-depth-silent)

`InputAnalyzer.inputMembers` (`callee-input.ts`) reads an `Input` interface's `extends` base and a type alias's intersection parts by following named-type references through `resolveNamedType`, capped at `MAX_ALIAS_DEPTH` (4) like every other alias-following path in this file. When that cap was hit for these two paths specifically, the member silently became an open index signature — `AttrTag` typing behind the truncated hop was quietly dropped, with no diagnostic at all. The sibling property-alias path (`analyzeAttrTagType`, used for `tab?: AttrTag<Alias>`) already reported "declare this attribute tag's config literally" in the same situation, through `namedTypeEventuallyContainsAttrTag` — an unbounded (cycle-guarded, not depth-capped) lookahead that tells a genuinely unresolvable name (stays open, correctly, e.g. `interface Input extends MissingBase`) apart from a real chain that does contain an `AttrTag` behind a hop deeper than the cap reaches.

Both silent paths now call the same check before falling back to an open member. `namedTypeEventuallyContainsAttrTag` itself was widened to follow `TSInterfaceDeclaration` (its body, and recursively its own `extends` bases) and `TSIntersectionType` (each part), since an `extends` base or an intersection part can be either kind — it previously only understood `TSTypeAliasDeclaration`. Both now raise the identical "declare this attribute tag's config literally" error (an `errors` map entry under `"<input>"`), surfaced through the same `raiseInvalidCalleeInput`/`raiseInvalidOwnInput` `fail(...)` path attribute-tag config errors already use — an error, not a warning, matching the existing sibling path.

New tests: a 5-hop `extends` chain and a 5-hop intersection alias, each hiding an `AttrTag` behind the fifth hop, now report the positioned error instead of silently degrading; the matching 4-hop cases (within the cap) keep resolving and typing correctly, alongside the pre-existing 4-hop property-alias test.

**Round 2 (found by review): `scanAttrs`'s nested `attrs:` config alias-following loop had the identical shape** — closing the class of bug together. `scanAttrs` follows an attribute tag's `attrs: Alias` config through the same `resolveNamedType`, also capped at `MAX_ALIAS_DEPTH`, and set `decl.nestedOpen = true` with no `namedTypeEventuallyContainsAttrTag` check when the chain could not resolve — including past the cap — so a nested `AttrTag` hidden inside a deep `attrs` alias degraded silently too. Fixed the same way: the resolution-failed branch now checks `namedTypeEventuallyContainsAttrTag` and reports the error (keyed by the attribute tag's own `propPath`, since the loop breaks before any individual nested member is reached) instead of silently opening. A genuinely missing alias (no such type at all) is unaffected and still opens with no error. New tests: a 5-hop `attrs:` alias hiding a nested `AttrTag` behind the fifth hop now errors; a matching 4-hop case keeps resolving; a genuinely-missing alias stays open with no error (new coverage — no prior test asserted `nestedOpen: true` at all).

### Fix: a value import that isn't a `.marko`/`.mx` default import now lowers as a dynamic tag (decision 116)

Measured (TODO `value-import-as-tag-parity`): Marko 6.3.51 compiles every capitalized local-import tag to `_dynamic_tag`. At runtime, a string renders as an element and a Marko template is called; anything else (a plain function, a plain object, `undefined`, `null`) renders only the body. MX previously routed every capitalized value import straight to a direct call (`lowerComponent`'s `kind: "name"` target), so a string, `undefined`, `null` or a plain object threw `"X is not a function"` on every host.

`lowerStatement`'s `import` handling now tracks, per binding, whether it is a `default` specifier whose source ends in `.marko`/`.mx` (`ctx.importDefaultFromMarkoOrMx`, populated via the new exported `isMarkoOrMxSpecifier`). The file-local-binding routing in `lowerTag` still routes a `.marko`/`.mx` default import to a direct `kind: "name"` call, exactly as before; every other capitalized value import (named, namespace, or a default from any other extension) now routes to `kind: "dynamic"` — the same lowering an authored `<${expr}/>` already produces, reusing every host's existing dynamic-tag emitter with no per-host routing change (decision 79). **Intentional divergence from literal Marko parity:** a plain function is still called and its return value kept, since an imported `.tsx` component on react/preact/hono, or an MX component on html, IS a plain function — Marko's own runtime would discard its return value, which would break ordinary host interop.

`ComponentTarget`'s `"dynamic"` variant gained an optional `valueImportBinding: string`, set only by this routing (never for an author's own `<${expr}/>`), so `readCalleeInput`/`resolveTarget` can still resolve the callee's declared `Input` for typed attribute-tag checking even though the call now lowers dynamically — without it, every value-import call would silently lose static attribute-tag typing, a regression decision 116 never authorized. `targetName` also falls back to `valueImportBinding` so a diagnostic on such a call still names the tag the author wrote, not "dynamic tag".

### Fix: a type-only import no longer resolves a capitalized tag (decision 114/115)

`importBindings(line)` (`core.ts`) previously returned every specifier of an
`import` statement with no check of `importKind`, so `import type Widget from
"./widget.mx"` (and `import { type Widget } from "..."`) bound `Widget` in
`ctx.imports` the same as an ordinary value import — `<Widget/>` then silently
lowered to a component call referencing a name erased before the module runs
(a runtime `ReferenceError`), instead of Marko's own "Unable to find entry
point for custom tag" compile error, on **every host**, in whole-file `.mx`.
A new `importTypeOnlyBindings(line)` identifies the type-only subset; `Ctx`
gained `imports` (now value-bindings only — every host's own `isComponent`
reads this directly, so this alone makes `@mxlang/html` and `@mxlang/solid`
correct with no host-side change) and `importedNames` (every binding
regardless of `importKind`, for the two readers that genuinely want that:
`needsAttrTagImport`'s "is `AttrTag` already imported" check, and
`exportNameFor`'s self-export collision check). A type-only import is still
emitted verbatim (`Import.code` is the statement's source text regardless of
`bindings`), so nothing an author wrote is dropped. Mirrors
`@mxlang/parser`'s `programBindings`, which already excluded the same two
shapes for `.solid.mx` region resolution; duplicated rather than shared,
since core may not depend on `@mxlang/parser`.

### Fix: a host's own wording for an unresolved *capitalized* tag, not just lowercase (decision 114)

`lower.ts`'s capitalized-tag guard now calls `ctx.declarations.rejectUnknownTag?.(name, node, ctx)` before its own fallback message (`` `<${name}>` has no matching import or `<define>` in scope; a capitalized tag is always a component call ``), the same way the lowercase-unresolved-element guard a few lines below it already did. A Marko-parity host (e.g. `@mxlang/solid`) can now report Marko's exact wording (`` Unable to find entry point for custom tag `<Name>`. ``, verified against `@marko/compiler` 5.42.5 / `marko@6.3.51`) for either case from one hook. A host supplying no `rejectUnknownTag` keeps the identical fallback message as before — not a behavior change for those hosts.

### Fix: a `<const>` binding and a `<for>`/`<define>` tag param now shadow a registered custom tag too (decision 113)

`custom-tags-local-bindings`: a file-local *scope* binding — `<const/Panel=…/>`,
a `<for|Panel|>` param, or a `<define/Box|Panel|>` param — now wins over a
registered custom tag of the same name, scoped exactly to where the binding is
in effect (outside that scope, the registered tag resolves again). Previously
only `import` and `<define>` names shadowed a custom tag
(`custom-tags-import-precedence`, decision 93); `<const>` and tag-param
bindings fell through to the custom tag unconditionally. Matches Marko
6.3.51's own rule (`normalizeTag`,
`@marko/runtime-tags/dist/translator/index.js`): a capitalized tag name backed
by a Babel scope binding is rewritten to a dynamic-tag reference before any
custom-tag/taglib lookup runs, for `const`, `for`-params, and `define`-params
alike. `lower.ts`'s `fileLocalBinding` check now also consults
`ctx.tagVarShadowed`, the existing scope-tracking set `shadowBindings`
maintains around every `<const>`/`<for>`/`<define>` body — so the fix reuses
the same mechanism the codebase already had for binding-aware identifier
rewriting, rather than adding a new one.

**Round 2 fix (review found a leak):** `scopeBindings` (`core.ts`) snapshotted
only `ctx.bindings`, not `ctx.tagVarShadowed`, so a `<const>` inside an
`<if>`/`<else>` branch — which never calls its own `shadowBindings` restore,
by design — permanently replaced `ctx.tagVarShadowed`, leaking the shadow
past the branch for the rest of the file. `lowerDefine` had the same bug
independently (no `scopeBindings` wrapper at all around its body). Both fixed
structurally: `scopeBindings` now snapshots/restores `ctx.tagVarShadowed`
too, closing the leak for every scope that already calls it (`<if>`/`<else>`
branches, `<for>`, `<define>` — now wrapped like the others, attribute-tag
`<if>` blocks, `<try>` via `lowerBlock`); no per-construct special case
needed.

### Fix: an unknown host name in `mx.tags[].hosts` is now a diagnostic, not silent (decision 110a)

`indexMxTagsEntries` (`scan.ts`) now checks each `hosts` entry against the
known host set (`html`, `astro`, `solid`, `preact`, `react`, `hono`,
`angular`) and records a diagnostic naming the offending host and the
`package.json`. The entry still indexes and the field still filters as
before; only the silent-typo case changes — `hosts: ["solidd"]` used to look
exactly like `hosts: ["solid"]` excluding every host, with nothing said.
`hosts` filtering itself (`applyHostFilter`, every scan call site passing its
own `host`) was already shipped; only the unknown-name diagnostic was
missing.

### Fix: a dynamic tag or `<define>` call now accepts arguments plus content (decision 109)

`rejectArgsWithProps` now takes Marko's own lenient rule for a dynamic
`<${expr}>` tag or a `<define>` call: the tag-argument form may combine with a
body or attribute tags (Marko's "dynamic tag fallback content"), and only a
plain attribute alongside arguments is still rejected. A named custom tag is
unaffected — Marko's own stricter rule (`assertAttributesOrSingleArg`)
continues to reject arguments combined with attributes, attribute tags, or a
body there. This closes the "MX 1 divergence to close" spec §15 note and TODO
`define-call-args-with-content`.

### Fix: callee-`Input` dependency tracking missed an unread or failed callee

`readCalleeInput` now reports a dependency for a callee it could not read
(the file does not exist yet, or exists only as an unsaved editor buffer) and
for every probed candidate path an unresolved specifier tried — an editor
retrying the same compile with `withCalleeInputSources` can now resolve
through those exact candidates instead of repeating the untyped fallback
forever. `probeFile` also checks the active source-override map, so an
unsaved buffer for a brand-new `.mx` file resolves like a saved one.

`TranslateError` gained an optional `dependencies` field: `compileSource`
now attaches every callee it resolved before a compile error was raised, so
a failing compile (e.g. "missing required attribute tag") still reports its
dependencies instead of none — previously a failed compile silently wiped a
dependency edge a prior *successful* compile of the same document had
recorded, breaking the next re-diagnosis.

### Breaking: body-only fallbacks are renderable (decision 108)

An attribute-tag property on an untyped, unresolved, or dynamic callee now
uses the bare `renderable` shape when none of its occurrences has attributes
or nested attribute tags. One such occurrence keeps the whole property
`data`; cardinality and declared `Input` shapes are unchanged. Custom-tag
transform rebuilds apply the same inference.

### Breaking: attribute-tag lowering carries declared shape and control flow

`AttributeTag`, `Component`, `HostTag`, and `Ir` gained required fields for
attribute-tag source spans, nested/control-flow trees, callee-aware property
plans, and host capability/import metadata. Hosts must consume these fields
instead of reconstructing attribute-tag shape from the flat list.

### Feature: syntactic callee `Input` resolution for attribute tags (decisions 106 and 107)

Core now exports `readCalleeInput`, which synchronously resolves a component
target and reads its exported `Input` declaration from `.mx`, TypeScript, TSX,
or JavaScript modules. It recognizes literal `AttrTag` declarations, follows
bounded same-file and type-import aliases, reports invalid configurations at
callee spans, and recursively describes nested attribute tags declared inside
`attrs`.

`CompileResult` now includes `dependencies: string[]`, containing every callee
and followed type-import file read during lowering. Integrations must use these
edges to invalidate callers when a callee's `Input` changes; the array remains
empty until lowering invokes the resolver.

Lowering now supplies authored import specifiers and discovered resolved paths
to the reader, reads the current unit's own `Input`, and uses declared callee
cardinality in end-to-end attribute-tag plans. Resolver scopes are per file;
file-qualified spans, re-exports, parse failures, missing resolution candidates,
and dependency edits participate in diagnostics and cache invalidation.

Dynamic tag calls now reject arguments combined with attributes, attribute
tags, or body content using Marko's positioned diagnostic. This prevents a
host from forwarding the arguments while silently dropping the rest of the
call shape; argument-only claimed host tags still retain their `args`.

### Breaking: an element's `on<Name>`/`on-<exact>` attribute lowers to a new `event` attr kind

An attribute on an **element** matching `/^on[A-Z-]/` **whose value is an
expression** is now lowered to an `Attr` of kind `"event"` carrying the source
spelling (`name`), the resolved DOM event name (`event`), the handler `Expr`
and a `nameSpan` — instead of the `dynamic` prop it used to be. The
attribute-method form (`onClick() { … }`) lowers to the same kind, with an
arrow-function `Expr`.

**The value has to be an expression.** A bare `<div onClick>` is HTML's
spelling of `true` and stays a `boolean` attribute; `<button
onClick="alert(1)">` is an ordinary HTML attribute string and stays `static`.
MX does not invent a policy against inline handler strings — it only stops
*creating* one from a function. (What the html host does with such a string is
phase B's decision.) `on<Name>` lowercases everything after `on`
(`onClick` → `click`, `onDblClick` → `dblclick`); `on-<exact>` is verbatim
(`on-my-event` → `my-event`). The rule is Marko's own, so an MX template and
the equivalent Marko template bind the same event, and every host now
recomposes its own spelling from one resolved name rather than re-deriving it.

**Why it is breaking for hosts:** `Attr` is a discriminated union every
emitter switches on, so a host that does not handle `"event"` no longer
type-checks. That is deliberate — the core's rule is that a host which cannot
express a kind must say so, never silently drop it. In this release every
in-tree host handles the kind with a **temporary passthrough**, so output is
unchanged on every host and oracle; each host's real emission (and its
rejections) follows in phase B.

Reproducing the old output means reproducing *which branch* the old `dynamic`
path took, not merely its most common one. On Angular that is visible: base
matched `on<Name>` against its own `EVENT_NAME` (`/^on[A-Z]/`) and routed it
through `IRREGULAR_EVENTS`/`domEventName`, while `on-<exact>` never matched
that regex (a dash is not a capital) and fell through to a plain `[name]=`
binding — so `on-my-event=f` emitted `[on-my-event]="f"`, and the passthrough
emits exactly that. The passthrough therefore keeps reading `attr.name`, not
the new `attr.event`: the two disagree precisely for `onDoubleClick`
(`dblclick` from Angular's table, `doubleclick` from core). Phase B switches
every host to `attr.event` and deletes `IRREGULAR_EVENTS`.

**Only on an element.** On a component call, a `<define>` call, a custom tag, a
host tag (`<try onClick=…>`) or an attribute tag, an `on*` attribute stays a
`dynamic` prop, because it is the callee's own prop contract rather than a DOM
event.

**Behaviour change for authors:** MX has no aliases. `onDoubleClick` lowers to
`doubleclick`, a nonexistent DOM event, and core raises a **non-rewriting**
warning positioned at the attribute name (`` `onDoubleClick` is not a DOM
event; did you mean `onDblclick` ``). Checked against `lib.dom.d.ts`, only
`onDoubleClick`, `onDragExit` and `onEncrypted` are affected; every other React
camelCase spelling already lowercases to the real DOM name. A template relying
on Preact's case-preserving custom events (`onMyEvent` → `MyEvent`) changes
meaning — it now lowercases to `myevent`, and the author must write
`on-MyEvent`.

`on:*` and `oncapture:*` are unchanged: core gives them no meaning and they
reach the host through the existing modifier hook.

### Phase B: hosts emit from the `event` kind (decision 101)

The phase-A passthroughs are replaced by each host's ruled emission,
recomposed from the one source of truth (`attr.event`, the DOM name):

- **Solid and the Preact/hono targets** emit `on` plus the capitalized DOM
  name — `click` → `onClick`, `dblclick` → `onDblclick` (capitalize-first) —
  so `onDblClick` and `on-dblclick` produce byte-identical output, and those
  runtimes lowercase the prop at bind time. **React is a lookup, not a
  derivation:** its prop names are camelCase data from react-dom's own
  registration table (`simpleEventPluginEvents`), which no rule can reverse
  (`keydown` → `onKeyDown`, `timeupdate` → `onTimeUpdate`), so the React
  target vendors the list plus the registrations outside it
  (`buildReactEventPropNames` in `packages/hosts/react/src/target.ts`,
  react-dom 19.3.0) and a drift test compares it against the installed
  react-dom. A custom DOM event a JSX
  prop cannot spell (`on-my-event`) is a uniform positioned error on all
  three naming the `ref` route, even though Preact alone could carry it.
- **Angular** emits `(${attr.event})="(handler)($event)"` for both
  `on<Name>` and `on-<exact>` — custom events bind verbatim — and maps a
  lowercase expression `onclick=fn` to `(click)`. The host's invented
  `IRREGULAR_EVENTS` table is deleted; `onDoubleClick` now emits
  `(doubleclick)` under core's warning, never a rewrite. Component `on*`
  attributes stay ordinary `[prop]` inputs (no `@Output()` inference).
- **html and astro** reject an expression-valued event attribute: an event
  handler requires a runtime, and both targets render once to a string /
  static markup. Previously html silently emitted dead inline JS. A
  *string*-valued `onclick="…"` stays an ordinary static attribute on every
  host — MX does not invent a policy against inline handler strings.
- **`on:`/`oncapture:`** are rejected on every host with a per-prefix fix-it
  naming `on-<exact>` (replacing the shared JSX emitter's wrong class-shaped
  hint and html's nonsense object suggestion).

`on-` with no event name after the dash is a positioned error (`` `on-` needs
an event name (`on-<event>`) ``) rather than a silently empty event name.

### `discoverProjectTags` reports host-module files under `tags/` as a diagnostic instead of throwing

`indexDirectory` (and therefore `scanCustomTags` and `discoverProjectTags`) now reports host-module files under `tags/` (like `.ng.mx` or `.solid.mx`) as a scan diagnostic rather than throwing, allowing the rest of the project's tags to be successfully discovered.

`indexDirectory` (shared by `scanCustomTags` and `discoverProjectTags`) used
to reject only `.solid.mx` under `tags/`; a `.ng.mx` file (the Angular host's
per-region file kind) was indexed as an ordinary tag instead, since it does
end with `.mx`. Both are now recognized as host module files — a different
file kind, not a tag template — via a small allowlist of host segments
(`solid`, `ng`), and rejected with the same generic, positioned message:
`` `<name>` is a host module file, not a tag template; tag templates are
`.mx` ``. The allowlist is deliberately closed rather than "any second dotted
segment before `.mx`", since `TAG_NAME_RE` allows dots in an ordinary tag
name and `tags/my.icon.mx` is meant to stay the valid tag `<my.icon>`. `.amx`
is unaffected either way — it carries no `.mx` suffix and is silently ignored
under `tags/`, as before.

### Breaking: a bare `${expr}` line is a dynamic tag, not a text placeholder

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped `Interpolation` whenever no host claimed `DYNAMIC_TAG`.
It now lowers the same way the tagged `<${expr} .../>` form does: a claiming
host still gets a `HostTag` (`shape: "bare"`), and an unclaiming host gets a
`Component` with `target: { kind: "dynamic", expr }` instead of a silent
interpolation — matching real Marko, which parses both shapes to the
identical `MarkoTag` node and treats an expression-named tag as a dynamic
tag (see Marko's own `error-dynamic-tag-name` fixture). Previously, lowering
a bare, unclaimed dynamic tag with attributes or a body threw `"dynamic tag
name is not supported in a standalone template"`; that error is gone — every
host now either claims the tag or emits a dynamic component. Text on its own
line still needs the escape hatch, `-- ${expr}`; a placeholder inside an
HTML-syntax body (`<div>${expr}</div>`) is unaffected, since it parses as
`MarkoPlaceholder` and never reaches this code path. See `divergences.md`
and `AGENTS.md`'s "four Marko facts" for the full history.

### `Expr` gains a file-absolute span (core contract C4)

`Expr.span?: SourceSpan` carries file-absolute byte offsets of an
expression's own authored source text, filled by `exprOf` for every
construction site (attribute values, spreads, interpolations, `<for>`
sources and keys, `<const>`/`<return>` initializers, component call
arguments) and absent only for a synthesized `Expr` or a fabricated literal
default — never a fabricated span pointing at unrelated text. Additive: no
existing field changed shape. `mapping.ts` gains `mappedExpr(expr)`, a thin
wrapper over `mapped(expr.code, expr.span ?? null)`; no host adopts it in
this change.

### `printExpression` is now a public export

`printExpression(node: Node): string` — printing a Marko-owned expression
node back to source text with the same Babel generator instance that parsed
it (`@marko/compiler/internal/babel`'s `generator`, concise mode) — was
module-private to `compile.ts`. It is now exported from `@mxlang/core`'s
public entry, so a host no longer has to carry its own copy over a
different Babel instance's generator to get the same result. Additive: no
existing export changed shape, and `newCtx`'s `generate` parameter is
unchanged — a caller still passes it explicitly. `@mxlang/solid` switched
its two `newCtx` call sites from its own `generateExpression` (over
`@babel/generator`) to this export and dropped that dependency; no output
change — `@babel/generator` and Marko's bundled generator were verified
byte-identical across the node kinds `.solid.mx` compiles through this
path.

### `Define`/`For` gain file-absolute name and param spans

`Define.nameSpan?: SourceSpan`, `Define.paramSpans?: Array<SourceSpan |
undefined>`, and `For.paramSpans?: Array<SourceSpan | undefined>` extend
C4's span convention to `<define>`'s own name and params and a `<for>`'s
params — the file-absolute byte offsets every other source-derived IR run
already carried, filled at `lowerDefine`/`lowerFor` and `undefined` only for
a param or name node with no authored `loc`. Additive: no existing field
changed shape, no emitter change required.

### `mx.tags[].hosts` now filters discovery

`getCustomTags`/`scanCached`/`scanCustomTags` accept an optional `host` in
their options (`"html"`, `"astro"`, `"solid"`, `"preact"`, `"react"`,
`"hono"`, `"angular"`). A `DiscoveredTag` now carries `hosts` from the
`mx.tags` entry that declared it, and a tag whose `hosts` excludes the
passed-in `host` is left out of both `ScanResult.tags` and `customTags`
entirely. No `hosts` on the entry (or no `mx.tags` entry at all, as with
every local `tags/` directory) means visible to every host. Every built-in
integration now passes its own host name when it scans.

`@mxlang/preact`'s `export { getCustomTags } from "@mxlang/core"` is a
passthrough for `@mxlang/react` and `@mxlang/hono`'s Bun loaders to call with
*their own* host name (`"react"`, `"hono"`) — it is not itself a call site
and stays unhosted by design, the same as importing `getCustomTags` directly
from `@mxlang/core`. `mx-tsc` is covered transitively: it runs the same
language plugin as the tsserver plugin (`@mxlang/typescript-plugin`), whose
`mx-language.ts`/`language.ts`/`amx-language.ts` call sites already resolve
and pass a host (see above).

### `discoverProjectTags`: project-wide tag enumeration

`discoverProjectTags(projectDir, options?)` enumerates every tag reachable
inside a project — every `tags/` directory found walking down from the
root, plus the root `package.json`'s `mx.tags` entries — the counterpart to
`scanCustomTags`'s single-file upward walk. Excludes `node_modules`,
dotdirectories, and nested packages. Accepts the same `host` filter.

The walk follows symlinked directories (a symlinked `tags/` directory is
discovered, and any directory reached only through a symlink is walked into
normally), guarded against symlink cycles so a self-referential link cannot
recurse forever.

### Tolerant, cached `package.json` reads

A broken `package.json` no longer silently drops `mx.tags`: the previous
good manifest stays in force, and one positioned diagnostic is reported per
broken revision (not per scan). Manifest reads are now cached by path and
mtime.

### TypeScript 6.0.3, and `typescript` as a peer dependency

The repo builds and typechecks on `typescript@6.0.3` (from `5.9.3`).

`@mxlang/tsc` and `@mxlang/typescript-plugin` now declare
`peerDependencies.typescript: ">=5.9.0 <7"` instead of an exact pin. TypeScript
must come from the consumer's project: the TS plugin is handed the `ts` object by
tsserver and `mx-tsc` passes `require('typescript')` to Volar's `runTsc`, so a
second nested copy breaks `instanceof` across that boundary. Both keep an exact
`devDependencies.typescript` so CI stays pinned.

`@mxlang/language-server` declares no `typescript` peer. It has no reference to
`typescript` in its source at all — TypeScript is only its build tool, emitting
`dist/*.d.ts` — so it keeps an exact `devDependencies.typescript` and nothing
else, rather than making consumers resolve a module it never loads.

The bump itself needed one source change: `packages/hosts/angular`'s
`tsconfig.build.json` now sets `rootDir: "src"` explicitly. TS 6 no longer
infers a common source directory when a build config and its base config
disagree about it (`TS5011`). No other package was affected, no deprecation
warning was reported anywhere in the build, typecheck, test or oracle runs, and
emitted `.d.ts` output is unchanged. The full TS 6 findings — and what they do
and do not imply for TS 7 — are in `notes/investigations/ts7-go-impact.md` §7.

### `<return>` and `/var`: a tag hands one value back (decision 95)

A template may end with `<return value=EXPR/>`, and a caller binds that value
with `/var`:

```marko
<!-- tags/counter.mx -->
<span>${input.start}</span>
<return value=input.start + 1/>
```

```marko
<counter/next start=41/>
<p>${next}</p>
```

- **`<return>` is value only.** Marko also accepts `valueChange`; MX 1 ships no
  two-way channel, so that attribute is rejected by name rather than accepted
  and dropped.
- **At most one per template, at the top level only.** Not inside a native tag,
  `<if>`/`<else>`, `<for>`, an attribute tag or a `<define>`. A returning tag
  returns unconditionally, which is what makes its signature a single shape
  rather than `T | undefined` per path — and because a unit compiles without
  seeing any of its callers, no call site can widen it. The grammar is Marko's,
  ported from its own `<return>` translator with MX wording; all eleven of its
  compile-time error fixtures have a counterpart test.
- **`<return>` in a page is legal** and means the same thing: a page is a module
  that returns a value nobody reads yet. It used to be a hard error on the html
  and JSX hosts, on the grounds that a compiled template "has no parent to
  return to" — true only while a tag was expanded into its caller.
- **breaking:** a unit that declares `<return>` changes its export shape. On
  html and the JSX hosts the default export returns `{ value, output }` rather
  than the output alone; on Solid the value comes back through a generated
  callback prop, because a Solid component's return value is its view. A unit
  with no `<return>` is unchanged. Astro renders an MX component through its
  own renderer, which unwraps the pair there.
- **`/var` is top-level-only on the JSX hosts and Solid.** Those targets lower
  `<if>` and `<for>` to *expressions* — a ternary, a `.map` callback, a `<For>`
  render prop — so a callback scope has no statement position to hold the
  binding, and hoisting the call out of it would read bindings that do not
  exist there and run once for a body rendered N times. Writing one there is a
  positioned error naming the tag; the call itself, without `/var`, works
  everywhere. html and Astro `.mx` support the nested case. Lifting the
  restriction is MX 2 work.
- **`/var` is not supported in a `.amx` file**, which has no statement position
  of its own; a `.amx` template may still *call* a returning tag and render its
  output.
- **A returning unit on a JSX host may not import hooks.** It is invoked as a
  plain function rather than mounted, so Preact's and React's hook dispatchers
  would bind its hooks to the *calling* component's hook list: order-dependent,
  broken under a conditional or looped call, and `useContext` reading the
  caller's position in the tree. Importing a `use*` binding from
  `preact/hooks`, `preact/compat`, `react` or `hono/jsx` into a unit that
  declares `<return>` is a compile error. Solid is unaffected — its callback
  prop keeps the unit a real component.
- **The Solid binding is one-shot, not reactive.** It holds the value from the
  single invocation that produced it, which matches `/var`'s meaning on every
  other host — but a Solid author may reasonably expect a signal, so a tag
  wanting reactivity should return an accessor for the caller to call.
- **The binding's type is the `<return>` expression's inferred type**, and a
  wrong prop at a discovered tag's call site is a TypeScript error at the
  caller's own position, through the tag's `export interface Input`.
- Three positioned diagnostics replace what would otherwise be `undefined` or a
  run-time crash: `/var` on a tag whose template has no `<return>`; a `/var`
  read outside its declaring block (MX rejects the escape rather than hoisting
  the binding into a getter as Marko does, which would change its type); and a
  read before the call that binds it.

### A custom tag's template is a compilation unit (decision 95)

A discovered template tag (`tags/icon.mx`) is no longer expanded into its
caller. It compiles through the same per-file pipeline a page uses, into a
module, and the caller emits an injected `import` plus an ordinary component
call — the shape an explicitly imported tag already produced on all six hosts.

- **breaking:** **a tag's `static` block now runs once per _process_, not once
  per calling module.** Its statements live in the tag's own module and are
  evaluated at import time, which is the module system's rule and Marko's own
  model. This is observable for any tag whose `static` block has side effects
  (a counter, a registration, an allocation): previously each calling module
  re-ran it, and now the first import does. A tag that needs per-call work
  should do it in the template body rather than in `static`.
- **breaking:** a template's `import`s no longer hoist into the caller's
  module, so the "same local name from a different module" error is gone along
  with the merge that raised it.
- **added:** `input` is a real parameter rather than a substituted name. A
  template may read an attribute any number of times (the caller's expression
  is evaluated once, at the call), accept a spread, use `input` as a value, or
  destructure it — every limit the substitution engine carried is gone.
- **added:** a tag file may export anything, and its `export interface Input`
  is now the tag's public type, typing the call site through the import.
- **added:** a tag may call itself; a module importing itself is legal ESM, so
  recursion terminates on the tag's data rather than on a compiler depth cap.
  **Mutual and self cycles between tag templates are now legal** rather than a
  compile error naming the path: two templates that call each other are an
  ordinary module cycle, and the unit mid-compile is recorded as `pending` so
  the metadata lookup terminates. Deliberate — the cycle detector existed only
  because inlining could not terminate.
- **added:** `parseOptions.openTagOnly` with a body is a positioned MX error at
  the call site (`` `<x>`: does not accept content ``) rather than a Marko
  parse error; `<@content>` on a tag call is rejected.
- **added:** compiling a tag unit caches `{ readsContent, attributeTags }`, so
  a body passed to a tag that never reads `input.content` still warns at the
  call site — MX's improvement over Marko, preserved across the rewrite.
- **removed:** the template expansion engine — `input` substitution, hygiene
  renaming, caller-side import/static merging, the expansion depth and node
  caps, and the template cycle detector. A tag being a separate module makes
  each of them unnecessary rather than merely unused.
- **fixed:** a discovered tag whose template contains a `static` block no
  longer crashes the compiler with `unexpected module-level node kind "Static"
  in the body walk`.
- **added:** `Import` carries `synthesized`, plus `specifier` and
  `resolvedPath`, set only on an import the compiler minted for a discovered
  tag. They exist for one host: a `.solid.mx` MX region is an *expression* with
  no module scope of its own, so `@mxlang/solid` now splits its
  module-level-statement rejection by **origin** rather than by kind. An
  authored `import`/`static`/`export` inside a region is still the same error;
  a synthesized one is returned on `CompileSolidMxResult.hoistedImports`, and
  `@mxlang/parser` writes it into the surrounding TypeScript module — once per
  **resolved path**, reusing the module's own authored default import of the
  same file when present, and never reusing a *type-only* import (it binds no
  runtime value) or one shadowed by a scope enclosing the region (the reused
  name would resolve to the shadow). This closes the last `oracle:custom-tags`
  skip: the gate is
  **24/24 with none recorded**. Every other host emits both kinds identically
  and ignores the flag.
- **breaking:** **every emitted module's default export is now named after its
  file** — `icon.mx` emits `export default function Icon(…)`, `table-of.mx`
  emits `TableOf` — on html, the shared preact/react/hono emitter, and
  `compileSolidUnit`. `Ir.exportName` carries the derived name, re-minted if it
  collides with anything the file already binds. This is observable for any
  consumer that matched the compiled module's export line as *text*: the
  name varies per file now, so a matcher must read it back rather than pin
  `render`. Four in-tree matchers were updated accordingly.
- **added:** **a self-recursive tag calls its own export, with no self-import**
  (design invariant §7.5-7). When a discovered tag's resolved path is the file
  being compiled, the caller emits a call to the module's own named
  declaration rather than `import $mx_Tree1 from "./tree.mx"`. Importing a
  file into itself is legal ESM and did work, but it is a module importing a
  binding it already has. The `tree` oracle fixture covers it on all six
  hosts, three levels deep.
- **added:** `@mxlang/solid` gains `compileSolidUnit`, a whole-file entry point
  beside the region entry point `compileSolidMx`. A tag unit is a file, so its
  module-level statements are placed rather than rejected. It **silently drops
  `export interface Input`** rather than emitting it — Solid's compiler takes
  source text and has no TypeScript frontend, so a type declaration there is a
  downstream syntax error. This is deliberate and pinned by a test, but it is
  an asymmetry worth knowing: the region path *errors* on an authored
  `export interface Input` while the unit path accepts and ignores it. Typing a
  unit's props is phase 3, through the same virtual-file projection the
  TypeScript plugin already does for `.solid.mx`.

- **Fix (marko-parity-trio, `<for>` `by=`/`key=`):** a **string** `by=` outside `of=` and a `key=` on `<for>` are compile errors now, matching Marko 6.3.51 (`runtime-tags/src/translator/core/for.ts`), which refused both and MX accepted both in silence — the S8 silent-drop class, because a `<for>` reads nothing under either name. The string `by` is reported at the quoted key it refuses, with the fix-it for that loop's form (`by=(key, value) => …` for `in`, `by=(index) => …` for `to`/`until`); `key=` is reported at the attribute, before the string check, with Marko's `by=` redirect. `by="id"` on `of=` keeps working on every host, including Angular's `track p.id`.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` is accepted, with Marko's own meaning. Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute name at its last `:` and fills an empty head with `value`, so this is one attribute literally named `value:foo`, which Marko compiles and renders as `<div value:foo=y>` — while every *other* modifier (`class:active`) is refused by Marko's taglib and still is here. Both spellings (`:foo` and `value:foo`) are the same attribute, and a valueless one (`:foo`) lowers to the empty string rather than to `true`, because HTML's valueless attribute is an attribute present with an empty value (React drops a `true` here with a non-boolean-attribute warning; Hono writes `"true"`). No host hook sees this form any more: it takes the ordinary attribute path, so each host emits the name in its own vocabulary.

- **Fix (marko-parity-trio, tag-argument position):** a "tag arguments `(...)`" diagnostic is reported at the **argument**, not at the tag. Marko points at `args[0]` (`assertNoArgs`), so `<button (click)="go()">` is reported under `click`; MX pointed at `<button`, one token left of the thing the error is about. The structured `line`/`column` stay 0-based (ruling #227), so this is a 1-based column of 7 for that source. The message and the `onClick=` fix-it are unchanged.
