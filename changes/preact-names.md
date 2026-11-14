---
packages: [preact]
kind: Changed
---
The loop bindings the JSX emitter names itself are `__mxList<n>` (the copied `<for of>` list), `__mxValue<n>` (an omitted `<for in>` value), `__mxIndex<n>` (a range loop's counter) and `__mxAttrIndex<n>` (an attribute-tag `<for>`'s index), numbered by one serial per compile. They were picked by scanning the authored and emitted text for identifiers, so an authored name could change them (`<const/value=1/>` before `<for|k| in=input.o>${value}</for>` emitted `([k, value2])`). Rendering is unchanged. `@mxlang/host-react` and `@mxlang/host-hono` compile through this emitter and emit the same names.
