---
packages: [core]
kind: Changed
---
`MX_NOT_A_DOM_EVENT` now follows its rule in full: an element's `on<Name>` warns whenever its lowercase is not a DOM event name, where the names are every `*EventMap` key of TypeScript's `lib.dom.d.ts` plus a few real browser events that file lacks (`beforecopy`, `beforecut`, `beforepaste`, `beforexrselect`, `contentvisibilityautostatechange`, `scrollsnapchange`, `scrollsnapchanging`). `<button onFoo=f>` now warns `` `onFoo` is not a DOM event ``; `onDoubleClick` keeps its `onDblClick` suggestion and `onDragExit` still warns, while `onEncrypted` no longer warns (`encrypted` is a media-element event). An `onClick:foo` name warns too. `on-<exact>` is never checked. The `MX_STRUCTURAL_CONSTRUCT` and `MX_NOT_IN_DATA_FILE` descriptions in `MX_DIAGNOSTIC_CODES` now read "a structural construct in a static data file" and "something a static data file cannot hold".
