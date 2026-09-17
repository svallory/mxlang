# @mxlang/example-angular-app

A stock Angular CLI 22 app (`@angular/build:application`, no custom builder)
whose one component keeps `templateUrl` and writes its template in MX
(`.mx`), compiled by `mx-angular`. The emitted `.html`/`.html.map` are
gitignored — `mx-angular` must run before `ng build`/`ng serve`. Requires the
repo's root `bun run build` to have run first (`mx-angular` resolves to
`packages/hosts/angular/dist/bin.js`, same as every other example depending
on a built `@mxlang/*` package).

```
bun run build   # mx-angular build (prebuild), then ng build
bun run start   # mx-angular build, then `mx-angular watch` + `ng serve` together (concurrently)
```

`(click)="(toggleHighlight)($event)"` in the emitted template — the
parenthesized callee is the emitter's own deliberate form for an
`onClick=handler` binding, not a mistake to clean up.

See `apps/docs/docs/hosts/angular.md` for the full `mx-angular` CLI
reference.
