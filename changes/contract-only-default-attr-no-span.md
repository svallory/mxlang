---
packages: [core]
kind: Fixed
---

A contract `default` on a contract-only tag no longer fails `lowerSource` with "IR invariant broken — attribute carries no span". The attribute the author left out is added to the tag's `attrs` with a zero-width span at the end of the tag's name, on its `span`, `nameSpan` and value (`valueSpan` for a string default, the expression's `span` for a number or boolean), so it contains no position and claims none of the author's text. An empty `span` marks an attribute the author did not write (an authored attribute's `span` is never empty); an empty `nameSpan` alone does not, since a nameless default attribute (`<x="post">`) has one too. An attribute the author wrote keeps its own span. A contract-only tag a host claims gets the same spans when compiled, where the defaulted attribute used to carry a name span at offset 0 and no value span; the emitted code does not change. A tag with a `transform` still receives a defaulted attribute with no span.
