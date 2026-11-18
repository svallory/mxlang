---
packages: [preact, react, hono]
kind: Fixed
---
A dynamic tag with a literal string name and an empty `||` (`<${"my-el"}||>x</>`) now renders the element with its body, as Marko does, instead of throwing at run time.
