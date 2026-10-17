// MX element scanner.
//
// This file is MX's own. Upstream's shared scanner is included as
// `common/scanner.h` and is NOT edited: keeping the MX additions here means an
// upstream bump that changes `scanner.h` fails loudly at the vendor step
// instead of silently merging into our code (plan decision 5, Z2).
//
// ---------------------------------------------------------------------------
// WHAT THIS SCANNER DOES
//
// The grammar replaces the tsx dialect's JSX alternatives in expression
// position with one opaque token, `mx_element`. When tree-sitter marks that
// token valid, this scanner starts at `<`, finds the byte offset just past the
// root tag's close, and emits the whole span as a single token. The MX region's
// interior is deliberately not given structure here — `@mxlang/parser` owns
// that; this scanner only has to agree with it about where the region ENDS.
//
// It cannot call htmljs-parser, so it replicates its tokenization. The rules
// below are ported from `notes/zed/mx-scanner-rules.md`, which derives them
// from `packages/parser/src/mx/walk.ts` plus htmljs-parser 5.15.0. Each
// block cites the rule row and the bridge function it mirrors.
//
// ---------------------------------------------------------------------------
// RULE-TO-IMPLEMENTATION INDEX  (scanner-rules.md §13; §-refs are to that file)
//
//   Rule (spec row)                        | Mirrors                  | Here
//   ---------------------------------------|--------------------------|------
//   End offset, region stop           §1,§2 | walkMxRegion/`finish`    | scan_mx_element_body
//                                           | walk.ts:170              |
//   Depth stack                         §5  | walk.ts:303 push / :334  | depth in
//                                           | pop                      | scan_mx_element_body
//   Void set is depth-neutral, REPO-LOCAL   | VOID_TAGS/isVoidTag      | is_void_tag
//                                       §5  | walk.ts:92,110           |
//   Tag-name terminators, `.`/`#`, `${}`§4  | htmljs TAG_NAME.parse    | scan_tag_name
//   `>` / `/>` open-tag end             §5  | htmljs OPEN_TAG.parse    | scan_open_tag
//   Tag type args `<Bar>`               §9.3| htmljs OPEN_TAG case 60   | scan_open_tag
//                                           | stage 3                  | (angle_depth)
//   Tag var `/x`, args `(…)`, params `|…|`  | htmljs OPEN_TAG cases    | scan_open_tag
//                                      §13  | 47/40/124                |
//   Attr `=`, `:=`, `...` dispatch      §6  | htmljs ATTRIBUTE.parse   | scan_open_tag
//   Unquoted attr value termination     §6  | htmljs                   | scan_attr_value
//                                           | shouldTerminateHtmlAttrValue |
//   Attr method `name(p){…}`           §13  | htmljs ATTRIBUTE cases   | scan_open_tag
//                                           | 40/123                   | (brace/paren)
//   Bracket nesting (groupStack)        §7  | htmljs EXPRESSION.parse  | scan_expression
//   JS strings                          §7  | htmljs STRING.parse      | scan_string
//   Template literals + `${}` re-entry  §7  | htmljs TEMPLATE_STRING   | scan_template_string
//   Line/block comments                 §7  | htmljs JS_COMMENT_*      | skip_js_comment
//   Regex vs division                   §7  | htmljs canFollowDivision | can_follow_division
//                                           | + REGULAR_EXPRESSION     | scan_regex
//   `${}`/`$!{}`/backslash escaping     §8  | htmljs checkForPlaceholder| scan_text
//   `<` as literal text                 §9.2| htmljs HTML_CONTENT.parse| scan_text
//   `<!-- -->`, doctype, CDATA, `<?…?>`§10 | htmljs HTML_COMMENT/DTD/ | scan_markup_decl
//                                           | CDATA/DECLARATION        |
//   Close-tag scan + name match         §5  | htmljs CLOSE_TAG.parse   | scan_close_tag
//   Concise mode UNREACHABLE from `<`   §3  | htmljs HTML_CONTENT.enter| (not implemented,
//                                           |                          |  deliberately)
//
// NOT IMPLEMENTED, DELIBERATELY: concise mode. `Parser.parse` starts in
// CONCISE_HTML_CONTENT, but `case 60:` (`<`) immediately calls
// `beginHtmlBlock`, and `HTML_CONTENT.enter` sets `isConcise = false`; nothing
// on the `<`-rooted path re-enters concise mode (§3, Z11). So there are no `;`
// line-ends, no `--` blocks, no `[ ]` attribute groups and no
// shouldTerminateConcise* here. This is proven, not assumed.
//
// MX-VS-GENERIC-ARROW, in one sentence: the check happens in the lexer's
// external-then-internal fallback — this scanner is offered the `<` first,
// scans forward for a matching close tag, finds none, returns false, and
// tree-sitter then re-lexes the same position internally, where the ordinary
// `<` token yields `type_parameters`.
//
// In a .tsx file TypeScript forbids `<T>(x) => x`; a generic arrow must be
// `<T,>` or `<T extends U>` (Z14). No lookahead, precedence or conflict
// implements that here: a generic arrow is rejected by this scanner *failing to
// find an element*, which is the same code path that rejects any malformed
// region. See the note above `scan_tag_name` for why the tsx GLR conflict does
// not transfer to a single external token.

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <string.h>
#include <wctype.h>

