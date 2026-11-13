#include "tree_sitter/parser.h"

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#define LANGUAGE_VERSION 14
#define STATE_COUNT 10
#define LARGE_STATE_COUNT 2
#define SYMBOL_COUNT 6
#define ALIAS_COUNT 0
#define TOKEN_COUNT 4
#define EXTERNAL_TOKEN_COUNT 3
#define FIELD_COUNT 0
#define MAX_ALIAS_SEQUENCE_LENGTH 3
#define PRODUCTION_ID_COUNT 1

enum ts_symbol_identifiers {
  sym__fence = 1,
  sym_frontmatter_content = 2,
  sym_body = 3,
  sym_source_file = 4,
  sym_frontmatter = 5,
};

static const char * const ts_symbol_names[] = {
  [ts_builtin_sym_end] = "end",
  [sym__fence] = "---",
  [sym_frontmatter_content] = "frontmatter_content",
  [sym_body] = "body",
  [sym_source_file] = "source_file",
  [sym_frontmatter] = "frontmatter",
};

static const TSSymbol ts_symbol_map[] = {
  [ts_builtin_sym_end] = ts_builtin_sym_end,
  [sym__fence] = sym__fence,
  [sym_frontmatter_content] = sym_frontmatter_content,
  [sym_body] = sym_body,
  [sym_source_file] = sym_source_file,
  [sym_frontmatter] = sym_frontmatter,
};

static const TSSymbolMetadata ts_symbol_metadata[] = {
  [ts_builtin_sym_end] = {
    .visible = false,
    .named = true,
  },
  [sym__fence] = {
    .visible = true,
    .named = false,
  },
  [sym_frontmatter_content] = {
    .visible = true,
    .named = true,
  },
  [sym_body] = {
    .visible = true,
    .named = true,
  },
  [sym_source_file] = {
    .visible = true,
    .named = true,
  },
  [sym_frontmatter] = {
    .visible = true,
    .named = true,
  },
};

static const TSSymbol ts_alias_sequences[PRODUCTION_ID_COUNT][MAX_ALIAS_SEQUENCE_LENGTH] = {
  [0] = {0},
};

static const uint16_t ts_non_terminal_alias_map[] = {
  0,
};

static const TSStateId ts_primary_state_ids[STATE_COUNT] = {
  [0] = 0,
  [1] = 1,
  [2] = 2,
  [3] = 3,
  [4] = 4,
  [5] = 5,
  [6] = 6,
  [7] = 7,
  [8] = 8,
  [9] = 9,
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      if (eof) ADVANCE(1);
      END_STATE();
    case 1:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    default:
      return false;
  }
}

static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0, .external_lex_state = 1},
  [1] = {.lex_state = 0, .external_lex_state = 2},
  [2] = {.lex_state = 0, .external_lex_state = 3},
  [3] = {.lex_state = 0, .external_lex_state = 4},
  [4] = {.lex_state = 0, .external_lex_state = 4},
  [5] = {.lex_state = 0, .external_lex_state = 4},
  [6] = {.lex_state = 0},
  [7] = {.lex_state = 0},
  [8] = {.lex_state = 0, .external_lex_state = 5},
  [9] = {.lex_state = 0},
};

static const uint16_t ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT] = {
  [0] = {
    [ts_builtin_sym_end] = ACTIONS(1),
    [sym__fence] = ACTIONS(1),
    [sym_frontmatter_content] = ACTIONS(1),
    [sym_body] = ACTIONS(1),
  },
  [1] = {
    [sym_source_file] = STATE(7),
    [sym_frontmatter] = STATE(3),
    [ts_builtin_sym_end] = ACTIONS(3),
    [sym__fence] = ACTIONS(5),
    [sym_body] = ACTIONS(7),
  },
};

static const uint16_t ts_small_parse_table[] = {
  [0] = 2,
    ACTIONS(9), 1,
      sym__fence,
    ACTIONS(11), 1,
      sym_frontmatter_content,
  [7] = 2,
    ACTIONS(13), 1,
      ts_builtin_sym_end,
    ACTIONS(15), 1,
      sym_body,
  [14] = 1,
    ACTIONS(17), 2,
      sym_body,
      ts_builtin_sym_end,
  [19] = 1,
    ACTIONS(19), 2,
      sym_body,
      ts_builtin_sym_end,
  [24] = 1,
    ACTIONS(13), 1,
      ts_builtin_sym_end,
  [28] = 1,
    ACTIONS(21), 1,
      ts_builtin_sym_end,
  [32] = 1,
    ACTIONS(23), 1,
      sym__fence,
  [36] = 1,
    ACTIONS(25), 1,
      ts_builtin_sym_end,
};

