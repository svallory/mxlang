---
packages: [core]
kind: Fixed
---
A read of a tag variable that two or more nested bodies declare, with no binding of that name around the read, in the type arguments or type parameters of a control-flow tag's head is now refused at the read on every host, as in stock Marko: `` Ambiguous reference, variable was defined in multiple places and was not shadowed. `` (`MX_INVALID_TAG_VAR`). This covers an attribute-position `<for>` (`<C><for<x>|i| of=[1]><@item>hi</@item></for></C>`), an attribute-position `<if>`, `<else-if>` or `<else>` branch, and a child-position `<else>` or `<else-if>` branch, in a build that strips the types as in a compile that keeps them. Before, these heads compiled. A loop's own params still bind its type parameters (`<for <T extends x>|x: T|>`), and a declaration or param around the call still binds its type arguments.
