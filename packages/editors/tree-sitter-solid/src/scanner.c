// External scanner for the solid grammar.
//
// Two scanners meet here, and they are kept in separate files on purpose
// (plan decision 5, Z2):
//
//   * `tree_sitter_typescript_scanner.h` is upstream tree-sitter-typescript's
//     `common/scanner.h`, copied verbatim (byte-identical — see UPSTREAM.md
//     "Committed copy of scanner.h" for the refresh procedure; drift is
//     caught by a diff against the pin, not a checksum). It provides the tsx
//     tokens — automatic semicolons, template chars, the ternary `?`, regex
//     patterns and so on.
//
//   * `scanner_mx.c` is MX's own, holding every MX addition. Keeping it out of
//     upstream's file means an upstream bump that rewrites `scanner.h` shows up
//     as a patch conflict at the vendor step rather than silently merging into
//     MX code.
//
// This file is the thin entry point tree-sitter compiles: it dispatches to the
// MX scanner when the MX token is valid, and otherwise defers to upstream.
//
// The header is copied into src/ (not included from ../vendor/) because
// vendor/ is .gitignore'd — only src/ is committed, and Zed's file:// dev
// install compiles nothing but what is committed at the pinned rev. An
// include reaching outside src/ compiles fine from a working tree (where
// scripts/vendor.sh has populated vendor/) but fails in Zed's clean clone
// with "file not found" (see UPSTREAM.md "A real defect this caused").

#include "tree_sitter_typescript_scanner.h"

// `scanner_mx.c` is included rather than compiled separately: tree-sitter
// builds exactly one `src/scanner.c` per grammar, and Zed's extension builder
// does the same (Z7). It defines the MX token id and the region scan.
#include "scanner_mx.c"

void *tree_sitter_solid_external_scanner_create(void) { return NULL; }

void tree_sitter_solid_external_scanner_destroy(void *payload) { (void)payload; }

unsigned tree_sitter_solid_external_scanner_serialize(void *payload, char *buffer) {
    (void)payload;
    (void)buffer;
    return 0; // both scanners are stateless across tokens
}

void tree_sitter_solid_external_scanner_deserialize(void *payload, const char *buffer,
                                                      unsigned length) {
    (void)payload;
    (void)buffer;
    (void)length;
}

bool tree_sitter_solid_external_scanner_scan(void *payload, TSLexer *lexer,
                                               const bool *valid_symbols) {
    // When the grammar admits an mx_element and/or either fragment delimiter
    // here, all of them must be decided by ONE call into scanner_mx.c:
    // mx_scan_at_lt consumes `<` (skipping leading whitespace first) and then
    // branches on the very next character. This can't be split into separate
    // "try element, else try fragment" calls the way the rest of this
    // dispatch works, because a TSLexer has no "unconsume" — whichever
    // function looks at the character after `<` first commits the lexer past
    // it for the rest of this call, so a second function chained after a
    // declined first attempt would start mid-token rather than at `<` again
    // (see mx_scan_at_lt's own comment for how this was found).
    if ((valid_symbols[MX_ELEMENT] || valid_symbols[MX_FRAGMENT_OPEN] || valid_symbols[MX_FRAGMENT_CLOSE]) &&
        mx_scan_at_lt(lexer, valid_symbols[MX_ELEMENT], valid_symbols[MX_FRAGMENT_OPEN], valid_symbols[MX_FRAGMENT_CLOSE])) {
        return true;
    }
    return external_scanner_scan(payload, lexer, valid_symbols);
}