// Token ids, in the order the grammar's `externals` array declares them.
//
// These indices are positions in `valid_symbols`, so they must match
// src/grammar.json's `externals` array EXACTLY. The first ten come from
// tree-sitter-javascript and tree-sitter-typescript (mirroring upstream's own
// `enum TokenType` in common/scanner.h); `mx_element` is appended last by the
// patch to common/define-grammar.js.
//
// Getting this wrong is silent: an off-by-N here reads some other token's flag,
// so the scanner simply never fires and every MX region degrades to a TS parse
// error. Verify against `python3 -c "import json; ..."` on src/grammar.json
// after any upstream bump that adds or reorders an external token.
enum MxTokenType {
    MX_AUTOMATIC_SEMICOLON,                   // 0
    MX_TEMPLATE_CHARS,                        // 1
    MX_TERNARY_QMARK,                         // 2
    MX_HTML_COMMENT,                          // 3
    MX_LOGICAL_OR,                            // 4  ('||')
    MX_ESCAPE_SEQUENCE,                       // 5
    MX_REGEX_PATTERN,                         // 6
    MX_JSX_TEXT,                              // 7
    MX_FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON, // 8
    MX_ERROR_RECOVERY,                        // 9
    MX_ELEMENT,                               // 10 — MX's own
    MX_FRAGMENT_OPEN,                         // 11 — MX's own, `<>`
    MX_FRAGMENT_CLOSE,                        // 12 — MX's own, `</>`
};

// A hard cap on the region scan. htmljs-parser has no such limit, but a
// tree-sitter scanner that runs away on malformed input hangs the editor; a
// region longer than this is treated as "not an MX element" and handed back to
// the parser as a failed token rather than scanned forever.
#define MX_MAX_SCAN 1000000

// ---------------------------------------------------------------------------
// Lexer helpers.
//
// `lexer->lookahead` is the current character; `advance` consumes it. The
// scanner never calls `mark_end` until it knows the region ended, so a failed
// scan consumes nothing the parser can see.

