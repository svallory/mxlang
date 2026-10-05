// `@solidjs/babel-plugin` has no pinned `@types/*` entry in this repo (see
// packages/oracle/src/ambient.d.ts for the same situation with it and
// `@babel/preset-typescript`); it is used only from control.test.ts, so the
// shape only needs to cover that usage.
//
// `@babel/generator` deliberately has no stub here. An ambient
// `declare module` is program-global, not file-local, so a minimal stub would
// override the real `@types/babel__generator` (pinned at the root) for every
// file in this package — including `print.ts`, which needs the full
// `generate(ast, opts)` signature and the `map` it returns.

declare module "@solidjs/babel-plugin" {
  import type { PluginItem } from "@babel/core";

  const plugin: (
    api: unknown,
    options?: Record<string, unknown>,
  ) => { plugins?: PluginItem[]; presets?: PluginItem[] };
  export default plugin;
}
