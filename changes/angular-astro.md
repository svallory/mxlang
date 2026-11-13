---
packages: [angular]
kind: Added
---

An object rest in a `<const>` pattern (`<const/{ a, ...rest }=obj/>`) now compiles on Angular instead of being an error: it binds `@let rest = __mxRest(obj, ["a"]);`, a copy of the object's own enumerable fields less the keys named before the rest, as JavaScript's destructuring makes it (`null` and `undefined` throw a `TypeError`). `.ng.mx` and tag modules get the `__mxRest` member injected; a page class gets a once-per-file advice warning (`angular.rest-helper-advice`), or extends `MxHandlers`/`MxHandlersMixin`, which now carry `__mxRest`.
