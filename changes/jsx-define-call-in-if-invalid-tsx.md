---
packages: [preact, react, hono]
kind: Fixed
---
A `<define>` call that is the only child of an `<if>`, `<else-if>` or `<else>` branch no longer emits invalid TSX. `<define/Foo><p>inner</p></define><if=input.a><Foo/></if>` compiled to `input.a ? {Foo()} : null`, which Bun and Babel refuse to parse (`ts.createSourceFile` reports nothing, so a parse-only check missed it); it now compiles to `input.a ? Foo() : null`. The same braces broke a dynamic tag (`<${X}/>`), a nested `<if>` and a `<for>` that is the only child of a branch, the `<@placeholder>` fallback, and an `<@item>` attribute-tag body that is a define call or dynamic tag (`item={{Foo()}}`, `Box({ "item": {Foo()} })`). A define call that is the only child of a `<@catch|e|>`, a `<@item|x|>` attribute-tag body or a `<Tag|item|>` render-prop body compiled to `(e) => {Foo()}`, a block body that returns nothing, so the fallback or row rendered empty; it now returns the call.
