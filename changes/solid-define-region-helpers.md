---
packages: [solid]
kind: Fixed
---
A `.solid.mx` region `<define>` whose body holds an attribute tag (`<define/Row><Box><@item|v|>${v}</@item></Box></define>`), an attribute-tag `<for>` or a dynamic tag with args failed to compile with "`<define/Row>` is hoisted to module scope and cannot close over `__mxAttrTag`" (or `__mxAttrTags`, `__mxTextareaDynSpread`), helpers the region itself hoists to module scope. The hoisted-define capture check now accepts the helpers the region hoists, and the region hoists the attribute-tag runtime whenever one of its hoisted defines uses it, so the define renders.
