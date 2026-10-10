---
title: "Configuration"
description: "MX's config file: where MX looks for it, what it holds, and how tools pick up an edit."
---

# Configuration

MX reads every project setting from one place: **MX's config**. It is
optional. A project with no config compiles under MX's defaults (the target
comes from the project's `@mxlang/*` dependency, or `html`).

```ts
// mx.config.ts
export default {
  target: "solid-jsx",
  strict: true,
  tags: "./src/ui",
};
```

The same settings can live in `package.json` under `mx`, which is one valid
location among several:

```json
{
  "name": "app",
  "mx": { "target": "solid-jsx", "strict": true, "tags": "./src/ui" }
}
```

The rest of the docs write a setting as `mx.<key>` (`mx.target`, `mx.tags`):
that is the `<key>` of MX's config, wherever the config lives.

## Where MX looks

One file serves the whole project and every dialect in it. MX finds the
project first: the nearest directory, from the file being compiled upward,
that holds a `package.json`. It then checks these places in that directory
only, in this order, and the first one that holds a config wins:

1. `package.json`, under the `mx` key
2. `.mxrc` (YAML or JSON)
3. `.mxrc.json`, `.mxrc.yaml`, `.mxrc.yml`, `.mxrc.js`, `.mxrc.ts`, `.mxrc.cjs`, `.mxrc.mjs`
4. the same names under `.config/`: `.config/mxrc`, `.config/mxrc.json`, …
5. `mx.config.js`, `mx.config.ts`, `mx.config.cjs`, `mx.config.mjs`,
   `mx.config.mts`, `mx.config.cts`, `mx.config.json`, `mx.config.yaml`,
   `mx.config.yml`

These are [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)'s places
for the name `mx`, and MX loads the file with it. A config file in a
subdirectory of the project is never read, and neither is one above the
project's `package.json`, so the editor, the TypeScript plugin, `mx-tsc`, the
Vite plugin and the Angular host all resolve the same config for every file.
A file with no `package.json` above it has no project and compiles under the
defaults. Two configs are never merged.

When more than one place holds a config, the first wins and MX warns at each
file it does not read (`shadowed-config`), saying which file is in force. So a
`package.json` with an `mx` key wins over an `mx.config.ts` next to it, and the
`mx.config.ts` gets the warning. A package in a monorepo has its own
`package.json`, so it is its own project with its own config.

cosmiconfig's own extras do not apply: MX ignores a cosmiconfig meta config
(`.config/config.json` with a `cosmiconfig` key), and a file pulled in through
`$import` is read but not watched, so an edit to it applies only once the
config file itself changes or a tool restarts.

Relative paths in the config (`tags`, `contracts`, a target package
path) resolve from the directory the config belongs to: the config file's own
directory, or for a file under `.config/`, the directory that holds `.config/`.

## What it holds

| Key | What it sets |
| --- | --- |
| `target` | The target the project compiles to (`html`, `solid-jsx`, `react-jsx`, …, or a target package). See [Host and target selection](/specification/#the-mx-language-13-host-semantics-table-135-host-and-target-selection). |
| `host` | A host, which selects its default target. `host` and `target` are read the same way in every format; if both are set they must agree. |
| `strict` | The strict policy for the selected target. |
| `tags` | Extra tag directories. See [Discovery](/custom-tags/discovery/). |
| `contracts` | Contract modules. See [Writing a dialect package](/custom-tags/dialect-package/). |
| `<target>` | A target's own settings, such as `html: { defaultTag: "section" }`. |
| `angular` | The Angular host's settings. See [Angular](/hosts/angular/). |
| `extensions` | Which dialect compiles which file extension, such as `{ ".mesh": "mesh" }`. See "Dialect packages and routing" (§13.9.2) in the [specification](/specification/). |
| `<dialect id>` | A dialect's own settings, under its id. MX hands them to the dialect without reading them. |

`dialect` is not a setting. It is a dialect package's identity block in that
package's own `package.json` (see [Writing a dialect package](/custom-tags/dialect-package/)),
and MX's config never reads it, in any format. A `package.json` whose `mx`
holds only `dialect` has no MX config, so an `mx.config.*` beside it applies.

## Formats

JSON, YAML and `package.json` are parsed by MX. A JavaScript or TypeScript
config (`.js`, `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`) is loaded as a module,
and its default export is the config. MX reads its config synchronously, so
that the editor, the TypeScript plugin, `mx-tsc` and the build all see the
same settings at the same moment. That needs:

- Node 22.12 or later, or Bun, for an ES module config (`.mjs`, or ESM syntax
  in `.js`).
- Node 22.18 or later, or Bun, for a TypeScript config.
- No top-level `await` in a module config.
- A default export that is the config object itself, not a function or a
  promise.

A config that misses one of these is reported as an error at the config file
saying which, and its settings are not applied. Use JSON, YAML or CommonJS on
an older Node. A module config's relative imports follow Node's ES module
rules, so they name the file extension (`./shared.ts`, not `./shared`); MX's
error says which file it meant.

A config that parses but is not an object (a JSON array, a YAML scalar, a
module that exports a function) is an error too, at the start of the file.

## Editing the config while tools run

The language server, the Vite plugin and the Angular watcher pick up an edit
to the config, or a config file created or deleted, on their next compile;
nothing needs a restart.

While an edit leaves the config unreadable (a JSON or YAML syntax error, a
module that throws), the last revision that loaded stays in force and the
problem is reported as an error at the position in the config file. A config
that has never loaded applies nothing until it does.

On Node, a process that has loaded an ES module config (`.mjs`, `.mts`, an
ESM `.js` or `.ts`) cannot load it again: an edit to such a config keeps the
previous settings and reports that the tool must restart to apply it.
Reverting the file to the text that last loaded clears the error. A JSON,
YAML or CommonJS config, or any config under Bun, reloads in place.

## Passing a config in

A tool or a dialect that builds MX's settings itself hands them to MX instead
of writing a file:

```ts
import { provideMxConfig } from "@mxlang/core";

provideMxConfig(projectRoot, { target: "html", mesh: { strictModels: true } }, {
  file: "mesh.config.ts", // named in diagnostics
});
```

Every file under `projectRoot` then uses that config, and MX does not search
the disk for it. `provideMxConfig(projectRoot, undefined)` removes it again.
`findMxConfig(dir)` answers which config applies to a directory and where it
came from; `isMxConfigFile(path)` tells a watcher whether a changed file is
one of the places above.
