---
packages: [core, preact, react, hono, solid]
kind: Fixed
---

An outer `/x` read after a dynamic-tag, `<try>` or element body that declares its own `/x` now compiles and reads the outer binding, as in Marko; a body `/x` with no outer binding is still not in scope after the body. On Preact, React and Hono, a `<try>` body under `<@placeholder>` that binds a `/var` runs its statements inside a component below `Suspense`, so a `/var` call that suspends shows the placeholder (with `<@catch>` too). A dynamic tag with tag arguments and a body emits the body once instead of twice. A module or region with a dynamic tag declares only the dynamic helpers it calls, so `__mxDynamicPair` no longer ships without a dynamic `/var`. The refusal of markup in an `<html-script>`/`<html-style>` body names the file's tag rules instead of "this host". On Solid's server render, an `oncapture:click` attribute (static, dynamic or a spread key) is printed (as `Oncapture:click`, which an HTML parser reads as `oncapture:click`) instead of dropped.
