---
packages: [preact, solid]
kind: Fixed
---

On Preact, React and Hono a tag param that rebinds a `<define>`'s name makes a call to it inside that body a call to the param whatever the param list holds: a regex or template-literal default (`|{ a = /[}]/, Row }|`) no longer hides the names after it, and the emitter reads the names from the IR in place of scanning the param text. The public `const Row = __mxDefine(…)` is now kept or dropped by a parse of the emitted module, so a `\u` escape in the module no longer keeps every one. On Solid, a plain `/var` that repeats the name of a `/var` in another body of the same component (`<counter/x/><div><counter/x/>${x}</div>${x}`) now compiles with a binding of its own, so each body reads its own value, as in Marko; before it was refused. A destructured `/var` repeating such a name, and an assignment to a repeated `/var`, are still positioned compile errors.
