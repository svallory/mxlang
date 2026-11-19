---
packages: [solid]
kind: Added
---
A tag variable on a native element (`<div/el>`) binds an element reference on Solid, as in Marko 6.4.4: `el()` returns the rendered element in a handler (a function given to an `on…` attribute). `el` is a `let el: any` declared where Solid declares every `/var` of the scope, and a callback `ref` written after the element's other attributes fills it, so it binds per `<for>` row, per branch and per component instance; a `.solid.mx` region declares its element references in place. An authored `ref=` on the same element is composed through Solid's array ref (`ref={[authored, callback]}`) and still receives the node; Solid's assignment form (`ref=d` on a `let d`) is not assigned there.
