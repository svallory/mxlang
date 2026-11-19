---
packages: [solid]
kind: Fixed
---
On Solid, an identifier `ref=` beside an element reference (`let d; <div/el ref=d/>`) is now assigned the element, as `<div ref={d}/>` assigns it without `/el`; before, it was composed into Solid's array ref, which only calls functions, so `d` stayed `undefined`. An identifier or member-expression `ref=` there is now written inside a small hoisted component, `ref={[(<__MxRefSink ref={d} /> as any), callback]}`, so Solid's own compiler decides as it does for a native `ref={X}`: a `let` or a member is assigned the node unless it holds a function or an array, which is applied, and a `const` or an import is applied. This replaces the hand-written wrapper a member-expression `ref=` used before. The literal dynamic tag (`<${"my-el"}/el ref=d/>`) gets the same fix. An optional member (`ref=refs?.d`) and a `satisfies` keep the plain array form, as Solid's own native `ref=` does not assign them.
