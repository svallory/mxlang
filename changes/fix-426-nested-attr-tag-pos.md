---
packages: [core]
kind: Fixed
---
A legacy host's "nested attribute tags aren't supported" error points at the first nested attribute tag again (`<@icon>` in `<Panel><@item><@icon/></@item></Panel>`, column 14), not at the outer `<@item>`, as before the attribute-tag lowering moved to child selection. New public export `firstAttributeTag(node)`: the first attribute tag a tag carries, from Marko's `attributeTags` field or from `MxAttributeTag` children, for a host diagnostic to point at.
