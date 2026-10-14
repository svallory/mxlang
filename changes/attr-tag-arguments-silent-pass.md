---
packages: [core]
kind: Fixed
---
An attribute tag written with arguments (`<Foo><@item(1)>hi</@item></Foo>`) is a compile error, `MX_UNSUPPORTED_TAG_ARGUMENTS`, at the first argument, and the message says an attribute tag takes no arguments and to pass the value as an attribute or as the tag's body. It compiled before and dropped `(1)` without a word; Marko 6.4.4 refuses it with "Tag does not support arguments." at the same position. It applies under every parent (a `<define>` call, a template or imported component, a dynamic tag), nested and inside `<if>`/`<for>`, and under the `none` tag rules. Empty parentheses, type arguments and params on an attribute tag, and arguments on the call itself (`<Foo(bar)/>`), still compile.
