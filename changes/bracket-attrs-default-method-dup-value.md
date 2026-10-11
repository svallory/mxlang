---
packages: [core]
kind: Fixed
---

`run [after=1] (x) { go(x) }`, and a default method after any other attribute in the concise form (`run a=1, (x) { go(x) }`), no longer warns ``duplicate attribute `value`: the later one at 1:15 wins, so this one is dropped``. The parser reads the method's empty name twice at one offset; that is one authored attribute, and it lowers to exactly one `value`, the method, as Marko 6.4.4 does. The forms Marko refuses (`run after=1 (x) { go(x) }`, `<run after=1 (x) { go(x) }/>`) keep Marko's error, ``Expected a single expression, but found `{` after it.``. A genuine duplicate still warns. The duplicate-attribute warning now has the stable code `MX_DUPLICATE_ATTRIBUTE`: the new optional `MxWarning.code` (`@unstable`) reaches `IrDiagnostic.code`, so a consumer matches the code instead of the text.
