module.exports = grammar({
  name: "astromx",

  externals: ($) => [$._fence, $.frontmatter_content, $.body],

  rules: {
    source_file: ($) => seq(optional($.frontmatter), optional($.body)),

    frontmatter: ($) =>
      seq(
        alias($._fence, "---"),
        optional($.frontmatter_content),
        alias($._fence, "---"),
      ),
  },
});
