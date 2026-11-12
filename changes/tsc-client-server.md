---
packages: [target-html]
kind: Fixed
---

The type-checking view of an html template no longer lets client code read a `server` name as a typed value (it is `undefined` there, as in the browser), and no longer lets a template read a `client import`, `client namespace` or `client declare` name typed (it is `undefined` in the server view). Each read is reported at the author's token.
