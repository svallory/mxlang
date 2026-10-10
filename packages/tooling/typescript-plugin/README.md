# `@mxlang/typescript-plugin`

A [Volar](https://volarjs.dev) language plugin and tsserver plugin that types
`.solid.mx`, whole-file `.mx`, plus AstroMX `.astro.mx`
when Astro composition is enabled. Editors report errors inside templates and
type imports from the file's real exported `Input` interface.

This is the editor half of decision 81. The CI half is
[`@mxlang/tsc`](../tsc/README.md), which hands the *same* language plugin to
Volar's `runTsc` — one lowering, so an editor and a build cannot disagree about
whether a file compiles.

## What it does

| Source file | Enabled by | Virtual service script |
| --- | --- | --- |
| `.solid.mx` | always | Solid JSX as TSX |
| `.mx` | always | host-selected generated TypeScript |
| `.astro` | `astro: true` | Astro's TSX |
| `.astro.mx` | `astro: true` | MX-to-Astro output composed into Astro's TSX |

`createSolidMxLanguagePlugin(ts)` builds a `LanguagePlugin<string>`:

- `getLanguageId` reports `solidmx` for any `*.solid.mx` path.
- `createVirtualCode` runs `@mxlang/tsx-bridge`'s `print(source, filename)` and
  wraps the printed TSX in a `VirtualCode` whose `CodeMapping`s are decoded
  from the returned source map, with `verification`, `completion`, `semantic`
  and `navigation` all enabled.
- `typescript.extraFileExtensions` declares `solid.mx` as
  `{ isMixedContent: false, scriptKind: TSX }`, and `getServiceScript` serves
  the virtual code as `.tsx`.

`createMxLanguagePlugin(ts)` does the same job for whole-file `.mx`
templates. It resolves the host with `@mxlang/core`'s
`resolveTargetPolicy` — the same resolver `@mxlang/language-server` uses, so an
editor, this plugin and a `tsc` run cannot disagree about which host owns a
file — applying the nearest `package.json`'s `mx.host` (`html`, `astro`, or
`solid`; default `html`) and strictness, then serves the compiled module as
TypeScript. Astro always uses strict HTML lowering and projects MX's runtime
`content` slot as JSX `children` at the type boundary.

`createAmxLanguagePlugin(ts)` lowers the MX template half with
`@mxlang/host-astro`, passes that Astro text to
`@astrojs/compiler/sync`'s `convertToTSX`, and composes the two maps into one
set of Volar `CodeMapping`s. It is registered only with `astro: true`; without
Astro composition this plugin deliberately ignores `.astro.mx` files.

When `print` throws — a syntax error in an MX region, raised by the parser
bridge with a `loc` — the virtual code is empty and the error is recorded
instead. The tsserver plugin appends it to `getSyntacticDiagnostics` so it
shows up exactly once, at its own position, in the editor's normal diagnostics
list rather than as a silent empty file.

`createCompoundExtensionResolver(ts)` is a second, deliberately inert plugin:
it claims no file (`getLanguageId` and `getServiceScript` both return
undefined) and exists only to advertise the terminal `mx` suffix. Volar 2.4.28
assumes a custom extension is a single suffix, so for `X.solid.mx` TypeScript
probes `X.solid.d.mx.ts`; without the extra extension that probe fails and
every `import "./X.solid.mx"` is `TS2307`. Both this package and `@mxlang/tsc`
install it, so an editor and CI resolve imports identically.

## Mapping accuracy

Diagnostics land on the exact source column, not the start of the region. For
`.solid.mx`, the printer's map is line-based, so columns come from the bridge
repositioning each Babel node onto the source expression it was copied from
(`packages/tsx-bridge/src/mx/bridge.ts`). `decodeMappings` then turns that map into
`CodeMapping`s, keeping only spans whose generated and source text actually
match and merging contiguous ones.

