---
packages: [core]
kind: Changed
---
Two dialects installed in one project now clash only when a mark is identical; a prefix is no longer a clash. This relaxes the alpha.33 rule, which also refused a mark that was a prefix of another's: `%`, `%.` and `%:` may all be installed together. Two literal marks are identical when they are the same text, two character sets when they share a character, and a literal and a character set when the literal is one character of the set. A file is read with the table of the one dialect it routes to, so the marks of different dialects never compete in one scanner; within one table, one first character still arms at most one row per list. The error text and its position (the start of the loading dialect's module, or of the file for the `dialect` option) are unchanged. A row marked with text core reads itself (`...`, `|`) is still refused by prefix.
