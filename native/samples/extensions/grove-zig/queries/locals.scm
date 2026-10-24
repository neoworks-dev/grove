; A name used inside a function is coloured as the parameter or variable it refers to.

[
  (function_declaration)
  (block)
] @local.scope

(parameter
  name: (identifier) @local.definition.parameter)

(variable_declaration
  (identifier) @local.definition.var)

(identifier) @local.reference
