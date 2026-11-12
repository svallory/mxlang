---
packages: [host-preact, host-react, host-hono]
kind: Fixed
---

JSX-host fixes on `<define>` bodies and module typing. A `.mx` component whose `Input` types `content` as a function no longer fails `tsc` with TS2322 in its own file. A `/var` inside a whole-file `<define>` body is declared inside that body (it was dropped, and two defines referenced an undeclared temp). A `/var` inside a dynamic-tag body or a `<try>` `@placeholder`/`@catch` body is scoped to that body, so it can sit beside an outer `/x` as in Marko. A `<define>` used as a dynamic target (`<const/R = Row/>` then `<${R}>`) now receives the body as `content`. An untyped `<define>` param is typed `any` so a `noImplicitAny` project reports no TS7006. A region now refuses a `<define>` inside a dynamic-tag or `<try>` body, which it used to lift out of the body's scope, and a `/var` in the `<try>` main body is body-scoped like `@placeholder` and `@catch`. A `<define>` called directly from MX (`<Row(x)/>`) receives its arguments untouched; only the define's value, which a dynamic tag reaches, reads a `children` body as `content`.
