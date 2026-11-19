---
packages: [core]
kind: Fixed
---
Under the `none` tag rules, a lowercase tag named after a core taglib name (`<log>`, `<debug>`, `<id>`, `<lifecycle>`, …) that a local binding (an import or a `<define>`) shadows now raises Marko's local-variable error at the tag name, as any ordinary name does: ``Local variables must be in a [dynamic tag](…) unless they are PascalCase. Use `<${log}/>` or rename to `Log`.`` Before, it compiled silently as an element. Outside `none` nothing changes: a core taglib name stays exempt from the rule.
