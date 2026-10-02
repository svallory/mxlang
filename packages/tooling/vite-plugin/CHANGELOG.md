# @mxlang/vite-plugin

## 0.1.0 (unreleased)

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
