---
packages: [core]
kind: Fixed
---
As in Marko, `class:x`, `style:x` and `on:x` are now refused on a dynamic tag whose name is a string literal with no placeholder that does not name a native element (`<${"Foo"} class:active=c/>`, `<${"my-el"} on:click=f/>`) and on a claimed `<html-script>`/`<html-style>` read as an element: `MX_INVALID_ATTRIBUTE` at the attribute, with stock Marko 6.4.4's message (`` `class:active` is not a valid attribute, did you mean `class={ active: condition }`? ``, `` `style={ color: value }` ``, `` `onClick` ``). They used to compile as an attribute named `class:active`. Native elements (including `<${"div"}>`) keep each host's own refusal; component props, spread keys, other dynamic tags and bound attributes (`class:x:=y`) are unaffected.
