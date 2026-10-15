---
packages: [core]
kind: Fixed
---
A shorthand `id` or `class` whose placeholder holds a string literal alone (`<div#${"lit"}/>`, `<div.${"lit"}/>`, concise `div#${"lit"}`) no longer fails the IR entry point with `MX_INTERNAL_ERROR` ("attribute `id` carries no name span"). Marko compiles these forms, and the IR entry point now does too: the attribute lowers like any other shorthand placeholder, with the literal as its value and the span of the authored expression, so its `nameSpan` and `span` are finite and positioned.
