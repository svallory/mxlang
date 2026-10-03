# Body whitespace parity — decision 141

This shared matrix lives outside root `fixtures/`: that directory is reserved
for Solid oracle pairs, and the parser's vendored-equivalence suite requires
`input.solid.mx` / `twin.tsx` in each child directory.

`cases.json` records the exact body HTML rendered by **Marko 6.3.51**, through
`<wrap>BODY</wrap>` and a discovered `tags/wrap.marko` containing
`<section><${input.content}/></section>`. The enclosing `<section>` is added
by each test. The seven hosts execute their native renderers for both imported
components and discovered `tags/*.mx`; core also tests the normalized AST and
the data target tests its pass-through/structural-reject paths.

## Source rule

Marko's `packages/compiler/src/babel-plugin/parser.js`, `onText`:

- Drops `/^(?:[\n\r]\s*)?(?:[\n\r]\s*)?$/` before creating a text node.
- Ignores comments when locating neighboring content.
- Removes leading `/^[\n\r]\s*/` or trailing `/[\n\r]\s*$/` at body
  boundaries, with additional adjacency handling for text, placeholders,
  statement tags and attribute tags.
- Sets `node.value = value.replace(/\s+/g, " ")`, removing empty nodes.
- Bypasses those rules when the tag's parse options preserve whitespace.

Therefore same-line tabs/spaces become one space; LF/CR/CRLF followed by
indentation disappear. **`" \n "` is not the latter case**: the initial space
precedes the newline, so one space remains. Comments alone supply no body;
comments next to retained whitespace do not remove its space.

Core must test that already-normalized value for **nonemptiness**, not trim
or normalize it again. The fixture includes element/mixed controls to catch
accidental regressions in body forwarding, not only whitespace handling.

## Native renderer paths

- HTML: `loadMx` executes the compiled caller and wrapper.
- Preact / React / Hono: compile to TSX and SSR with the host's own runtime.
- Solid: whole-file wrapper plus imported/discovered region caller, Solid
  Babel SSR codegen, then `renderToString` in Bun.
- Astro: `.mx` uses the strict HTML compiler and the MX server renderer,
  executed inside an Astro compiler/container component.
- Angular: compile real tag modules in a Bun subprocess (Node resolution
  conditions), erase TypeScript/decorators, then render with Angular TestBed
  under its **default** whitespace policy. Only Angular comment anchors are
  removed from the exact `innerHTML` comparison; component host elements stay.
