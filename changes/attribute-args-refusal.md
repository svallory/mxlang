---
packages: [core, preact, react, hono, solid, angular]
kind: Fixed
---

React, Preact, Hono, Solid and Angular reject attribute argument lists such as
`onClick(v)=fn` at the attribute where Marko refuses them, instead of silently
dropping the arguments. `<define>` and `<const>` retain Marko's acceptance
and dropped arguments; builtin, host-tag and region module-statement errors
keep their existing precedence.
Write `onClick=fn` instead; method shorthand remains subject to the host's
existing callable-value policy. Hosts opt in through the generic
`attributeArgs: "refuse"` declaration; core's default IR lowering still retains
attribute arguments, including dialect expressions.
