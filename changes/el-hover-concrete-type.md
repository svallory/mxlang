---
packages: [html, preact, react, hono]
kind: Changed
---
In the editor (the TypeScript plugin), hovering an element reference now shows the element's own type, `() => HTMLDivElement` for `<div/el>`, the SVG element type for an SVG tag (`() => SVGCircleElement` for `<circle/el>`) and `() => HTMLElement` for any other name, instead of the generated `() => __MxElement<"div">`. Completions and type errors (editor and `mx-tsc`) are unchanged. On Preact, React and Hono the generated TSX no longer annotates the getter's return type (`const el = () => __mxEl0!;`), so TypeScript infers it from the typed slot; the JavaScript is unchanged. On html the type-check projection's getter returns a typed binding; the build output is unchanged.
