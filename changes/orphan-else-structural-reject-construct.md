---
packages: [core]
kind: Fixed
---
Under `structural: "reject"`, an orphan `<else>` or `<else-if>` is reported once, as the `if` construct (`MX_STRUCTURAL_CONSTRUCT`, "… do not evaluate `<if>`"), at the tag. Before, it got the reserved-name text of `MX_NOT_IN_DATA_FILE` ("`<else>` cannot name a data tag: it is reserved …"), which named the wrong rule: `else` belongs to the `if` construct, and a data file evaluates neither. This holds at the root, under a tag with a contract, under a tag whose transform consumes its body, and in the concise form. An `else` that follows an `if` is still folded into that `if`'s single report. `structural: "pass"`, the unset default, no dialect and the template path are unchanged and keep the reserved-name text. A dialect that maps `MX_NOT_IN_DATA_FILE` for an orphan `else` now also receives `MX_STRUCTURAL_CONSTRUCT` there.
