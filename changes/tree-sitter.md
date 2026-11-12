---
packages: [tree-sitter-mx]
kind: Fixed
---
The scanner now recovers after an error line instead of ending the parse: an error line in a concise body or a repeated `-` line no longer drops the elements after it (root `ERROR` becomes one `ERROR` per bad line). A parsed-text element left unclosed at EOF (`<script>abc`) yields an `ERROR` node instead of only a `MISSING element_end`. An atom inside a `${}` of a template literal inside an expression stays plain text; the README says why (the serialized scanner state has no room for another expression frame).
