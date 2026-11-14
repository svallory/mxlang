---
packages: [core]
kind: Added
---
`MX_ATTRIBUTE_ARGUMENTS_DROPPED`: a positioned warning at the argument list of an attribute on a `<define>` or `<const>` (`<define/X a(v)=1/>`, `<const/x value(v)=1/>`), whose arguments the tag ignores. It fires on every host, whatever `attributeArgs` is; the compiled output is unchanged.
