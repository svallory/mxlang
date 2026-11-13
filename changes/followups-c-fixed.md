---
packages: [preact]
kind: Fixed
---

On Preact, a `<define>` rendered through a dynamic tag's attribute form (`<${R} x=1/>`) no longer receives Preact's context object as its second param: it is `undefined`, as in Marko, and the argument form (`<${R}("p", "q")/>`) still passes every argument. React and Hono already behaved this way. A define's params are typed from their parser nodes instead of a text scan, so a string default with an escape (`a = "x\"y"`) and a leading-dot number default (`a = .5`) are kept as written, their type inferred, instead of being typed `any`.
