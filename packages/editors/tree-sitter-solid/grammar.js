/**
 * tree-sitter grammar for `.solid.mx`.
 *
 * This is the vendored `tree-sitter-typescript` tsx dialect, patched so that in
 * expression position the JSX alternatives are replaced by a single opaque
 * `mx_element` token produced by the external scanner in `src/scanner_mx.c`.
 *
 * The patch lives in `patches/*.patch` and is applied to `vendor/` by
 * `scripts/vendor.sh`; see `UPSTREAM.md` for the pin and the bump procedure.
 * Nothing MX-specific is written here — this file only selects the dialect, the
 * same way upstream's own `tsx/grammar.js` does.
 */
const defineGrammar = require("./vendor/tree-sitter-typescript/common/define-grammar");

// `tsx` selects the dialect behaviour (JSX position, generic disambiguation);
// `solid` is the grammar name, which the generated C symbols derive from.
module.exports = defineGrammar("tsx", "solid");
