/**
 * Tree-sitter grammar for Marko templates.
 *
 * This grammar is a faithful port of htmljs-parser (../src). Because nearly
 * all of Marko's syntax is context sensitive (concise mode indentation,
 * expression terminators that depend on the surrounding construct, operator
 * continuation across whitespace, parsed-text tags like <script>, etc.) every
 * terminal is produced by the external scanner in src/scanner.c, which ports
 * the parser's state machine. The rules below only describe how those tokens
 * compose, mirroring the event stream emitted by createParser().
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "mx",

  // Whitespace is significant almost everywhere (text content, expression
  // termination, concise indentation), so there are no extras; the external
  // scanner skips insignificant trivia (whitespace/commas/comments inside
  // open tags) itself, exactly where htmljs-parser does.
  extras: () => [],

  externals: ($) => [
    $.text,
    $.placeholder_start, // "${" (escape=true placeholders)
    $.placeholder_start_raw, // "$!{"
    $._interp_start, // "${" within tag names / shorthands
    $._placeholder_text, // MX: placeholder_expr up to its first atom
    $._placeholder_end, // "}"
    $.html_comment, // "<!--" ... "->"
    $.line_comment, // "//" ...
    $.block_comment, // "/*" ... "*/"
    $.cdata, // "<![CDATA[" ... "]]>"
    $.doctype, // "<!" ... ">"
    $.declaration, // "<?" ... ">" | "?>"
    $.scriptlet_start, // "$" at the start of a line in html mode
    $.scriptlet_start_concise, // "$" at the start of a concise line
    $._scriptlet_block_open, // "{"
    $.scriptlet_block_expr,
    $._scriptlet_block_close, // "}" plus an optional trailing ";"
    $.scriptlet_expr, // statement after "$ "
    $._block_open, // "--", "---", ... starting a delimited html block
    $._block_close, // matching delimiter line, or zero-width
    $.open_tag_start, // "<"
    $.tag_name_fragment, // run of tag name characters between placeholders
    $._tag_name_empty, // zero-width: shorthand-only tags like <.foo>
    $._shorthand_id_start, // "#"
    $._shorthand_class_start, // "."
    $._shorthand_name_start, // ":" (MX: name="..." sugar)
    $._attr_shorthand_id_start, // "#" in attribute position
    $._attr_shorthand_class_start, // "." in attribute position
    $._attr_shorthand_name_start, // ":" in attribute position
    $.statement_expr, // body of statement tags (import/export/static/class)
    $._tag_var_start, // "/"
    $.var_pattern, // tag variable binding pattern (before any ": type")
    $._var_colon, // ":" between a tag var pattern and its type
    $.var_type, // tag variable type annotation
    $._args_open, // "("
    $._args_text, // MX: args_expr up to its first atom
    $._args_close, // ")"
    $._params_open, // "|"
    $.param_pattern, // parameter binding pattern
    $._param_colon, // ":" before a parameter type
    $.param_type, // parameter type annotation
    $._param_eq, // "=" before a parameter default
    $.param_default, // parameter default value expression
    $._param_comma, // "," between parameters
    $._params_close, // "|"
    $._type_args_open, // "<" directly after the tag name
    $._type_params_open, // "<" before tag params or a method shorthand
    $.type_expr,
    $._types_close, // ">"
    $._attr_group_open, // "[" (concise mode)
    $._attr_group_close, // "]"
    $.attr_name,
    $.attr_eq, // "="
    $.attr_bound_eq, // ":="
    $._attr_spread_start, // "..."
    $._attr_value_text, // MX: attr_value_expr up to its first atom
    $._method_body_open, // "{"
    $._method_body_text, // MX: method_body_expr up to its first atom
    $._method_body_close, // "}"
    $.open_tag_end, // ">"
    $.open_tag_end_self, // "/>"
    $.concise_open_tag_end, // zero-width (EOL/EOF/"--") or ";"
    $.close_tag_start, // "</"
    $.close_tag_name, // may be zero-width for "</>"
    $.close_tag_end, // ">"
    $.element_end, // zero-width: dedent, void, self-closed, EOF, after </x>
    $._tag_comment, // "//..." or "/*...*/" inside an open tag (no events)
    $.escape, // backslash run before an escaped/double-escaped "${"
    $.atom, // MX (decision 156): `:name` where an expression is expected
    $.reserved_atom, // MX: `::name`, reserved (decision 156)
    $._expr_more, // MX: an expression resumed after an atom
    $._error_sentinel, // never emitted; detects error recovery
  ],

  rules: {
    document: ($) => repeat($._child),

    _child: ($) =>
      choice(
        $.element,
        $.text,
        $.placeholder,
        $.html_comment,
        $.line_comment,
        $.block_comment,
        $.cdata,
        $.doctype,
        $.declaration,
        $.scriptlet,
        $.html_block,
        $.escape,
      ),

    // Covers html mode (<a>...</a>, <br>, <input/>), concise mode (indent
    // based, ended by a zero-width element_end at the dedent), statement tags
    // (import/export/static/class) and parsed-text tags (script/style/
    // textarea/html-comment whose bodies only contain text & placeholders).
    element: ($) =>
      seq(
        optional($.open_tag_start),
        $.tag_name,
        // `shorthand` marks the tag-adjacent ones, so queries can tell
        // `<style.scss>` from an attribute-position `<style .scss>`.
        repeat(
          field(
            "shorthand",
            choice($.shorthand_id, $.shorthand_class, $.shorthand_name),
          ),
        ),
        optional($.statement_expr),
        repeat($._tag_part),
        choice($.open_tag_end, $.open_tag_end_self, $.concise_open_tag_end),
        repeat($._child),
        optional($.close_tag),
        $.element_end,
      ),

    tag_name: ($) => choice(repeat1($._tag_name_part), $._tag_name_empty),

    shorthand_id: ($) => seq($._shorthand_id_start, repeat($._tag_name_part)),

    shorthand_class: ($) =>
      seq($._shorthand_class_start, repeat($._tag_name_part)),

    // `:b` sets name="b" the way `#b` sets id and `.b` sets class.
    shorthand_name: ($) =>
      seq($._shorthand_name_start, repeat($._tag_name_part)),

    // The same three shorthands in attribute position (first, or after any
    // attribute: `<input type="email" :email #main .big>`). Distinct start
    // tokens keep them apart from the tag-adjacent ones in the LR tables;
    // they are aliased to the same node names, so queries treat both alike.
    _attr_shorthand: ($) =>
      choice(
        alias($.attr_shorthand_id, $.shorthand_id),
        alias($.attr_shorthand_class, $.shorthand_class),
        alias($.attr_shorthand_name, $.shorthand_name),
      ),

    attr_shorthand_id: ($) =>
      seq($._attr_shorthand_id_start, repeat($._tag_name_part)),
    attr_shorthand_class: ($) =>
      seq($._attr_shorthand_class_start, repeat($._tag_name_part)),
    attr_shorthand_name: ($) =>
      seq($._attr_shorthand_name_start, repeat($._tag_name_part)),

    _tag_name_part: ($) =>
      choice($.tag_name_fragment, alias($.tag_name_placeholder, $.placeholder)),

    tag_name_placeholder: ($) =>
      seq(
        alias($._interp_start, $.placeholder_start),
        $.placeholder_expr,
        alias($._placeholder_end, $.placeholder_end),
      ),

    _tag_part: ($) =>
      choice(
        $.tag_var,
        $.args,
        $.params,
        $.type_args,
        $.type_params,
        $.attr_group,
        $._attr_shorthand,
        $.attr_name,
        $.attr_value,
        $.attr_bound_value,
        $.attr_spread,
        $.method_body,
        $._tag_comment,
      ),

    tag_var: ($) => seq($._tag_var_start, $.tag_var_expr),

    // The pattern/type split happens exactly where the parser's expression
    // scanner enters type mode (a top-level ":" outside a ternary), so the
    // node's extent always equals the parser's tagVar value range.
    tag_var_expr: ($) =>
      seq($.var_pattern, optional(seq($._var_colon, $.var_type))),

    // Delimiter tokens are visible named nodes (aliased from the hidden
    // externals) so editors can pair them in bracket-matching queries and
    // capture them as punctuation; they map to no parser events.
    args: ($) =>
      seq(
        alias($._args_open, $.args_open),
        optional($.args_expr),
        alias($._args_close, $.args_close),
      ),
    params: ($) =>
      seq(
        alias($._params_open, $.params_open),
        optional($.params_expr),
        alias($._params_close, $.params_close),
      ),

    // Parameters split at depth-0 commas/colons/equals; the scanner keeps
    // the parser's exact "|" termination so the extent is unchanged.
    params_expr: ($) => seq($.param, repeat(seq($._param_comma, $.param))),

    param: ($) =>
      seq(
        $.param_pattern,
        optional(seq($._param_colon, $.param_type)),
        optional(seq($._param_eq, $.param_default)),
      ),
    type_args: ($) =>
      seq(
        alias($._type_args_open, $.type_open),
        optional($.type_expr),
        alias($._types_close, $.type_close),
      ),
    type_params: ($) =>
      seq(
        alias($._type_params_open, $.type_open),
        optional($.type_expr),
        alias($._types_close, $.type_close),
      ),
    attr_group: ($) =>
      seq(
        alias($._attr_group_open, $.attr_group_open),
        repeat($._tag_part),
        alias($._attr_group_close, $.attr_group_close),
      ),
    attr_value: ($) => seq($.attr_eq, $.attr_value_expr),
    attr_bound_value: ($) => seq($.attr_bound_eq, $.attr_value_expr),
    attr_spread: ($) => seq($._attr_spread_start, $.attr_value_expr),
    method_body: ($) =>
      seq(
        alias($._method_body_open, $.method_body_open),
        optional($.method_body_expr),
        alias($._method_body_close, $.method_body_close),
      ),

    placeholder: ($) =>
      seq(
        choice($.placeholder_start, $.placeholder_start_raw),
        $.placeholder_expr,
        alias($._placeholder_end, $.placeholder_end),
      ),

    scriptlet: ($) =>
      seq(
        choice($.scriptlet_start, $.scriptlet_start_concise),
        choice($.scriptlet_block, $.scriptlet_expr),
      ),

    scriptlet_block: ($) =>
      seq(
        alias($._scriptlet_block_open, $.scriptlet_block_open),
        optional($.scriptlet_block_expr),
        alias($._scriptlet_block_close, $.scriptlet_block_close),
      ),

    html_block: ($) => seq($._block_open, repeat($._child), $._block_close),

    close_tag: ($) => seq($.close_tag_start, $.close_tag_name, $.close_tag_end),

    // MX (decision 156): an expression that holds atoms is split by the
    // scanner around each one; the hidden pieces are the expression text, so
    // an injection of the whole node (minus its children) never sees an atom.
    placeholder_expr: ($) => seq($._placeholder_text, repeat($._atom_piece)),
    args_expr: ($) => seq($._args_text, repeat($._atom_piece)),
    attr_value_expr: ($) => seq($._attr_value_text, repeat($._atom_piece)),
    method_body_expr: ($) =>
      seq($._method_body_text, repeat($._atom_piece)),
    _atom_piece: ($) => choice($.atom, $.reserved_atom, $._expr_more),
  },
});
