---
packages: [preact, react, solid]
kind: Fixed
---
An element reference named `input` in a native element's body (`<div><div/input/><button onClick() { input() }/></div>`, or a literal dynamic tag's `<div><${"my-el"}/input/></div>`), which Marko accepts, now compiles on Preact, React and Solid. The emitted module used to declare `input` twice: once for the template's input and once for the reference. As in Marko, the element's body is a scope of its own, so `input` is the element inside it and the template's input outside it, also when the element sits in an `<if>`, `<for>` or `<define>` body. Preact and React render that body as an arrow called in place; Solid gives the reference a generated name. Every other element body's output is unchanged.
