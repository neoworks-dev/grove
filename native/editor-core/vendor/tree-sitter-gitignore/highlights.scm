; Written for Grove: the grammar ships no query.

(comment) @comment

(negation) @operator

(pattern_char) @string

[
  (directory_separator)
  (directory_separator_escaped)
] @punctuation.delimiter

[
  (wildcard_char_single)
  (wildcard_chars)
  (wildcard_chars_allow_slash)
] @operator

(pattern_char_escaped) @string.escape

(bracket_expr
  "[" @punctuation.bracket
  "]" @punctuation.bracket)

(bracket_negation) @operator

(bracket_char) @string.special

(bracket_char_escaped) @string.escape

(bracket_range) @string.special

(bracket_char_class) @constant.builtin
