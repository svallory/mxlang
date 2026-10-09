---
packages: [core, html]
kind: Changed
---
Docs only: the core README and package description no longer say core parses with Marko's parser (it parses and lowers with its own front end; Marko's syntax is the default, `.marko` files are not an input), and the html README no longer claims to be stock Marko or to compile Marko templates unchanged (divergences are listed in `divergences.md`). The specification gains the layer-2 syntax table section (decision 182): `package.json#mx.syntax`, syntax modules, the trigger hooks, the `"member"` contract type and `DataTag.trigger`.
