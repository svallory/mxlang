# @mxlang/vite-plugin

## 0.1.0 (unreleased)

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
  - A syntax error inside a tag file is reported at the tag (`…/tags/bad.marko.tsx:1:15`), compact, like any other compile error (see audit-03 below).

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
