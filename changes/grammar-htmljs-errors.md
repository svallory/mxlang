---
packages: [tree-sitter-mx]
kind: Fixed
---

- The grammar now reports the seven inputs htmljs-parser rejects that it used
  to accept silently: EOF inside a CDATA section, a doctype, an XML
  declaration or an HTML comment (`<![CDATA[oops`, `<!DOCTYPE html PUBLIC`,
  `<?xml version="1.0"`, `<!-- oops`), code after a concise comment block
  (`/* c */ x`), and a concise line starting with a single `-` or with a `/`
  that opens no comment. Each is an `ERROR` node over the offending span
  instead of an empty document or a dropped line. The cases live in
  `test/corpus/errors.txt` (tree-sitter `:error` cases).