static const uint32_t ts_small_parse_table_map[] = {
  [SMALL_STATE(2)] = 0,
  [SMALL_STATE(3)] = 7,
  [SMALL_STATE(4)] = 14,
  [SMALL_STATE(5)] = 19,
  [SMALL_STATE(6)] = 24,
  [SMALL_STATE(7)] = 28,
  [SMALL_STATE(8)] = 32,
  [SMALL_STATE(9)] = 36,
};

static const TSParseActionEntry ts_parse_actions[] = {
  [0] = {.entry = {.count = 0, .reusable = false}},
  [1] = {.entry = {.count = 1, .reusable = false}}, RECOVER(),
  [3] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 0, 0, 0),
  [5] = {.entry = {.count = 1, .reusable = true}}, SHIFT(2),
  [7] = {.entry = {.count = 1, .reusable = true}}, SHIFT(6),
  [9] = {.entry = {.count = 1, .reusable = true}}, SHIFT(4),
  [11] = {.entry = {.count = 1, .reusable = true}}, SHIFT(8),
  [13] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 1, 0, 0),
  [15] = {.entry = {.count = 1, .reusable = true}}, SHIFT(9),
  [17] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_frontmatter, 2, 0, 0),
  [19] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_frontmatter, 3, 0, 0),
  [21] = {.entry = {.count = 1, .reusable = true}},  ACCEPT_INPUT(),
  [23] = {.entry = {.count = 1, .reusable = true}}, SHIFT(5),
  [25] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 2, 0, 0),
};

enum ts_external_scanner_symbol_identifiers {
  ts_external_token__fence = 0,
  ts_external_token_frontmatter_content = 1,
  ts_external_token_body = 2,
};

static const TSSymbol ts_external_scanner_symbol_map[EXTERNAL_TOKEN_COUNT] = {
  [ts_external_token__fence] = sym__fence,
  [ts_external_token_frontmatter_content] = sym_frontmatter_content,
  [ts_external_token_body] = sym_body,
};

static const bool ts_external_scanner_states[6][EXTERNAL_TOKEN_COUNT] = {
  [1] = {
    [ts_external_token__fence] = true,
    [ts_external_token_frontmatter_content] = true,
    [ts_external_token_body] = true,
  },
  [2] = {
    [ts_external_token__fence] = true,
    [ts_external_token_body] = true,
  },
  [3] = {
    [ts_external_token__fence] = true,
    [ts_external_token_frontmatter_content] = true,
  },
  [4] = {
    [ts_external_token_body] = true,
  },
  [5] = {
    [ts_external_token__fence] = true,
  },
};

#ifdef __cplusplus
extern "C" {
#endif
void *tree_sitter_astromx_external_scanner_create(void);
void tree_sitter_astromx_external_scanner_destroy(void *);
bool tree_sitter_astromx_external_scanner_scan(void *, TSLexer *, const bool *);
unsigned tree_sitter_astromx_external_scanner_serialize(void *, char *);
void tree_sitter_astromx_external_scanner_deserialize(void *, const char *, unsigned);

#ifdef TREE_SITTER_HIDE_SYMBOLS
#define TS_PUBLIC
#elif defined(_WIN32)
#define TS_PUBLIC __declspec(dllexport)
#else
#define TS_PUBLIC __attribute__((visibility("default")))
#endif

TS_PUBLIC const TSLanguage *tree_sitter_astromx(void) {
  static const TSLanguage language = {
    .version = LANGUAGE_VERSION,
    .symbol_count = SYMBOL_COUNT,
    .alias_count = ALIAS_COUNT,
    .token_count = TOKEN_COUNT,
    .external_token_count = EXTERNAL_TOKEN_COUNT,
    .state_count = STATE_COUNT,
    .large_state_count = LARGE_STATE_COUNT,
    .production_id_count = PRODUCTION_ID_COUNT,
    .field_count = FIELD_COUNT,
    .max_alias_sequence_length = MAX_ALIAS_SEQUENCE_LENGTH,
    .parse_table = &ts_parse_table[0][0],
    .small_parse_table = ts_small_parse_table,
    .small_parse_table_map = ts_small_parse_table_map,
    .parse_actions = ts_parse_actions,
    .symbol_names = ts_symbol_names,
    .symbol_metadata = ts_symbol_metadata,
    .public_symbol_map = ts_symbol_map,
    .alias_map = ts_non_terminal_alias_map,
    .alias_sequences = &ts_alias_sequences[0][0],
    .lex_modes = ts_lex_modes,
    .lex_fn = ts_lex,
    .external_scanner = {
      &ts_external_scanner_states[0][0],
      ts_external_scanner_symbol_map,
      tree_sitter_astromx_external_scanner_create,
      tree_sitter_astromx_external_scanner_destroy,
      tree_sitter_astromx_external_scanner_scan,
      tree_sitter_astromx_external_scanner_serialize,
      tree_sitter_astromx_external_scanner_deserialize,
    },
    .primary_state_ids = ts_primary_state_ids,
  };
  return &language;
}
#ifdef __cplusplus
}
#endif
