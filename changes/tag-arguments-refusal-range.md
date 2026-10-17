---
packages: [core]
kind: Fixed
---
A tag that takes no arguments (`<if(a, b)>`, `<for(a, b)>`, `<let/x(1, 2)/>`, `<const/x(1, 2)/>`, `<button (a, b)>`) now blames the whole argument list, from the first argument to the last, as Marko does; the range used to end at the first argument. Arguments next to attributes or a body on a named custom tag (`<Panel(a, b)>body</Panel>`), and next to attributes on a `<define>` call or a dynamic tag (`<Foo(a, b) c=1/>`), are still refused, now at the arguments with Marko's text, "Tag does not support arguments when attributes or body present.", instead of at the tag name.
