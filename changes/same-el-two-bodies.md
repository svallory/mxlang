---
packages: [preact, react, hono]
kind: Fixed
---
The same element reference name in two native element bodies (`<div><div/el/></div><div><div/el/></div>`) compiles instead of failing with `Duplicate declaration "el"`: a body whose element reference repeats a name of its scope is a scope of its own, so each body's handlers reach its own element, as in Marko.