The HTML compiler's map is currently an empty placeholder. Whole-file `.mx`
mappings therefore come from the positioned nodes in the core IR that the HTML
emitter already consumes; unchanged code text is mapped directly into the
generated TypeScript.

AstroMX mapping is two-stage. The `.astro.mx` emitter records the unchanged fence,
each emitted expression and attribute name at write time, tag params, and
whole hoisted blocks. Those offsets are intersected with the source map from
Astro's `convertToTSX`; only text represented by both maps is exposed to
Volar. No generated-text search is used on this path.

A type error inside an MX attribute expression therefore reports where the
expression is:

```tsx
export const el = <button onClick() { setCount(count() + "x") }>x</button>;
//                                             ~~~~~~~~~~~~~
// TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

### What is mapped, and what happens when something is not

Whole-file `.mx` mapping covers two shapes:

- **Per expression**, exactly. Every `Expr` in the IR carries its original
  Babel node, so a placeholder, an attribute value, an `<if>` condition, a
  `<for>` iterable and a tag-param use each map to their own source span.
- **Per whole block**, for the five IR kinds whose code is a statement rather
  than an expression: `Static` (a `static`/`server` block), `Import`,
  `Export`, `InputInterface` (`export interface Input`) and `Hoisted` (a
  statement a host hook lifted). Each maps as one span covering the
  statement's own source range, so a diagnostic inside it lands within the
  author's own line instead of being dropped. TypeScript still anchors an
  error where it normally would — for `static const n: number = "x"` that is
  the declaration name `n`, not the initializer.

A mapping is emitted only when the code is located in both texts: the source
span must contain the code, and the generated text must still contain it (the
search runs forward, keyed per code string, so repeated text cannot cross-map
onto an earlier occurrence). When either lookup fails, **no mapping is
emitted** — deliberately, because mapping to a plausible-but-wrong column is
worse than not mapping. A diagnostic falling outside every mapping is not
surfaced against the `.mx` file, so an emitted construct that needs positions
must carry them in the IR rather than rely on a text search.

MX syntax errors are separate: `compile` throwing produces one positioned
syntax diagnostic (see above), not a mapping.

### Component tag and attribute names

A wrong prop passed to a component from inside a `.mx` file is a TypeScript
error at the attribute, not at the opening tag or the whole call. Every
emitter records where it writes a component's tag name, each attribute name,
and each `<@name>` attribute-tag name, so those spans map back into the
source the same way an expression does:

| Host             | Tag name maps to           | Attribute name maps to          |
| ---------------- | --------------------------- | -------------------------------- |
| HTML (`@mxlang/target-html`) | the call target (`Card(...)`) | the props object literal's key (`{ title: ... }`) |
| Preact / React   | the JSX opening tag (`<Card`) | the JSX attribute name (`title={...}`) |
| Solid            | the JSX opening tag (`<Card`) | the JSX attribute name (`title={...}`) |

This is what lets `<Card title=1>` report `TS2322` at `title`, and
`<Card nope="x">` report `TS2353` at `nope`. A missing required prop has no
attribute of its own to anchor to: TypeScript reports that against the call's
argument (the props object literal or, for JSX, the tag itself), so the HTML
host's empty `{ }` argument falls back to mapping the whole literal to the
tag name span — the same place JSX already anchors it — rather than being
dropped as unmapped generated text.

## Using it

Add it to a project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

That is enough for an editor whose TypeScript integration honours
`compilerOptions.plugins`. No ambient `declare module "*.solid.mx"` shim is
needed — and adding one is actively harmful, since it replaces each file's real
exported types with whatever the shim asserts. `examples/counter-app` and
`examples/todomvc` both dropped theirs.

The same rule applies to `*.mx`: do not add a wildcard shim.

### Astro projects

Astro and MX both use Volar. Two separate Volar tsserver plugins cannot
decorate the same project: whichever initializes second is silently skipped.
List only the MX plugin and ask it to compose Astro's language plugin:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@mxlang/typescript-plugin", "astro": true }
    ]
  }
}
```

