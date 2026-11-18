---
packages: [html]
kind: Fixed
---
Under a `style` contract in `customTags` (or `mx.contracts`), the html target now writes the contract's attributes on the `<style>` open tag, both the authored ones the contract accepts (`<style nonce="abc">`, HTML-escaped when dynamic) and the contract's defaults, instead of dropping them from the output. A `<style>` without a contract is unchanged.
