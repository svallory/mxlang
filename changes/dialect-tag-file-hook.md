---
packages: [core]
kind: Added
---

A dialect reads its tag files. The dialect module takes a `tagFile(file, ctx)` hook (`@unstable`) that returns the contract of one tag file its `tagDirs` discovered, with `TagFileInput`, `TagFileContext`, `TagFileResult` and `TagFileDiagnostic` exported from `@mxlang/core` (`@unstable`). The scan never runs the hook: the first call of the tag does, and the contract registers like a `.tag.ts` contract, with the same checks, errors and codes (the `defaultTag` check included), raised at that call. `ctx.lower(options?)` lowers the tag file under its own dialect and its own scanned tags, memoized per options. `ctx.dependsOn(path)` names a file the answer reads. A contract key outside `attributes`, `attributeTags`, `children`, `parents`, `defaultTag` and the dialect's claimed keys is refused, and `parseOptions` and `template` are refused with why.

A derived contract is cached per tag file, keyed on the file's stamp, the dialect module's revision, the parser signature and contract files (`.tag.ts` sidecars, templates, the `mx.contracts` module) of the tag file's own scan, sibling tag files aside, and the stamps of every file it depends on, including every tag file it called while lowering, transitively, with no declaration. An edit re-derives only the tag files that read it. A failed derivation is cached too.

The hook's diagnostics are in the tag file, with `file` set. A throw is an error at its own position, else at 1:0 of the tag file. A definition with errors fails each call with `` `<money>`'s definition has errors (concepts/money.mesh.mx:3:2) `` (`MX_TAG_FILE_ERROR`), and the tag file's errors travel with it. Tag files that call each other fail with `MX_TAG_FILE_CYCLE` (`tag files call each other in a cycle: a → b → a`) at the re-entering call, and nothing on the cycle is cached. The call's `DelegatedTag` carries `definedIn`, the tag file's path (`@unstable`). `clearTagFileCache()` (`@unstable`) drops every derived contract.

`IR_VERSION` goes from 2 to 3, for `DelegatedTag.tag.definedIn`. A dialect or host that asserts the IR version (Mesh does) must accept 3.
