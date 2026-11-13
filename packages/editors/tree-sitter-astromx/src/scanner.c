#include <tree_sitter/parser.h>
#include <wctype.h>
#include <string.h>

enum TokenType {
    FENCE,
    FRONTMATTER_CONTENT,
    BODY
};

void *tree_sitter_astromx_external_scanner_create() {
    return NULL;
}

void tree_sitter_astromx_external_scanner_destroy(void *payload) {}

unsigned tree_sitter_astromx_external_scanner_serialize(void *payload, char *buffer) {
    return 0;
}

void tree_sitter_astromx_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static void advance(TSLexer *lexer) {
    lexer->advance(lexer, false);
}

static void skip(TSLexer *lexer) {
    lexer->advance(lexer, true);
}

bool tree_sitter_astromx_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[FENCE]) {
        if (lexer->get_column(lexer) != 0) return false;

        // Look for exactly `---` followed by a newline, or EOF.
        // It should start at the current position.
        
        // Skip leading whitespace? No, Astro fence must be exactly `---` at the beginning.
        // But what if it's the second fence? 

        
        bool found = false;
        if (lexer->lookahead == '-') {
            advance(lexer);
            if (lexer->lookahead == '-') {
                advance(lexer);
                if (lexer->lookahead == '-') {
                    advance(lexer);
                    
                    // Allow trailing spaces before newline
                    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                        advance(lexer);
                    }
                    
                    if (lexer->lookahead == '\r') {
                        advance(lexer);
                    }
                    if (lexer->lookahead == '\n') {
                        advance(lexer);
                        found = true;
                    } else if (lexer->lookahead == 0) {
                        found = true;
                    }
                }
            }
        }
        
        if (found) {
            lexer->result_symbol = FENCE;
            return true;
        }
    }
    
    if (valid_symbols[FRONTMATTER_CONTENT]) {
        // Consume anything until we see a line starting with `---`
        // We might be at the start of a line right now (right after the first FENCE)
        
        bool has_content = false;
        
        while (lexer->lookahead != 0) {
            if (lexer->lookahead == '-') {
                lexer->mark_end(lexer);
                advance(lexer);
                if (lexer->lookahead == '-') {
                    advance(lexer);
                    if (lexer->lookahead == '-') {
                        advance(lexer);
                        // Is this followed by whitespace and newline?
                        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                            advance(lexer);
                        }
                        if (lexer->lookahead == '\n' || lexer->lookahead == '\r' || lexer->lookahead == 0) {
                            // Found the closing fence, don't consume it
                            if (has_content) {
                                lexer->result_symbol = FRONTMATTER_CONTENT;
                                return true;
                            }
                            return false; // Let the grammar parse the FENCE
                        }
                    }
                }
                // Not a valid fence, consume the character and continue
            } else {
                advance(lexer);
                lexer->mark_end(lexer);
                has_content = true;
            }
        }
        
        if (has_content) {
            lexer->result_symbol = FRONTMATTER_CONTENT;
            return true;
        }
    }
    
    if (valid_symbols[BODY]) {
        if (lexer->lookahead == 0) return false;
        
        while (lexer->lookahead != 0) {
            advance(lexer);
        }
        
        lexer->result_symbol = BODY;
        return true;
    }

    return false;
}
