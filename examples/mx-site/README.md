# mx-site

A demo of `@mxlang/html` — `.mx` templates compiled to
string-returning TypeScript modules, served two ways: a real Hono-on-Bun
server, and a static build. No client runtime, no Solid; both targets render
the exact same `src/pages/*.mx` templates, imported directly via
`@mxlang/html/bun`'s Bun loader (see `bunfig.toml`).

## What it demonstrates

| route | exercises |
|---|---|
| `/` | the shared layout via ordinary children (`input.content`), a partial via `import`, `<!doctype html>`, head/meta |
| `/list` | `<for>` over a collection (index form and a plain-object form), `<if>`/`<else>` for the empty-state case, `<const>` |
| `/form` | static, dynamic, boolean and spread attributes; escaping of user-supplied `<`, `&`, `"`, `'` |
| `/mixins` | `<define>` with args called more than once, and a `<define>` taking a block |
| `/raw` | `$!{}` raw output beside `${}` escaped output on the same data |

Every page is wrapped in `src/pages/layout.mx`, so the layout/partial
pattern runs on every route, not just `/`.

Every component tag in this app is capitalized (`<Layout>`, `<Callout>`), but
that is a style choice, not a requirement: dispatch is by whether the tag name
matches an in-scope binding — an `import`, a `<define>`, or a tag Marko
discovered via `tags/` — not by the tag name's first character.

## Running it

```
bun run dev     # Hono on Bun, http://localhost:5173
bun run build   # writes dist/*.html
bun run e2e     # Playwright against both the dev server and dist/
```

`bun run e2e` needs `bunx playwright install chromium` once.

## A tsconfig quirk this example works around

`packages/targets/html/tsconfig.json` maps `@mxlang/parser` to
`../parser/src/public.d.ts` in its `paths` for typechecking. Bun's `bun
run` also honours `tsconfig.json` `paths` at runtime, and it resolves that
mapping for *any* file under `packages/targets/html/`, regardless of which
script is the entry point — so a plain `bun run` of anything that imports
`@mxlang/html` fails with `Export named 'X' not found in module
".../public.d.ts"` (a `.d.ts` has no runtime exports). This example's `dev`
and `build` scripts route around it with `bun run
--tsconfig-override=../../tsconfig.base.json`, which points Bun at a
tsconfig with no such `paths`.
