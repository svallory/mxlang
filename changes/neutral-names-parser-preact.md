---
packages: [parser, preact]
kind: Changed
---
Messages a template author can see no longer name MX or Marko. The parser's `MX_FRONT_END_INTERNAL` messages now read "The front end failed while building the syntax tree (not yours: an internal bug): …" and "The template parser threw instead of reporting an error (not yours: an internal bug): …". The Preact emitter, which React and Hono share, rewords four refusals: a `client` block "holds code that runs only in the browser"; `<html-comment>` "cannot render <!--…-->"; the `on:` fix-it says "`on:click=fn` is not Preact syntax" (React, Hono: their own dialect name) without "(Marko rejects this form too)"; and `:=` "is a two-way binding". Error codes, positions and severities are unchanged.
