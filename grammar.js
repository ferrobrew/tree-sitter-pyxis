/**
 * @file grammar.js
 * @fileoverview Tree-sitter grammar for the Pyxis DSL.
 *
 * Pyxis is a Rust-*inspired* IDL for describing game-engine type layouts,
 * vtables, bitflags, enums, extern bindings, and backend code splices.
 * It is its own language — not a strict subset of Rust — and includes
 * unique constructs such as `bitflags`, `vftable`, `backend`, and
 * `prologue`/`epilogue` splice slots.
 *
 * Derived from:
 *   - src/tokenizer/mod.rs TokenKind enum (keywords, punctuation, literals)
 *   - src/parser/module.rs ModuleItem variants
 *   - src/parser/items.rs, types.rs, functions.rs, external.rs, attributes.rs
 *
 * No external scanner is used: Pyxis has no significant whitespace and no
 * context-sensitive lexing, so a pure JS grammar suffices.
 */

const SCANNER = {
  // Reserved but not yet promoted to real keywords (kept out of the
  // `word` set so they can still appear as identifiers in attribute args).
};

module.exports = grammar({
  name: "pyxis",

  // Single-line comments start with // (or /// / //! doc variants).
  // Block comments are /* ... */ and may nest.
  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  // Nested item declarations inside `type` bodies: `type_definition` and
  // `type_alias` share the `type identifier` prefix, and `repeat($._type_statement)`
  // can't split consecutive nested definitions of the same kind without a
  // separator. A single combined conflict entry lets tree-sitter use GLR
  // parsing for all of these cases at once.
  conflicts: ($) => [
    [$.type_definition, $.enum_definition, $.bitflags_definition, $.type_alias, $.const_declaration, $.extern_value],
    [$.type_definition, $.type_alias],
    [$.enum_definition],
    [$.bitflags_definition],
    [$.type_definition],
    [$.type_alias],
    [$.const_declaration],
    [$.extern_value],
  ],

  // Keywords that should not be matched as identifiers.
  // `word` only governs identifier boundaries for keyword recognition via
  // the implicit `word` rule; reserved words below take precedence.
  rules: {
    source_file: ($) => repeat($._module_item),

    // ========================================================================
    // Module items (src/parser/module.rs ModuleItem)
    // ========================================================================
    _module_item: ($) =>
      choice(
        $.inner_doc_comment,
        $.inner_attribute,
        $.use_declaration,
        $.type_definition,
        $.enum_definition,
        $.bitflags_definition,
        $.type_alias,
        $.const_declaration,
        $.impl_block,
        $.splice_statement,
        $.extern_type,
        $.extern_value,
        $.function_declaration,
      ),

    // --- Inner attributes: `#![...]` (module-level) ---
    inner_attribute: ($) =>
      seq(
        "#!",
        $.attribute_list,
      ),

    // ========================================================================
    // Use declarations (src/parser/external.rs parse_use / parse_use_tree)
    // ========================================================================
    use_declaration: ($) =>
      seq(
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "use",
        $.use_tree,
        ";",
      ),

    use_tree: ($) =>
      prec.left(
        seq(
          $.identifier,
          optional(
            choice(
              // `a::b::c` — recursive
              seq("::", $.use_tree),
              // `a::{b, c}`
              seq(
                "::",
                "{",
                optional(seq($.use_tree_item, repeat(seq(",", $.use_tree_item)), optional(","))),
                "}",
              ),
              // `a::*`
              seq("::", "*"),
              // `a as b`
              seq("as", $.identifier),
            ),
          ),
        ),
      ),

    use_tree_item: ($) => $.use_tree,

    // ========================================================================
    // Type definitions: `type Foo { ... }` (src/parser/items.rs)
    // ========================================================================
    type_definition: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "type",
        field("name", $.identifier),
        optional($.type_parameters),
        // Either a `{ ... }` body or a `;` for an opaque (forward-declared) type.
        choice(field("body", $.type_body), ";"),
      ),

    type_body: ($) => seq("{", repeat($._type_statement), "}"),

    _type_statement: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        choice(
          $.field,
          $.vftable_block,
          // Nested definitions may carry a trailing comma inside a type body,
          // matching the field separator (e.g. `pub type Inner { ... },`).
          // `type_alias` and `const_declaration` already end with their own
          // `;`/`,` terminator.
          seq($.type_definition, optional(",")),
          seq($.enum_definition, optional(",")),
          seq($.bitflags_definition, optional(",")),
          $.type_alias,
          $.const_declaration,
          // A nested extern value (`extern name: T,`) — the value-item analogue
          // of a nested const. `extern type ...` stays module-level only.
          $.extern_value,
        ),
      ),

    field: ($) =>
      seq(
        field("visibility", optional($.visibility)),
        field("name", $.identifier),
        ":",
        field("type", $._type),
        optional(","),
      ),

    vftable_block: ($) =>
      seq(
        "vftable",
        "{",
        repeat($.function_signature),
        optional(","),
        "}",
        optional(","),
      ),

    // ========================================================================
    // Enum definitions (src/parser/items.rs EnumDefinition)
    // ========================================================================
    enum_definition: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "enum",
        field("name", $.identifier),
        ":",
        field("base_type", $._type),
        "{",
        repeat(choice($.enum_variant, $.const_declaration, $.extern_value)),
        "}",
      ),

    enum_variant: ($) =>
      seq(
        repeat($.attribute),
        field("name", $.identifier),
        optional(seq("=", $.expression)),
        optional(","),
      ),

    // ========================================================================
    // Bitflags definitions (src/parser/items.rs BitflagsDefinition)
    // ========================================================================
    bitflags_definition: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "bitflags",
        field("name", $.identifier),
        ":",
        field("base_type", $._type),
        "{",
        repeat(choice($.bitflag, $.const_declaration, $.extern_value)),
        "}",
      ),

    bitflag: ($) =>
      seq(
        repeat($.attribute),
        field("name", $.identifier),
        "=",
        field("value", $.expression),
        optional(","),
      ),

    // ========================================================================
    // Type aliases: `type Foo = Bar;` (src/parser/items.rs TypeAliasDefinition)
    // ========================================================================
    type_alias: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "type",
        field("name", $.identifier),
        optional($.type_parameters),
        "=",
        field("value", $._type),
        ";",
      ),

    // ========================================================================
    // Constants: `const NAME: TYPE = EXPR;` (src/parser/items.rs ConstDefinition)
    // ========================================================================
    const_declaration: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "const",
        field("name", $.identifier),
        ":",
        field("type", $._type),
        "=",
        field("value", $.expression),
        choice(";", ","),
      ),

    // ========================================================================
    // Impl blocks (src/parser/functions.rs FunctionBlock)
    // ========================================================================
    impl_block: ($) =>
      seq(
        repeat($.attribute),
        "impl",
        optional($.type_parameters),
        field("target", $._type),
        "{",
        repeat($.function_signature),
        "}",
      ),

    // ========================================================================
    // Splice statements (src/parser/external.rs parse_splice)
    //
    //   [#[cfg(...)]] <slot> [definition] [for <Type>] <string> ;
    //
    // A standalone `prologue`/`epilogue` splice, optionally cfg-gated. The
    // `definition` modifier targets the cpp source file; `for <Type>`
    // attributes the splice to a type's page.
    // ========================================================================
    splice_statement: ($) =>
      seq(
        repeat($.attribute),
        field("slot", $.splice_slot),
        optional("definition"),
        optional(seq("for", field("for_type", $.type_identifier))),
        field("body", choice($.string_literal, $.raw_string_literal)),
        ";",
      ),

    splice_slot: ($) => choice("prologue", "epilogue"),

    // ========================================================================
    // Extern types & values (src/parser/external.rs)
    //
    //   extern type Name;                  // opaque extern type
    //   extern type Name<...>;             // generic extern type (name is the full string)
    //   extern value_name: Type;           // extern value binding
    // ========================================================================
    extern_type: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "extern",
        "type",
        field("name", $.identifier),
        optional($.type_parameters),
        ";",
      ),

    extern_value: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "extern",
        field("name", $.identifier),
        ":",
        field("type", $._type),
        // Module-level extern values end with `;`; nested ones (inside a
        // type/enum/bitflags body) may end with `,`, matching const/field.
        choice(";", ","),
      ),

    // ========================================================================
    // Function declarations (src/parser/functions.rs)
    //
    //   pub fn name(arg: Type, &self, &mut self) -> RetType;
    // ========================================================================
    function_declaration: ($) => $.function_signature,

    function_signature: ($) =>
      seq(
        repeat($.doc_comment),
        repeat($.attribute),
        field("visibility", optional($.visibility)),
        "fn",
        field("name", $.identifier),
        "(",
        optional(seq($._argument, repeat(seq(",", $._argument)), optional(","))),
        ")",
        optional(seq("->", field("return_type", $._type))),
        ";",
      ),

    _argument: ($) =>
      choice(
        $.const_self_argument,
        $.mut_self_argument,
        $.named_argument,
      ),

    const_self_argument: ($) => seq("&", "self"),
    mut_self_argument: ($) => seq("&", "mut", "self"),
    named_argument: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

    // ========================================================================
    // Attributes (src/parser/attributes.rs)
    //
    //   #[ident]
    //   #[ident(expr, expr, ...)]
    //   #[ident = expr]
    //   #[cfg(...)]
    //   #![...]  (inner)
    //   #[a, b, c]  (multiple comma-separated)
    // ========================================================================
    attribute: ($) =>
      seq(
        "#",
        optional("!"),
        $.attribute_list,
      ),

    attribute_list: ($) =>
      seq("[", $.attribute_item, repeat(seq(",", $.attribute_item)), "]"),

    attribute_item: ($) =>
      choice(
        $.attribute_function,
        $.attribute_assign,
        $.attribute_ident,
        $.attribute_comment,
      ),

    attribute_ident: ($) => field("name", $.identifier),

    attribute_function: ($) =>
      seq(
        field("name", $.identifier),
        "(",
        optional(seq($._attribute_arg, repeat(seq(",", $._attribute_arg)))),
        ")",
      ),

    attribute_assign: ($) =>
      seq(
        field("name", $.identifier),
        "=",
        field("value", $._attribute_arg),
      ),

    _attribute_arg: ($) =>
      choice(
        // Nested function call, e.g. `any(...)`, `not(...)` inside cfg(...)
        $.attribute_function,
        // `name = expr` form, e.g. `backend = "cpp"` inside cfg(...)
        $.attribute_assign,
        $.expression,
        $.attribute_comment,
      ),

    attribute_comment: ($) =>
      token(seq("/*", repeat(choice(/[^*]/, /\*[^/]/)), "*/")),

    // ========================================================================
    // Types (src/parser/types.rs parse_type)
    //
    //   path                  — `Foo`, `a::b::Foo`
    //   generic_type          — `Foo<Bar, Baz>`
    //   pointer_type          — `*const T`, `*mut T`
    //   array_type            — `[T; 4]`
    //   unknown_type          — `unknown<N>` (size hint)
    // ========================================================================
    _type: ($) =>
      choice(
        $.pointer_type,
        $.array_type,
        $.generic_type,
        $.unknown_type,
        $.type_identifier,
      ),

    type_identifier: ($) => $.path,

    generic_type: ($) =>
      prec(1,
        seq(
          field("name", $.path),
          "<",
          optional(seq($._type, repeat(seq(",", $._type)))),
          ">",
        ),
      ),

    pointer_type: ($) =>
      prec(1,
        seq(
          "*",
          choice("const", "mut"),
          $._type,
        ),
      ),

    array_type: ($) =>
      seq(
        "[",
        $._type,
        ";",
        $.integer_literal,
        "]",
      ),

    unknown_type: ($) =>
      seq(
        "unknown",
        "<",
        $.integer_literal,
        ">",
      ),

    // ========================================================================
    // Paths (src/parser/paths.rs ItemPath)
    //
    //   identifier
    //   identifier::identifier::...
    // ========================================================================
    path: ($) =>
      prec.left(
        seq(
          $.identifier,
          repeat(seq("::", $.identifier)),
        ),
      ),

    // ========================================================================
    // Type parameters (generics on definitions): `<T>`, `<K, V>`
    // ========================================================================
    type_parameters: ($) =>
      seq(
        "<",
        optional(seq($.type_parameter, repeat(seq(",", $.type_parameter)))),
        ">",
      ),

    type_parameter: ($) => field("name", $.identifier),

    // ========================================================================
    // Expressions (src/parser/expressions.rs parse_expr)
    //
    //   integer literal: 42, 0xFF, 0b1010, 0o777
    //   string literal:   "..." or r#"..."#
    //   identifier:       Foo
    // ========================================================================
    expression: ($) =>
      choice(
        $.integer_literal,
        $.float_literal,
        $.string_literal,
        $.raw_string_literal,
        $.c_string_literal,
        $.raw_c_string_literal,
        $.identifier,
        $.path_expression,
      ),

    // Path expression for enum-value references: `Color::Red`
    path_expression: ($) =>
      seq(
        $.identifier,
        repeat1(seq("::", $.identifier)),
      ),

    // ========================================================================
    // Visibility
    // ========================================================================
    visibility: ($) => "pub",

    // ========================================================================
    // Literals & identifiers
    // ========================================================================
    integer_literal: ($) =>
      token(
        choice(
          /0x[0-9a-fA-F_]+/,
          /0b[01_]+/,
          /0o[0-7_]+/,
          /[0-9][0-9_]*/,
        ),
      ),

    float_literal: ($) =>
      token(
        /[0-9][0-9_]*\.[0-9][0-9_]*/,
      ),

    string_literal: ($) =>
      token(
        seq(
          '"',
          repeat(
            choice(
              /[^"\\]/,
              /\\(.|\n)/,
            ),
          ),
          '"',
        ),
      ),

    // Split into delimiters + an inner `raw_string_content` node so editors can
    // inject the backend language into just the code (not the `r#"`/`"#`
    // delimiters). The matching mirrors the old single-token form: content is
    // any char except `"`, or a `"` not followed by `#` (the close delimiter).
    raw_string_literal: ($) =>
      seq('r#"', optional($.raw_string_content), token.immediate('"#')),

    raw_string_content: (_) =>
      token.immediate(repeat1(choice(/[^"]/, /"[^#]/))),

    // C-string literal: `c"..."` (with escape processing)
    c_string_literal: ($) =>
      token(
        seq(
          'c',
          '"',
          repeat(
            choice(
              /[^"\\]/,
              /\\(.|\n)/,
            ),
          ),
          '"',
        ),
      ),

    // Raw C-string literal: `cr#"..."#` (no escape processing).
    // Reuses `raw_string_content` since the inner content matching is identical.
    raw_c_string_literal: ($) =>
      seq('cr#"', optional($.raw_string_content), token.immediate('"#')),

    // `Self` type and identifiers. We don't make `Self` a separate keyword
    // token; it is captured as an identifier and matched in highlights.
    identifier: ($) => /[A-Za-z_][A-Za-z0-9_]*/,

    // ========================================================================
    // Comments (src/tokenizer/mod.rs)
    // ========================================================================
    line_comment: ($) =>
      token(
        // Match `//` but not `///` or `//!` (those are doc_comment).
        // Use a negative-lookahead-style approach: `//` followed by
        // a char that is not `/` or `!`, or end-of-comment.
        seq("//", optional(/[^/!\n][^\n]*/)),
      ),

    // Doc comments are lexed as distinct token kinds in the compiler
    // (DocOuter `///`, DocInner `//!`); the grammar mirrors that split.
    // `doc_comment` (`///`) documents the following item and is attached via
    // the `repeat($.doc_comment)` in each item rule. `inner_doc_comment`
    // (`//!`) documents the enclosing module and stands alone as a
    // `_module_item` (see `src/parser/module.rs`, which collects a leading
    // run of `//!` into the module's doc comments).
    doc_comment: ($) =>
      token(
        prec(1,
          seq("///", /[^\n]*/),
        ),
      ),

    inner_doc_comment: ($) =>
      token(
        prec(1,
          seq("//!", /[^\n]*/),
        ),
      ),

    block_comment: ($) =>
      token(
        seq(
          "/*",
          repeat(choice(/[^*]/, /\*[^/]/)),
          "*/",
        ),
      ),
  },
});