Do not also list `@astrojs/ts-plugin`. Astro composition lazily loads the
optional peer `@astrojs/language-server@2.16.16`; a project that enables
`astro: true` must install that package beside this plugin.

Two behaviours of the composed Astro plugin are worth knowing:

- **`.astro.mx` is opt-in with Astro composition.** Its frontmatter, component
  props, and template expressions are checked through the composed map. With
  `astro: false` (the default), `.astro.mx` is not claimed.

- **`.astro` files under `node_modules` are associated-only.** They are
  Astro's own package-owned component sources, not the consumer's code, so
  they stay resolvable for imports while `mx-tsc` does not report diagnostics
  for files the consumer cannot edit. The check normalizes Windows separators
  before testing for the `/node_modules/` segment, so both path styles behave
  the same.
- **`children` is offered only where there is a slot.** An Astro-hosted `.mx`
  component's projected type replaces `content` with JSX's `children` only
  when its `Input` actually declares `content`. A component with no content
  slot keeps its `Input` unchanged, so passing children to it is a type error
  rather than silently accepted and dropped at runtime.

`tsc` itself ignores `plugins`, so a command-line typecheck needs
[`@mxlang/tsc`](../tsc/README.md)'s `mx-tsc` instead.

### Zed

Zed's TypeScript support runs `vtsls`. Register the plugin globally:

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "typescript": {
            "globalPlugins": [
              {
                "name": "@mxlang/typescript-plugin",
                "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
                "languages": ["solid", "mx", "astro", "astromx"],
                "enableForWorkspaceTypeScriptVersions": true
              }
            ]
          }
        }
      }
    }
  }
}
```

Language ids are lowercase. `vtsls` matches this array against the
LSP language id, not against the name in Zed's language config. Zed derives
that id by lowercasing the language's name — `LanguageName::lsp_id()` in
`crates/language_core/src/language_name.rs` is
`match self.0.as_ref() { "Plain Text" => "plaintext", name => name.to_lowercase() }`
— so the `Solid` language declared in
`packages/editors/zed/languages/solid/config.toml` is sent over LSP as
`solid`. That differs from the `solidmx` string this plugin's
`SOLID_MX_LANGUAGE_ID` uses, and the two are independent: `vtsls` never sees
the plugin's constant.

With `typescript-language-server` instead of `vtsls`, the equivalent is its
`plugins` array:

```json
{
  "lsp": {
    "typescript-language-server": {
      "initialization_options": {
        "plugins": [
          {
            "name": "@mxlang/typescript-plugin",
            "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
            "languages": ["solid", "mx", "astro", "astromx"]
          }
        ]
      }
    }
  }
}
```

### VS Code

VS Code reads `compilerOptions.plugins` from the workspace `tsconfig.json`
automatically, but only for the workspace TypeScript version. To load the
plugin regardless, point at it explicitly:

```json
{
  "typescript.tsserver.pluginPaths": ["./node_modules/@mxlang/typescript-plugin"]
}
```

A dedicated extension would instead contribute it from its own `package.json`,
which is the form that needs no user setting at all:

```json
{
  "contributes": {
    "typescriptServerPlugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

No such extension ships from this repo yet.

## Relationship to `@mxlang/language-server`

They do not overlap. `@mxlang/language-server` diagnoses whole-file `.mx`
templates against a host policy and has no `.solid.mx` document path;
this plugin lives inside tsserver and does only TypeScript. Both can be
registered against the same file kind — that is how ESLint and TypeScript
coexist in one editor.

## Tests

`src/index.test.ts` drives a real `ts.LanguageService` built over the plugin:
the Solid, whole-file MX, and AstroMX virtual-code shapes, IR-backed and
composed mapping accuracy, syntax diagnostics, host resolution, import typing,
and optional Astro composition (enabled, disabled, and missing-peer cases).

```
bunx vitest run --root ../../.. --project @mxlang/typescript-plugin
```
