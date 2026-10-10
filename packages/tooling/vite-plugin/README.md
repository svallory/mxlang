# @mxlang/vite-plugin

The primary MX integration for [Vite](https://vite.dev): an `enforce: "pre"`
plugin that compiles `.mx` and `.solid.mx` before the rest of the pipeline.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import mx from "@mxlang/vite-plugin";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [mx(), solid()],
});
```

`mx()` must come first: both plugins are `pre`-enforced, so their relative
order is their order in `plugins`. It handles `.mx` (whole-file templates,
compiled for the target its nearest `package.json` selects) and `.solid.mx`
(printed to JSX source text for the Solid compiler).

## Requirements

Vite is a peer dependency, and the plugin's own types re-export Vite's
`Plugin`, so a TypeScript consumer also needs `@types/node` and an `esnext`
library (`lib: ["esnext", "dom"]`) — Vite's declarations use
`Symbol.asyncDispose`.

The plugin bundles every built-in target's compiler, but not the runtime the
compiled modules import. A module compiled for the `html` target imports its
helpers from `@mxlang/target-html` (`import { escape } from "@mxlang/target-html"`), resolved
from your project, so a project using that target installs `@mxlang/target-html`;
the JSX targets import their framework (`preact`, `react`, `hono`, `solid-js`).

See `AGENTS.md` for the plugin's internals and target dispatch.