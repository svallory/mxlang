---
packages: [core]
kind: Fixed
---

A contract `default` on a contract-only tag no longer fails `lowerSource` with "IR invariant broken — attribute carries no span". The attribute the author left out is added to the tag's `attrs` with a zero-width span at the end of the tag's name, on its `span`, `nameSpan` and value (`valueSpan` for a string default, the expression's `span` for a number or boolean), so it contains no position and claims none of the author's text; an attribute the author wrote keeps its own span. A tag with a `transform` still receives a defaulted attribute with no span.
