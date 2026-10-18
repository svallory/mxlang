---
packages: [core, preact, react, hono, solid, angular, astro]
kind: Fixed
---
On a host that does not support `<script>` (Preact, React, Hono, Solid, Angular, Astro), the host refusal is now the only error for the tag. A `<script>` body that does not parse, a head the tag has no use for or a `${...}` placeholder in the body was reported first, so the fix led to the refusal next. Hosts that support `<script>` report the same errors as before.
