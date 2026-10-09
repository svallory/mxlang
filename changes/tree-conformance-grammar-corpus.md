---
packages: [data, tree-sitter-mx]
kind: Fixed
---
`parseData` rejects a shorthand id with a placeholder (`<x#a${y}/>`) with a positioned error instead of `internal error: … core IR invariant broken — attribute `id` carries no span`. The grammar package gains `test/corpus/`, 314 tree-sitter corpus cases (htmljs-parser v5.12.0 fixtures the grammar accepts, plus MX's own), and a data-target test that runs every case through `parseData`.
