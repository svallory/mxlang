---
packages: [preact, hono]
kind: Added
---
Hono binds an element reference (`<div/el>`, and a literal dynamic tag's `<${"my-el"}/el>`) as Preact and React do: a slot and an `el()` getter typed by the tag name, filled by a callback `ref`, with an authored `ref=` on the same element composed into it. Hono's string renderer throws on a function `ref`, so on Hono the callback is passed only where a `document` exists (`typeof document === "undefined" ? undefined : callback`): a server render skips it and `hono/jsx/dom` calls it with the element. `<div/el>` no longer gets the generic tag-variable refusal on Hono. The shared JSX dialect gains an optional `elementRefClientOnly` switch for this.
