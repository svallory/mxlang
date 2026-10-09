---
packages: [tsc, typescript-plugin]
kind: Fixed
---
A host whose `ambientTypes` throws no longer crashes the type check. `mx-tsc` prints one `error TS80004: host <package>: ambientTypes threw: <message>` diagnostic, exits 1, and still checks the project without that host's ambient files. The TypeScript plugin reports the same message as a project-level diagnostic in the editor. Other hosts' ambient types still resolve.
