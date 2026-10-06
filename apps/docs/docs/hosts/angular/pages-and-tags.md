---
title: "Angular: page templates, MX tags and the CLI"
description: "A .mx template beside a hand-written Angular component, MX tags compiled to standalone components, and the mx-angular build, watch and map commands."
---

# Angular: page templates, MX tags and the CLI

[`.ng.mx`](/hosts/angular/) keeps the class and its template in one file. Two other inputs exist, and `mx-angular` compiles all three.

| Input | Output | Use it for |
|---|---|---|
| `x.component.ng.mx` | `x.component.ts` | A component: class and template together |
| a page template, `x.component.mx` | `x.component.html` | The `templateUrl` of a class you keep in its own `.ts` |
| a tag, `tags/badge.mx` | `tags/badge.ts`, a standalone component | A reusable piece with no class of its own |

A `.mx` file is a tag when it sits under a `tags/` directory or is listed in `package.json#mx.tags`; otherwise it is a page template. A `mx.tags` entry restricted to other hosts (`"hosts": ["solid"]`) is not compiled here.

## Page templates

Keep `x.component.ts` as it is, point `templateUrl` at `./x.component.html`, and write `x.component.mx` beside it. Compared with `.ng.mx`, MX cannot edit your class, so two things are yours:

- **Imports.** When the template calls an MX tag or needs a directive, the build warns with the exact `import` and `imports:` entry, and repeats it in the header of the emitted `.html`. Without the entry Angular renders an unknown element as an empty tag, silently.
- **Event members.** A template that binds a handler needs `__mxOn` and `__mxOnAt` on the class. Extend `MxHandlers`, or `MxHandlersMixin(Base)`, from `@mxlang/angular/runtime`; a missing member is TS2339 at build time under `strictTemplates`.

Page templates have no TypeScript plugin support yet, which is the main reason to prefer `.ng.mx`.

## MX tags (preview)

```mx "tags/badge.mx"
export interface Input { kind: "ok" | "warn" | "error"; label?: string }

<span.badge data-kind=input.kind>
  <if=input.label>${input.label}: </if>${input.content()}
</span>
```

compiles to a standalone component:

```ts "tags/badge.ts (generated)"
@Component({
  selector: "mx-badge",
  standalone: true,
  imports: [],
  template: "<span class=\"badge\" [attr.data-kind]=\"kind\">@if (label) { {{ label }}:  }<ng-content></ng-content></span>",
})
export class Badge {
  @NgInput({ required: true }) kind!: "ok" | "warn" | "error";
  @NgInput() label?: string;
}
```

- **Inputs** come from `export interface Input`: one `@Input()` per property, `required` unless optional, the type copied as written. The template reads `input.kind`; the emitted template reads `kind`.
- **Content**: `${input.content()}` is `<ng-content>`. An attribute tag, `${input.header()}` or `<${input.header}/>`, is `<ng-content select="[header]">`.
- **Selector**: `mx-` plus the file name (`mx-badge`). Change the prefix with `mx.angular.tagSelectorPrefix`, or one tag with `export const selector = "acme-card";`.
- **No `@Output()`**: a function-typed property is an input, and the caller passes a callback.
- **`import` and `static`** stay in the tag's module. An import of another `.mx` tag is rewritten to its generated module.

Projection places nodes; it cannot pass values or repeat. So in a tag, these are errors and not blank output:

| Written | Why |
|---|---|
| `${input[key]}` | The property is not known until run time |
| `${input.x}` and `${input.x()}` in one tag | One is an input, the other a projection |
| `${input.header(1)}`, attribute tags with params, arrays or attributes | `<ng-content>` cannot take values |
| reading the same attribute tag twice | Angular fills each selector once |
| `<child header=input.header/>` where `child` projects `header` | Nest a `<@header>` block instead |

## Configuration

```jsonc
// package.json
{
  "mx": {
    "host": "angular",
    "angular": {
      "include": ["src/**/*.mx"],     // page templates to compile
      "pageExtension": ".html",       // defaults from here down
      "tagExtension": ".ts",
      "tagSelectorPrefix": "mx-",
      "onError": "keep-last"
    }
  }
}
```

Tags and `.ng.mx` files are compiled wherever they are; `include` selects page templates. Emitted files are build artifacts: ignore them in git, and keep the `.mx` sources out of `tsconfig.json`'s `include` and `angular.json`'s `assets`.

## `mx-angular`

```
mx-angular build [--project <dir>] [--config <file>]
mx-angular watch [--project <dir>] [--config <file>] [--once]
mx-angular map   <file.html:line:col>
```

**`build`** compiles everything once and exits `1` on any error. Run it before `ng build` and before `ng serve` starts: Angular reads the emitted files from disk. It writes a file only when its bytes change and never overwrites a file without MX's generated header. Warnings print as `file:line:col warning: …` and do not fail the build.

**`watch`** builds, then recompiles what changed: a page alone, or every page that calls a changed tag. Run it beside `ng serve` with `concurrently -k`, so stopping one stops the other. `--once` builds and exits.

**`onError`** decides what a compile error does to the last good output:

| Value | Effect |
|---|---|
| `keep-last` (default) | Keeps it and prints the error. With no earlier output, writes a visible error template |
| `error-template` | Always writes the error template |
| `delete` | Removes the output. Use it in CI, where a stale template is worse than a missing one |

**`map`** turns a position in an emitted `.html` into the `.mx` position it came from, 1-based on both sides:

```console
$ mx-angular map src/greeting.html:2:12
greeting.mx:2:8
```

It maps what came from your source (names, expressions, conditions) to the start of that run, and says so when a position is in markup MX generated.

## Example

`examples/angular-app` is a stock Angular CLI 22 app with a page template per component and the `badge` tag above.
