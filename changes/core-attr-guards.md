---
packages: [core, html]
kind: Fixed
---

Attribute and binding refusals now follow stock Marko. `value:=x` on a registered custom tag's attribute tag is checked for a `<const>` target and a `<let>` written before its declaration. `:=` on a plain `<for|i|>` or `<define/D|p|>` parameter is refused with "Unable to bind to value."; an object-pattern field or a `<let>` still binds. `<if>`, `<else>`, `<for>`, `<log>`, `<debug>` and `<html-comment>` refuse attributes they do not take, with or without an argument list, and `<C><@item a(v)=1/></C>` stays refused. `<for by(v)="id">`, `of(v)` and `to`/`step(v)` compile and drop the argument list, as Marko does. `by=` reading an outer binding of the loop parameter's name is still refused, with a message that says it reads the outer binding. `<foo(a)><@x/></foo>` is refused after any attribute-tag/body mix is reported; a lone `<foo(a)/>` passes `a` as the callee's input on the html target and is a positioned error on hosts that cannot pass it. Core gains the opt-in `HostDeclarations.namedCallInputArgument`.
