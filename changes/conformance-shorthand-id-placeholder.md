---
packages: [core, solid]
kind: Fixed
---
`lowerSource` lowers a shorthand `id` or `class` with a placeholder (`<div#a${x}/>`, `<div#${x}-a/>`, `<div.a${x}.b/>`, concise `div.a${x}`) instead of refusing it with "a shorthand id with a placeholder is not supported in a data file". The value is the template literal (or, for several class words, the array) core builds over the word, and its `span` is the authored word run after the sigil, so `code` is not the source sliced by `span` (a static `.a.b` already works this way). A shorthand class beside a `class` attribute (`<div.a${x} class="b"/>`) is still refused. Solid now compiles a shorthand class array that mixes a static word and a placeholder (`<div.b.a${y}/>`, `<div.a.${y}/>`); it used to refuse them with "`.class` shorthand combined with a non-string `class` value".