static inline void advance_mx(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline bool is_eof(TSLexer *lexer) { return lexer->eof(lexer); }

// htmljs treats any code <= 32 as whitespace (scanner-rules §4).
static inline bool is_ws(int32_t c) { return c > 0 && c <= 32; }

static inline bool is_name_start(int32_t c) {
    return iswalpha(c) || c == '_' || c == '$';
}

static inline bool is_word_char(int32_t c) {
    return iswalnum(c) || c == '_' || c == '$';
}

// ---------------------------------------------------------------------------
// Void elements — REPO-LOCAL (scanner-rules §5, Z12).
//
// htmljs-parser is markup-agnostic and does not know these. Depth-neutral
// treatment of `<br>` exists only because walk.ts:92-110 declares TagType.void
// from `onOpenTagName`. Omitting this list makes every `<br>` an unclosed open
// tag, which would swallow its siblings' closing tags and run the region to
// EOF. The 14 names are exactly walk.ts's VOID_TAGS.
static bool is_void_tag(const char *name, unsigned len) {
    static const char *const VOID_TAGS[] = {
        "area", "base",  "br",     "col",    "embed", "hr",   "img",
        "input", "link", "meta",   "param",  "source", "track", "wbr",
    };
    for (unsigned i = 0; i < sizeof(VOID_TAGS) / sizeof(VOID_TAGS[0]); i++) {
        if (strlen(VOID_TAGS[i]) == len && strncmp(VOID_TAGS[i], name, len) == 0) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Regex-vs-division (scanner-rules §7).
//
// htmljs disambiguates by one-char lookbehind: `canFollowDivision(prev)` true
// means the `/` is division. Returns true for any word char and for
// ` ' " % ) . < ] } (backtick included). Verified both ways upstream:
// `<div a=x/2>` yields the value `x/2`; `<div a=/re>/ >` yields `/re>/`.
static bool can_follow_division(int32_t prev) {
    if (is_word_char(prev)) {
        return true;
    }
    switch (prev) {
        case '`':
        case '\'':
        case '"':
        case '%':
        case ')':
        case '.':
        case '<':
        case ']':
        case '}':
            return true;
        default:
            return false;
    }
}

// Forward declarations: expressions, strings and templates are mutually
// recursive through `${}` re-entry (scanner-rules §7).
//
// `ate_slash` is an out-parameter for one specific case: an unquoted attribute
// value that ends at `/>`. Within one scan there is no un-consume, so by the
// time the value scan knows the `/` was the start of `/>` it has already
// consumed it. (Returning false *would* discard everything and let tree-sitter
// re-lex — see the generic-arrow note below — but that aborts the whole token,
// which is not what a mid-tag attribute value wants.) Rather
// than have the caller mis-read the remaining `>` as an ordinary open-tag end
// (which loses the self-closing flag and unbalances the depth counter), the
// value scan reports the slash it ate and the caller completes the `/>`.
// Pass NULL when the caller cannot be in that position.
static bool scan_expression(TSLexer *lexer, unsigned *budget, int32_t closer, bool terminated_by_ws,
                            bool *ate_slash);
static bool scan_template_string(TSLexer *lexer, unsigned *budget);

// Budget guard: every consuming loop decrements, so a malformed region cannot
// spin forever. Returns false once exhausted, which fails the whole scan.
static inline bool spend(unsigned *budget) {
    if (*budget == 0) {
        return false;
    }
    (*budget)--;
    return true;
}

// ---------------------------------------------------------------------------
// STRING.parse (scanner-rules §7). `\` advances 2; ends at the matching quote.
static bool scan_string(TSLexer *lexer, unsigned *budget, int32_t quote) {
    advance_mx(lexer); // opening quote
    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;
        if (c == '\\') {
            advance_mx(lexer);
            if (is_eof(lexer)) {
                return false;
            }
            advance_mx(lexer);
            continue;
        }
        if (c == quote) {
            advance_mx(lexer);
            return true;
        }
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// REGULAR_EXPRESSION.parse (scanner-rules §7). Tracks `isInCharSet` across
// `[`/`]`, `\` advances 2, ends at an unescaped `/` outside a char set, and
// errors on end-of-line.
static bool scan_regex(TSLexer *lexer, unsigned *budget) {
    advance_mx(lexer); // opening slash
    bool in_char_set = false;
    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;
        if (c == '\n' || c == '\r') {
            return false; // unterminated regex
        }
        if (c == '\\') {
            advance_mx(lexer);
            if (is_eof(lexer)) {
                return false;
            }
            advance_mx(lexer);
            continue;
        }
        if (c == '[') {
            in_char_set = true;
        } else if (c == ']') {
            in_char_set = false;
        } else if (c == '/' && !in_char_set) {
            advance_mx(lexer);
            // Trailing flags.
            while (!is_eof(lexer) && is_word_char(lexer->lookahead)) {
                if (!spend(budget)) {
                    return false;
                }
                advance_mx(lexer);
            }
            return true;
        }
        advance_mx(lexer);
    }
    return false;
}

// JS_COMMENT_LINE / JS_COMMENT_BLOCK (scanner-rules §7). Assumes the leading
// `/` is current and the next char is `/` or `*`.
static bool skip_js_comment(TSLexer *lexer, unsigned *budget) {
    advance_mx(lexer); // '/'
    if (lexer->lookahead == '/') {
        while (!is_eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
            if (!spend(budget)) {
                return false;
            }
            advance_mx(lexer);
        }
        return true;
    }
    // Block comment: ends at `*/`.
    advance_mx(lexer); // '*'
    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        if (lexer->lookahead == '*') {
            advance_mx(lexer);
            if (lexer->lookahead == '/') {
                advance_mx(lexer);
                return true;
            }
            continue;
        }
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// TEMPLATE_STRING.parse (scanner-rules §7). Ends at an unescaped backtick; on
// `${` advances 2 and re-enters EXPRESSION with `matchesCloseCurlyBrace`.
// Re-entry is via the state stack upstream, so nesting is arbitrarily deep —
// here that is ordinary C recursion. Verified upstream:
// `<div>${ `t${ {k:'}'} }` }</div>` consumes exactly, the `}` inside the string
// literal correctly ignored.
static bool scan_template_string(TSLexer *lexer, unsigned *budget) {
    advance_mx(lexer); // opening backtick
    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;
        if (c == '\\') {
            advance_mx(lexer);
            if (is_eof(lexer)) {
                return false;
            }
            advance_mx(lexer);
            continue;
        }
        if (c == '`') {
            advance_mx(lexer);
            return true;
        }
        if (c == '$') {
            advance_mx(lexer);
            if (lexer->lookahead == '{') {
                advance_mx(lexer);
                if (!scan_expression(lexer, budget, '}', false, NULL)) {
                    return false;
                }
            }
            continue;
        }
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// EXPRESSION.parse (scanner-rules §7).
//
// One `groupStack`: push at `(`→`)`, `[`→`]`, `{`→`}`; pop at the matching
// closer. `closer` is the delimiter that ends this expression when the stack is
// empty (`}` for a placeholder or `${}`, `)` for tag args, 0 for an attribute
// value that ends by its own rule).
//
// The load-bearing detail (scanner-rules §6): a terminator is consulted ONLY
// when the group stack is empty. That is exactly why `<div a="q>q">` and
// `<Foo a={x < y}>` both work — the `>` is inside a group or a string, so it
// does not end the tag.
//
// When `terminated_by_ws` is set this is an unquoted attribute value, and
// `shouldTerminateHtmlAttrValue` decides (§6):
//     case 44: `,`                                     -> terminate
//     case 47: `/` terminates only when followed by `>` (i.e. `/>`)
//     case 62: `>` terminates, EXCEPT `=>` (prev char `=`), and except
//              a `>` that is preceded by whitespace and followed by `=`.
static bool scan_expression(TSLexer *lexer, unsigned *budget, int32_t closer, bool terminated_by_ws,
                            bool *ate_slash) {
    int group_stack[256];
    int depth = 0;
    int32_t prev = 0; // previous non-whitespace char, for regex-vs-division

    if (ate_slash != NULL) {
        *ate_slash = false;
    }

    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;

        // Terminators are consulted only at group depth 0 (§6).
        if (depth == 0) {
            if (closer != 0 && c == closer) {
                advance_mx(lexer); // consume the closer
                return true;
            }
            if (terminated_by_ws) {
                if (is_ws(c)) {
                    return true; // value ends; caller re-reads the delimiter
                }
                if (c == ',') {
                    return true;
                }
                if (c == '>') {
                    // `=>` does not end the value.
                    if (prev != '=') {
                        return true;
                    }
                }
                if (c == '/') {
                    advance_mx(lexer);
                    if (lexer->lookahead == '>') {
                        // `/>`: the value ended before this slash, which is
                        // already consumed and cannot be un-consumed. Tell the
                        // caller, so it completes the `/>` rather than reading
                        // the remaining `>` as a plain open-tag end — that
                        // mistake drops the self-closing flag and leaves the
                        // depth counter one too deep, running the region to EOF.
                        if (ate_slash != NULL) {
                            *ate_slash = true;
                        }
                        return true;
                    }
                    // A plain `/` is division or a regex.
                    if (!can_follow_division(prev)) {
                        // Already consumed the `/`, so scan the rest of the
                        // pattern with the char-set/escape rules.
                        bool in_char_set = false;
                        while (!is_eof(lexer)) {
                            if (!spend(budget)) {
                                return false;
                            }
                            int32_t r = lexer->lookahead;
                            if (r == '\n' || r == '\r') {
                                return false;
                            }
                            if (r == '\\') {
                                advance_mx(lexer);
                                if (is_eof(lexer)) {
                                    return false;
                                }
                                advance_mx(lexer);
                                continue;
                            }
                            if (r == '[') {
                                in_char_set = true;
                            } else if (r == ']') {
                                in_char_set = false;
                            } else if (r == '/' && !in_char_set) {
                                advance_mx(lexer);
                                while (!is_eof(lexer) && is_word_char(lexer->lookahead)) {
                                    if (!spend(budget)) {
                                        return false;
                                    }
                                    advance_mx(lexer);
                                }
                                break;
                            }
                            advance_mx(lexer);
                        }
                    }
                    prev = '/';
                    continue;
                }
            }
        }

        switch (c) {
            case '"':
            case '\'':
                if (!scan_string(lexer, budget, c)) {
                    return false;
                }
                prev = c;
                continue;
            case '`':
                if (!scan_template_string(lexer, budget)) {
                    return false;
                }
                prev = '`';
                continue;
            case '/': {
                // Comment, regex or division (§7).
                advance_mx(lexer);
                int32_t next = lexer->lookahead;
                if (next == '/' || next == '*') {
                    // skip_js_comment expects the leading `/` current; emulate
                    // by handling the body here.
                    if (next == '/') {
                        while (!is_eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
                            if (!spend(budget)) {
                                return false;
                            }
                            advance_mx(lexer);
                        }
                    } else {
                        advance_mx(lexer); // '*'
                        bool closed = false;
                        while (!is_eof(lexer)) {
                            if (!spend(budget)) {
                                return false;
                            }
                            if (lexer->lookahead == '*') {
                                advance_mx(lexer);
                                if (lexer->lookahead == '/') {
                                    advance_mx(lexer);
                                    closed = true;
                                    break;
                                }
                                continue;
                            }
                            advance_mx(lexer);
                        }
                        if (!closed) {
                            return false;
                        }
                    }
                    continue; // `prev` unchanged: a comment is not an operand
                }
                if (!can_follow_division(prev)) {
                    // Regex literal; the opening `/` is already consumed.
                    bool in_char_set = false;
                    bool closed = false;
                    while (!is_eof(lexer)) {
                        if (!spend(budget)) {
                            return false;
                        }
                        int32_t r = lexer->lookahead;
                        if (r == '\n' || r == '\r') {
                            return false;
                        }
                        if (r == '\\') {
                            advance_mx(lexer);
                            if (is_eof(lexer)) {
                                return false;
                            }
                            advance_mx(lexer);
                            continue;
                        }
                        if (r == '[') {
                            in_char_set = true;
                        } else if (r == ']') {
                            in_char_set = false;
                        } else if (r == '/' && !in_char_set) {
                            advance_mx(lexer);
                            while (!is_eof(lexer) && is_word_char(lexer->lookahead)) {
                                if (!spend(budget)) {
                                    return false;
                                }
                                advance_mx(lexer);
                            }
                            closed = true;
                            break;
                        }
                        advance_mx(lexer);
                    }
                    if (!closed) {
                        return false;
                    }
                    prev = '/';
                    continue;
                }
                prev = '/';
                continue;
            }
            case '(':
            case '[':
            case '{':
                if (depth >= (int)(sizeof(group_stack) / sizeof(group_stack[0]))) {
                    return false; // pathological nesting
                }
                group_stack[depth++] = (c == '(') ? ')' : (c == '[') ? ']' : '}';
                prev = c;
                advance_mx(lexer);
                continue;
            case ')':
            case ']':
            case '}':
                if (depth > 0 && group_stack[depth - 1] == c) {
                    depth--;
                    prev = c;
                    advance_mx(lexer);
                    continue;
                }
                // An unmatched closer at depth 0 that is not our terminator
                // ends the expression without consuming — the caller decides.
                return true;
            default:
                break;
        }

        if (!is_ws(c)) {
            prev = c;
        }
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// A NOTE ON MX-VS-GENERIC-ARROW, AND WHY THERE IS NO LOOKAHEAD HERE.
//
// Scanning optimistically — starting at any `<` and simply failing when there
// is no element — is not a shortcut; it is the mechanism. A `<T,>` is rejected
// because the scan runs out of input without finding a close tag, and
// tree-sitter then re-lexes the position internally as an ordinary `<`.
//
// Two things are worth stating precisely, because both are easy to get wrong:
//
//   * An external scanner CAN peek. Advancing and then returning false
//     discards the consumption: tree-sitter re-lexes from the original
//     position. Verified here with `tree-sitter parse --debug` on
//     `const f = <T,>(x: T) => x;` — at the `<`, `lex_external` runs and
//     consumes to end-of-line, then `lex_internal` re-lexes from the same
//     column and emits `sym:<`. Upstream relies on this too: several branches
//     of `scan_automatic_semicolon` in common/scanner.h skip characters and
//     then return false. So a peek-then-decline lookahead would have been a
//     legal design; it is simply not the one used, because failing the scan
//     already produces the same outcome with no extra code.
//
//   * The tsx GLR conflict does NOT transfer. Upstream declares
//     `[$.jsx_opening_element, $.type_parameter]` and marks the JSX rules
//     `prec.dynamic(-1)`, which works because `jsx_opening_element` is a
//     multi-symbol RULE the parser can fork on. `mx_element` is a single
//     external TOKEN, so the choice is made in the lexer and never reaches a
//     GLR fork; declaring the equivalent conflict only produces a permanent
//     `Warning: unnecessary conflicts` from `tree-sitter generate`. That is
//     why the patch to common/define-grammar.js deliberately omits it.
//
// The behaviour is pinned in both directions by test/corpus/generics.txt.
//
// ---------------------------------------------------------------------------
// TAG_NAME.parse (scanner-rules §4).
//
// The name terminates on whitespace, `=`, `:` followed by `=`, `(`, `/`, `|`,
// `<`, `,` or `>`. `.` and `#` do NOT end it — they restart TAG_NAME as a
// shorthand class/id sub-state, so `<div.card#main>` is one name plus two
// shorthands (and `</div>` still matches it). `${` in a name enters EXPRESSION,
// producing a dynamic name `<${comp()}/>` with staticName null.
//
// `name_out`/`name_len` receive the base name only (before any `.`/`#`), which
// is what the void-tag test and the close-tag match need.
static bool scan_tag_name(TSLexer *lexer, unsigned *budget, char *name_out, unsigned *name_len,
                          bool *is_dynamic) {
    *name_len = 0;
    *is_dynamic = false;
    bool in_base = true;

    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;

        if (c == '$') {
            advance_mx(lexer);
            if (lexer->lookahead == '{') {
                advance_mx(lexer);
                *is_dynamic = true;
                in_base = false;
                if (!scan_expression(lexer, budget, '}', false, NULL)) {
                    return false;
                }
                continue;
            }
            continue;
        }

        if (is_ws(c) || c == '=' || c == '(' || c == '/' || c == '|' || c == '<' ||
            c == ',' || c == '>') {
            return true;
        }
        if (c == ':') {
            // `:` ends the name only when it is `:=` (a bound attribute).
            advance_mx(lexer);
            if (lexer->lookahead == '=') {
                return true;
            }
            in_base = false;
            continue;
        }
        if (c == '.' || c == '#') {
            in_base = false; // shorthand class/id follows; base name is done
            advance_mx(lexer);
            continue;
        }

        if (in_base && *name_len < 63) {
            name_out[(*name_len)++] = (char)c;
        }
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// OPEN_TAG.parse (scanner-rules §5, §6, §9.3, §13).
//
// Handles, after the name: tag var `/x`, tag args `(…)`, tag params `|…|`, tag
// type args `<Bar>`, then attributes — `=`, `:=` (bound), `...` (spread), and
// attribute methods `name(p) { … }`.
//
// Sets `*self_closed` when the tag ended `/>`. Returns false only on malformed
// input that runs to EOF.
static bool scan_open_tag(TSLexer *lexer, unsigned *budget, bool *self_closed) {
    *self_closed = false;

    while (!is_eof(lexer)) {
        if (!spend(budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;

        if (is_ws(c)) {
            advance_mx(lexer);
            continue;
        }

        if (c == '>') {
            advance_mx(lexer);
            return true;
        }

        if (c == '/') {
            advance_mx(lexer);
            if (lexer->lookahead == '>') {
                advance_mx(lexer);
                *self_closed = true;
                return true;
            }
            // Tag variable `<div/el>`: the name after `/` is scanned as an
            // ordinary attribute-ish run by the loop below.
            continue;
        }

        // Tag type args `Foo<Bar>` (§9.3). Within `inType`, `<` pushes so
        // nested generics balance; `>` pops. This is type argument syntax, not
        // a nested element — verified upstream: `<Foo<Bar> x=1/>` reports the
        // open tag name as just `Foo` and consumes the whole thing.
        //
        // APPROXIMATION, stated deliberately: this counts `<` and `>` without
        // string or comment awareness, so a `>` inside a string type literal
        // (`<Foo<"a>b">`) closes the type-argument list early. htmljs is more
        // precise here — it runs a full EXPRESSION with `inType`.
        //
        // Why that is safe rather than merely tolerable: a mis-balanced count
        // makes the scan diverge from the real tag shape, and every path out of
        // that divergence is a FAILED token, not a wrong one. The scan either
        // hits EOF without the root closing (returns false), or exhausts
        // `spend()`'s budget (returns false). A failed `mx_element` degrades to
        // an ordinary TypeScript parse error at the `<`, which is the same
        // fallback that rejects a generic arrow. The clamp below additionally
        // stops a stray `>` from driving the count negative and terminating the
        // loop as if the list had balanced.
        if (c == '<') {
            int angle_depth = 0;
            do {
                if (!spend(budget)) {
                    return false;
                }
                if (lexer->lookahead == '<') {
                    angle_depth++;
                } else if (lexer->lookahead == '>') {
                    if (angle_depth > 0) {
                        angle_depth--;
                    }
                } else if (is_eof(lexer)) {
                    return false;
                }
                advance_mx(lexer);
            } while (angle_depth > 0 && !is_eof(lexer));
            continue;
        }

        // Tag args `(…)` and attribute-method parameter lists.
        if (c == '(') {
            advance_mx(lexer);
            if (!scan_expression(lexer, budget, ')', false, NULL)) {
                return false;
            }
            continue;
        }

        // Attribute method body `name(p) { … }` (§13). A `{` here is the block
        // body, scanned as a balanced expression.
        if (c == '{') {
            advance_mx(lexer);
            if (!scan_expression(lexer, budget, '}', false, NULL)) {
                return false;
            }
            continue;
        }

        // Tag params `|a, b|` (§13). Ends at the matching `|`.
        if (c == '|') {
            advance_mx(lexer);
            while (!is_eof(lexer) && lexer->lookahead != '|') {
                if (!spend(budget)) {
                    return false;
                }
                advance_mx(lexer);
            }
            if (is_eof(lexer)) {
                return false;
            }
            advance_mx(lexer); // closing `|`
            continue;
        }

        // Spread `...expr` (§6).
        if (c == '.') {
            advance_mx(lexer);
            continue;
        }

        // Attribute value: `=` or `:=` enters EXPRESSION with
        // terminatedByWhitespace and shouldTerminateHtmlAttrValue (§6).
        if (c == '=') {
            advance_mx(lexer);
            while (is_ws(lexer->lookahead)) {
                advance_mx(lexer);
            }
            if (lexer->lookahead == '"' || lexer->lookahead == '\'') {
                if (!scan_string(lexer, budget, lexer->lookahead)) {
                    return false;
                }
                continue;
            }
            bool value_ate_slash = false;
            if (!scan_expression(lexer, budget, 0, true, &value_ate_slash)) {
                return false;
            }
            if (value_ate_slash) {
                // The value ended at `/>` and the `/` is already consumed;
                // finish the self-closing tag here (see `ate_slash`).
                if (lexer->lookahead == '>') {
                    advance_mx(lexer);
                    *self_closed = true;
                    return true;
                }
            }
            continue;
        }

        // Anything else is part of an attribute name; consume it.
        advance_mx(lexer);
    }
    return false;
}

// ---------------------------------------------------------------------------
// Markup declarations at `<` in text position (scanner-rules §10).
//
// `<!--` is an HTML comment; note HTML_COMMENT.parse ends at `indexOf("->")`,
// because it enters having already consumed `<!--`. `<![CDATA[` ends at `]]>`;
// `<!` otherwise is a doctype/DTD and `<?` a declaration, both ending at `>`.
// Assumes `<` is consumed and `!` or `?` is current.
static bool scan_markup_decl(TSLexer *lexer, unsigned *budget) {
    if (lexer->lookahead == '?') {
        while (!is_eof(lexer) && lexer->lookahead != '>') {
            if (!spend(budget)) {
                return false;
            }
            advance_mx(lexer);
        }
        if (is_eof(lexer)) {
            return false;
        }
        advance_mx(lexer);
        return true;
    }

    advance_mx(lexer); // '!'

    if (lexer->lookahead == '[') {
        // CDATA: ends at `]]>`.
        while (!is_eof(lexer)) {
            if (!spend(budget)) {
                return false;
            }
            if (lexer->lookahead == ']') {
                advance_mx(lexer);
                if (lexer->lookahead == ']') {
                    advance_mx(lexer);
                    if (lexer->lookahead == '>') {
                        advance_mx(lexer);
                        return true;
                    }
                }
                continue;
            }
            advance_mx(lexer);
        }
        return false;
    }

    if (lexer->lookahead == '-') {
        advance_mx(lexer);
        if (lexer->lookahead == '-') {
            advance_mx(lexer);
            // Ends at `->` (upstream's indexOf("->"), having consumed `<!--`).
            while (!is_eof(lexer)) {
                if (!spend(budget)) {
                    return false;
                }
                if (lexer->lookahead == '-') {
                    advance_mx(lexer);
                    if (lexer->lookahead == '>') {
                        advance_mx(lexer);
                        return true;
                    }
                    continue;
                }
                advance_mx(lexer);
            }
            return false;
        }
    }

    // Doctype / DTD: ends at `>`.
    while (!is_eof(lexer) && lexer->lookahead != '>') {
        if (!spend(budget)) {
            return false;
        }
        advance_mx(lexer);
    }
    if (is_eof(lexer)) {
        return false;
    }
    advance_mx(lexer);
    return true;
}

// ---------------------------------------------------------------------------
// The region scan (scanner-rules §1, §2, §5, §8, §9.2).
//
// Termination is exactly two cases, and anything else is failure rather than a
// stop (§2):
//   1. `onCloseTagEnd` with an empty stack — the root's `</name>` completed.
//   2. `onOpenTagEnd` with `closesItself && stack empty` — the root wrote `/>`
//      or the root is a void tag.
// End-of-input without either is "Unterminated MX element." upstream
// (walk.ts:374-380); here it is a failed token, which lets the parser report a
// normal syntax error at the `<`.
// Assumes the root tag's leading `<` has ALREADY been consumed by the caller
// and that the caller has already ruled out the four things that cannot
// follow it here — `!`/`?` (markup declaration), `/` (a stray close tag) and
// `>` (an empty fragment, not an element). The only caller is mx_scan_at_lt,
// which consumes `<` itself, decides fragment-vs-element on the very next
// character, and continues straight into this body without a second,
// redundant consumption of `<` (a TSLexer cannot unconsume — see
// mx_scan_at_lt's own comment).
static bool scan_mx_element_body(TSLexer *lexer) {
    unsigned budget = MX_MAX_SCAN;

    char root_name[64];
    unsigned root_len = 0;
    bool root_dynamic = false;
    if (!scan_tag_name(lexer, &budget, root_name, &root_len, &root_dynamic)) {
        return false;
    }
    if (root_len == 0 && !root_dynamic) {
        return false; // `< ` is not a tag (§9.2)
    }

    bool self_closed = false;
    if (!scan_open_tag(lexer, &budget, &self_closed)) {
        return false;
    }

    // Case 2: the root closed itself, by `/>` or by being void (§2, §5).
    if (self_closed || (!root_dynamic && is_void_tag(root_name, root_len))) {
        lexer->mark_end(lexer);
        return true;
    }

    // Depth 1: inside the root. Increment on a non-self-closing open tag
    // (walk.ts:303), decrement on a close tag (walk.ts:334).
    int depth = 1;

    while (!is_eof(lexer)) {
        if (!spend(&budget)) {
            return false;
        }
        int32_t c = lexer->lookahead;

        if (c == '<') {
            advance_mx(lexer);
            int32_t next = lexer->lookahead;

            // `<` is literal text when followed by `>`, `<` or whitespace
            // (§9.2) — this is why `<div>a < b</div>` works.
            if (next == '>' || next == '<' || is_ws(next) || is_eof(lexer)) {
                continue;
            }

            if (next == '!' || next == '?') {
                if (!scan_markup_decl(lexer, &budget)) {
                    return false;
                }
                continue;
            }

            if (next == '/') {
                // CLOSE_TAG.parse is a bare indexOf(">") — no string or comment
                // awareness inside a close tag (§5).
                advance_mx(lexer);
                while (!is_eof(lexer) && lexer->lookahead != '>') {
                    if (!spend(&budget)) {
                        return false;
                    }
                    advance_mx(lexer);
                }
                if (is_eof(lexer)) {
                    return false;
                }
                advance_mx(lexer); // '>'
                depth--;
                if (depth == 0) {
                    // Case 1: the root's close tag completed (§2).
                    lexer->mark_end(lexer);
                    return true;
                }
                continue;
            }

            // A nested open tag.
            char name[64];
            unsigned len = 0;
            bool dynamic = false;
            if (!scan_tag_name(lexer, &budget, name, &len, &dynamic)) {
                return false;
            }
            bool nested_self_closed = false;
            if (!scan_open_tag(lexer, &budget, &nested_self_closed)) {
                return false;
            }
            // Void tags are depth-neutral (§5, Z12).
            if (!nested_self_closed && !(!dynamic && is_void_tag(name, len))) {
                depth++;
            }
            continue;
        }

        // Placeholders `${}` / `$!{}` in text (§8).
        //
        // checkForPlaceholder counts leading backslashes first, so `\${x}` is an
        // escaped literal and `\\${x}` is an escape plus a live placeholder.
        // `{expr}` alone is NOT a placeholder — it is plain text — so `{` is
        // consumed as an ordinary character here, deliberately.
        if (c == '\\') {
            advance_mx(lexer);
            if (!is_eof(lexer)) {
                advance_mx(lexer); // the escaped char, `$` included
            }
            continue;
        }

        if (c == '$') {
            advance_mx(lexer);
            if (lexer->lookahead == '!') {
                advance_mx(lexer);
                if (lexer->lookahead == '{') {
                    advance_mx(lexer);
                    if (!scan_expression(lexer, &budget, '}', false, NULL)) {
                        return false;
                    }
                }
                continue;
            }
            if (lexer->lookahead == '{') {
                advance_mx(lexer);
                if (!scan_expression(lexer, &budget, '}', false, NULL)) {
                    return false;
                }
            }
            continue;
        }

        advance_mx(lexer);
    }

    return false; // EOF without the root closing: "Unterminated MX element."
}

// ---------------------------------------------------------------------------
// Fragment delimiters, `<>` and `</>` (mx_fragment_open / mx_fragment_close).
//
// Each is a fixed two- or three-character token, decided purely by lookahead
// — no region scan, since a fragment has no root tag of its own. The grammar
// rule (common/define-grammar.js's mx_fragment) then treats each `<tag>`
// child as its own ordinary mx_element, and a nested `<>` as its own nested
// mx_fragment.
//
// Precedence against mx_element and the tsx `<` token is entirely the
// caller's (scanner.c): mx_fragment_open is offered only when the grammar
// position admits it (an mx_fragment child or top-level expression) AND the
// next non-`<` character is `>` — anywhere else `<` falls through to
// mx_element (a real tag) or, failing that, the internal `<` token (a type
// parameter list). Because this scanner only fires when
// valid_symbols[MX_FRAGMENT_OPEN] is set, `<div>` and `<T,>` are never
// offered this path at all; only literal `<>` is.
// The combined entry point for `<` when the grammar admits mx_element and/or
// either fragment delimiter at this position (all three are tried together,
// never in separate top-level calls): a TSLexer cannot unconsume, so once
// this function has advanced past `<` to look at the next character, that
// decision is final for the rest of the current external_scanner_scan call —
// tree-sitter only resets lexer position between SEPARATE calls to that
// entry point, not between nested C calls chained inside one (confirmed:
// advancing past `<` in one nested attempt and returning false left the very
// next nested attempt, in the same dispatch, seeing the following character
// rather than `<` again). So there can only be one attempt per `<`, and it
// must decide the full shape — fragment vs. element vs. neither — itself.
static bool mx_scan_at_lt(TSLexer *lexer, bool want_element, bool want_open, bool want_close) {
    while (is_ws(lexer->lookahead)) {
        lexer->advance(lexer, true);
    }
    if (lexer->lookahead != '<') {
        return false;
    }
    advance_mx(lexer); // the leading `<`, common to all three shapes

    if (want_close && lexer->lookahead == '/') {
        advance_mx(lexer);
        if (lexer->lookahead != '>') {
            return false;
        }
        advance_mx(lexer);
        lexer->result_symbol = MX_FRAGMENT_CLOSE;
        lexer->mark_end(lexer);
        return true;
    }

    if (want_open && lexer->lookahead == '>') {
        advance_mx(lexer);
        lexer->result_symbol = MX_FRAGMENT_OPEN;
        lexer->mark_end(lexer);
        return true;
    }

    // Not a fragment delimiter — go straight into the element body from
    // right after `<`, already consumed above. There is no separate
    // "scan_mx_element" entry point left to re-enter here: an element scan
    // always starts by consuming `<` and then running exactly this
    // discrimination, so a second function repeating it would just consume
    // `<` a second time, which a TSLexer cannot do.
    if (!want_element) {
        return false;
    }
    lexer->result_symbol = MX_ELEMENT;
    return scan_mx_element_body(lexer);
}
