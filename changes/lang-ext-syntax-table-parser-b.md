---
packages: [parser, babel]
kind: Added
---
The syntax table's block tags, filters and precomputed tag types (decision 182, parser half, PR B; addenda 2 and 3). `blockTag` (`{% … %}`) and `filter` (`::name:: … ::`) are armed in HTML content and announced through `onBlockTag` and `onFilter`; the front end builds raw `MxBlockTag` and `MxFilter` body children (`@mxlang/babel/mx-ast`, ast §4.5), and lowers nothing. Tag types come from the table's `tagTypes`, keyed by the full written static name (dynamic and `@` names are never looked up, an absent name is html, `statement` applies only on a concise line), instead of a decision returned by `onOpenTagName`. The front end's `parse` takes an optional `tagTypes`; without one it builds the table before the parse from `tagShape` and `statementKeywords` (interim until core builds it). The default row parses every input exactly as before.
