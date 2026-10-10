---
packages: [core]
kind: Removed
---

**Breaking:** `@mxlang/core` no longer checks atom contracts. The `values`, `pattern`, `ref` and `declares` contract keys leave core's vocabulary: they are keys a syntax module may claim through `contractFields` and check in its own `checkContract` and `afterLower`, like any key core does not know. A `.mx` file whose contract uses one of the four keys without a claiming module now gets the unknown-key error. Removed exports: `atomCandidates`, `AtomCandidate`, `AtomFacts` and `ContractDeclaration`. Also removed: `CompileResult.atomFacts`, `TranslateError.atomFacts`, the `values`, `pattern` and `ref` fields of `CustomTagAttribute`, `CustomTag.declares`, and the test-only `fallbackSyntaxForTesting` global. Kept: `Atom` and `Member` values, `ContractAtomOrMember` (the whole-value kind a module builds, `@unstable`), the `type: "atom"` and `type: "member"` shape check, `ctx.declare`, `contractFields`, `checkContract`, `describeAttribute`, `afterLower` and `LoweredUnit`. Built-in `=:x` atoms still lower as before.
