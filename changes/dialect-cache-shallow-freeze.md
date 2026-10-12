---
packages: [core]
kind: Fixed
---

A `dialect` option (a dialect, or a bare syntax table) that is frozen only at the top is no longer remembered with stale nested contents. Core used to cache a validated dialect or table when `Object.isFrozen` said yes, which is shallow: a change to an unfrozen nested object (the dialect's `table`, a row of it, its `contracts`) after the first call was silently ignored. Core now remembers a dialect or table only when every plain object and array inside it is frozen; RegExps, functions, Maps, Sets and class instances inside are not checked and need not be frozen. One that is frozen only at the top is validated again on every call, like an unfrozen one, so the next call sees the change. A deep-frozen dialect behaves and performs as before: it is validated once. The merge of a dialect's `contracts` with the caller's `customTags` follows the same rule for a `dialect` option: it is remembered only when the `contracts` map is deep-frozen, so an entry added, removed or swapped in place in an unfrozen map is seen on the next call. A dialect loaded from its module is unchanged.
