# @mxlang/vite-plugin

## 0.1.0 (unreleased)

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
