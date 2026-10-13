---
packages: [preact, react, hono]
kind: Fixed
---
A body whose only child is a `${expr}` placeholder no longer renders the expression's source text, and an empty body no longer renders the word "null". `<for|i| of=input.l>${i}</for>` compiled to `<__mxFragment key={i}>i</__mxFragment>` and rendered `ii` for a two-item list where the html target renders `12`; the same happened for `<for in>`, `<for from to>`, the body of a `<define>` call (`<Box>${input.y}</Box>` rendered `<b>input.y</b>`, and `<Box|n|>${n}</Box>` rendered `n`) and the body of a dynamic tag (`<${X}>${input.y}</>`). An empty `<for>` body (or one holding only a comment) rendered `null` once per row. A lone placeholder in these positions is now a JSX expression child (`{i}`), and an empty body is empty. A placeholder in an expression position (a ternary arm, a render-prop arrow body) is unchanged.
