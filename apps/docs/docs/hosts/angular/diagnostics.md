---
title: "Angular: diagnostics"
description: "What mx-tsc and the editor report for a .ng.mx file: TypeScript errors in the module, and Angular's own template checker on the MX template."
---

# Angular: diagnostics

A `.ng.mx` file is checked twice, and both results point at the line you wrote.

1. **TypeScript** checks the module: the class, the imports, everything around the template.
2. **Angular's template checker** (`@angular/compiler-cli`, from your project) checks the expressions inside `template:`. TypeScript cannot: to it the template is an opaque string.

```
src/x.component.ng.mx(5,18): error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.
```

Both run in `mx-tsc` and, through `@mxlang/typescript-plugin`, in the editor. They report what `ng build` reports: your `strictTemplates` and other `angularCompilerOptions` are honored, including through `extends`.

## In CI: `mx-tsc`

`mx-tsc --noEmit` exits non-zero on a template error. It picks the tsconfig by `tsc`'s own rules (`-p`, else the nearest `tsconfig.json`).

- **Run `mx-angular build` first** if templates call MX tags: the checker needs the generated tag modules to exist.
- **`@angular/compiler-cli` must be installed**, `>=22.0.0 <23.0.0`. If `.ng.mx` files exist and it is missing or unsupported, `mx-tsc` fails with the fix, since passing with templates unchecked would be worse.
- **Extended checks keep their severity.** NG8103 (`*ngIf` used without importing `NgIf`) is a warning. Promote it as you would for `ng build`, with `angularCompilerOptions.extendedDiagnostics`.

## In the editor

The check runs in a worker process, one per Angular project, never inside the TypeScript server, so typing is not blocked. Results appear when a check finishes and are hidden while the file's text is newer than the result.

| `mx.angular.diagnostics` in MX's config | When the editor checks |
|---|---|
| `"idle"` (default) | One second after your last edit |
| `"save"` | When the file is saved |
| `"off"` | Never; `mx-tsc` skips the template check too |

Only open `.ng.mx` files are checked. If `@angular/compiler-cli` is missing or fails to load, each open file shows one message with the fix; after installing it, restart the TS server.

## Positions

- An error in an expression is reported at that expression.
- An unknown element (NG8001) or property (NG8002) is reported at the element name or the attribute.
- A diagnostic on markup MX generated, not copied from your source, points at the start of the template and is marked "(approximate location)".

## Known limit

- The editor picks up a change to MX's config (`package.json#mx`, `mx.config.*`, `.mxrc*`) or to a called tag when the `.ng.mx` is next edited or reopened, not at once.
