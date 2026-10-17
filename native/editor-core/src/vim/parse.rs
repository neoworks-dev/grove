//! Reading a normal or visual mode command out of the keys typed so far. The whole sequence is
//! read again after every key, so there is no half-parsed state to get wrong: a sequence is
//! either not finished, not a command, or one command with everything it was given.

use crate::movement::Motion;
use crate::vim::types::{Operator, ScrollAlign, SelectionKind, TextObject};

/// The result of reading the keys typed so far.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parse {
    /// The keys begin a command that needs more of them.
    Incomplete,
    /// The keys are not a command, and are dropped.
    Invalid,
    Complete(Parsed),
}

/// One command, with its register and count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub register: Option<char>,
    /// What the counts typed before and after an operator multiply to, if any were typed.
    pub count: Option<usize>,
    /// The command's keys without its register and counts, which is what `.` repeats.
    pub keys: Vec<String>,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Move(MotionSpec),
    Operate { operator: Operator, target: TargetSpec },
    Simple(Simple),
}

/// What an operator is given to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetSpec {
    Motion(MotionSpec),
    Object {
        object: TextObject,
        around: bool,
    },
    /// The operator doubled, as in `dd`.
    Lines,
}

/// A motion as typed, before the count and the view turn it into one the editor knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionSpec {
    Fixed(Motion),
    /// `f`, `t`, `F` and `T`.
    Find {
        character: char,
        forward: bool,
        till: bool,
    },
    /// `;` and `,`.
    FindRepeat {
        reverse: bool,
    },
    /// `G`: the last line, or the one the count names.
    GotoLine,
    /// `gg`: the first line, or the one the count names.
    GotoFirstLine,
    /// `H`, `M` and `L`.
    Screen(ScreenRow),
    /// `'` and the backtick.
    Mark {
        name: char,
        linewise: bool,
    },
    /// `n` and `N`.
    SearchRepeat {
        reverse: bool,
    },
    /// `*` and `#`.
    SearchWord {
        forward: bool,
    },
    /// `/` and `?`, which ask for the pattern.
    SearchPrompt {
        forward: bool,
    },
    /// `s`: jump labels, which take the cursor to a match picked from the screen.
    Jump,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenRow {
    Top,
    Middle,
    Bottom,
}

/// Where `i`, `a` and the other keys that start insert mode put the cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertAt {
    /// `i`.
    Cursor,
    /// `a`.
    AfterCursor,
    /// `I`.
    FirstNonBlank,
    /// `gI`.
    LineStart,
    /// `A`.
    LineEnd,
    /// `o`.
    LineBelow,
    /// `O`.
    LineAbove,
}

/// How far Ctrl-D, Ctrl-U, Ctrl-F and Ctrl-B scroll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageStep {
    HalfDown,
    HalfUp,
    PageDown,
    PageUp,
}

/// Commands that are not an operator or a motion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Simple {
    /// `x`, `X`, `D`, `C`, `S` and `Y`, which are operators in short form.
    ShortOperator {
        operator: Operator,
        motion: Option<Motion>,
        lines: bool,
    },
    /// `J`.
    Join,
    /// `p`, `P`, `gp` and `gP`.
    Put {
        before: bool,
        cursor_after: bool,
    },
    Undo,
    Redo,
    /// `.`.
    Repeat,
    Insert(InsertAt),
    /// `R`.
    ReplaceMode,
    /// `r` and the character.
    ReplaceChar(char),
    /// `~`.
    ToggleCaseChar,
    /// `v` and `V`.
    Visual(SelectionKind),
    /// `:`.
    ExCommandLine,
    /// `m` and a name.
    SetMark(char),
    /// `zt`, `zz` and `zb`.
    Scroll(ScrollAlign),
    /// `ZZ`.
    SaveAndClose,
    /// `ZQ`.
    CloseWithoutSaving,
    /// `]c` and `[c`.
    GotoChange {
        forward: bool,
    },
    Page(PageStep),
    /// Ctrl-N.
    NextMatch,
    Escape,
    /// Visual mode: an operator keyed on its own.
    VisualOperator(Operator),
    /// Visual mode: `X`, `D` and `Y`, which take whole lines.
    VisualLinesOperator(Operator),
    /// Visual mode: `i` or `a` and an object key.
    VisualObject {
        object: TextObject,
        around: bool,
    },
    /// Visual mode: `o` and `O`.
    VisualSwapEnds,
    /// `gv`.
    ReselectVisual,
    /// `q` and a register name, which starts recording a macro.
    MacroRecord(char),
    /// `@` and a register name, or `@@`, which types a macro again.
    MacroPlay(char),
    /// Ctrl-O.
    JumpOlder,
    /// Ctrl-I, which is also Tab.
    JumpNewer,
}

/// Whether a key is a digit, which starts or goes on with a count.
fn is_digit(key: &str) -> bool {
    key.len() == 1 && key.as_bytes()[0].is_ascii_digit()
}

/// The character a key types, if it types one.
pub fn typed_character(key: &str) -> Option<char> {
    if key == "space" {
        return Some(' ');
    }
    let mut characters = key.chars();
    let first = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    Some(first)
}

/// Whether a character names a register.
fn is_register_name(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '"' | '+' | '*' | '_' | '-')
}

/// The text object a key names.
fn object_for(character: char) -> Option<TextObject> {
    let pair = |open, close| Some(TextObject::Pair { open, close });
    match character {
        'w' => Some(TextObject::Word { big: false }),
        'W' => Some(TextObject::Word { big: true }),
        'p' => Some(TextObject::Paragraph),
        't' => Some(TextObject::Tag),
        's' => Some(TextObject::Sentence),
        '"' | '\'' | '`' => Some(TextObject::Quote { quote: character }),
        '(' | ')' | 'b' => pair('(', ')'),
        '{' | '}' | 'B' => pair('{', '}'),
        '[' | ']' => pair('[', ']'),
        '<' | '>' => pair('<', '>'),
        _ => None,
    }
}

/// The operator a key, or `g` and a key, names, and how many keys that took.
fn operator_for(keys: &[String]) -> Option<(Operator, usize)> {
    match keys[0].as_str() {
        "d" => Some((Operator::Delete, 1)),
        "c" => Some((Operator::Change, 1)),
        "y" => Some((Operator::Yank, 1)),
        ">" => Some((Operator::Indent, 1)),
        "<" => Some((Operator::Outdent, 1)),
        "g" => match keys.get(1)?.as_str() {
            "u" => Some((Operator::Lowercase, 2)),
            "U" => Some((Operator::Uppercase, 2)),
            "~" => Some((Operator::ToggleCase, 2)),
            _ => None,
        },
        _ => None,
    }
}

/// Whether `keys` only says it is `g` so far, which could still become an operator.
fn is_lone_g(keys: &[String]) -> bool {
    keys.len() == 1 && keys[0] == "g"
}

/// The result of reading a motion.
enum MotionParse {
    Incomplete,
    NotMotion,
    Motion(MotionSpec, usize),
}

/// Reads a motion from the start of `keys`.
fn parse_motion(keys: &[String]) -> MotionParse {
    let fixed = |motion| MotionParse::Motion(MotionSpec::Fixed(motion), 1);
    let first = keys[0].as_str();
    match first {
        "h" | "left" => fixed(Motion::ColumnLeft),
        "l" | "right" => fixed(Motion::ColumnRight),
        "j" | "down" | "enter" | "+" => fixed(Motion::Vertical(1)),
        "k" | "up" | "-" => fixed(Motion::Vertical(-1)),
        "backspace" => fixed(Motion::Left),
        "space" => fixed(Motion::Right),
        "0" | "home" => fixed(Motion::LineStart),
        "^" => fixed(Motion::FirstNonBlank),
        "$" | "end" => fixed(Motion::LineEnd),
        "w" => fixed(Motion::WordForward { big: false }),
        "W" => fixed(Motion::WordForward { big: true }),
        "b" => fixed(Motion::WordBack { big: false }),
        "B" => fixed(Motion::WordBack { big: true }),
        "e" => fixed(Motion::WordEnd { big: false }),
        "E" => fixed(Motion::WordEnd { big: true }),
        "{" => fixed(Motion::ParagraphBack),
        "}" => fixed(Motion::ParagraphForward),
        "%" => fixed(Motion::MatchingBracket),
        "G" => MotionParse::Motion(MotionSpec::GotoLine, 1),
        "H" => MotionParse::Motion(MotionSpec::Screen(ScreenRow::Top), 1),
        "M" => MotionParse::Motion(MotionSpec::Screen(ScreenRow::Middle), 1),
        "L" => MotionParse::Motion(MotionSpec::Screen(ScreenRow::Bottom), 1),
        ";" => MotionParse::Motion(MotionSpec::FindRepeat { reverse: false }, 1),
        "," => MotionParse::Motion(MotionSpec::FindRepeat { reverse: true }, 1),
        "n" => MotionParse::Motion(MotionSpec::SearchRepeat { reverse: false }, 1),
        "N" => MotionParse::Motion(MotionSpec::SearchRepeat { reverse: true }, 1),
        "*" => MotionParse::Motion(MotionSpec::SearchWord { forward: true }, 1),
        "#" => MotionParse::Motion(MotionSpec::SearchWord { forward: false }, 1),
        "/" => MotionParse::Motion(MotionSpec::SearchPrompt { forward: true }, 1),
        "?" => MotionParse::Motion(MotionSpec::SearchPrompt { forward: false }, 1),
        "s" => MotionParse::Motion(MotionSpec::Jump, 1),
        "f" | "t" | "F" | "T" => parse_find(keys),
        "'" | "`" => parse_mark_motion(keys),
        "g" => parse_g_motion(keys),
        _ => MotionParse::NotMotion,
    }
}

/// `f`, `t`, `F` or `T` and the character it looks for.
fn parse_find(keys: &[String]) -> MotionParse {
    let Some(next) = keys.get(1) else {
        return MotionParse::Incomplete;
    };
    let Some(character) = typed_character(next) else {
        return MotionParse::NotMotion;
    };
    let find = match keys[0].as_str() {
        "f" => MotionSpec::Find { character, forward: true, till: false },
        "t" => MotionSpec::Find { character, forward: true, till: true },
        "F" => MotionSpec::Find { character, forward: false, till: false },
        _ => MotionSpec::Find { character, forward: false, till: true },
    };
    MotionParse::Motion(find, 2)
}

/// `'` or the backtick and the name of the mark.
fn parse_mark_motion(keys: &[String]) -> MotionParse {
    let Some(next) = keys.get(1) else {
        return MotionParse::Incomplete;
    };
    let Some(name) = typed_character(next) else {
        return MotionParse::NotMotion;
    };
    MotionParse::Motion(MotionSpec::Mark { name, linewise: keys[0] == "'" }, 2)
}

/// The motions that start with `g`.
fn parse_g_motion(keys: &[String]) -> MotionParse {
    let Some(next) = keys.get(1) else {
        return MotionParse::Incomplete;
    };
    match next.as_str() {
        "g" => MotionParse::Motion(MotionSpec::GotoFirstLine, 2),
        "e" => MotionParse::Motion(MotionSpec::Fixed(Motion::WordEndBack { big: false }), 2),
        "E" => MotionParse::Motion(MotionSpec::Fixed(Motion::WordEndBack { big: true }), 2),
        "_" => MotionParse::Motion(MotionSpec::Fixed(Motion::LastNonBlank), 2),
        "j" => MotionParse::Motion(MotionSpec::Fixed(Motion::Vertical(1)), 2),
        "k" => MotionParse::Motion(MotionSpec::Fixed(Motion::Vertical(-1)), 2),
        _ => MotionParse::NotMotion,
    }
}

/// What reading the digits of a count found.
struct CountRead {
    count: Option<usize>,
    next: usize,
}

/// Reads a count from `keys` at `start`. A zero first is the motion, not a count.
fn read_count(keys: &[String], start: usize) -> CountRead {
    let mut count: Option<usize> = None;
    let mut next = start;
    while next < keys.len() && is_digit(&keys[next]) {
        if count.is_none() && keys[next] == "0" {
            break;
        }
        let digit = keys[next].parse::<usize>().unwrap_or(0);
        count = Some(count.unwrap_or(0).saturating_mul(10).saturating_add(digit).min(1_000_000));
        next += 1;
    }
    CountRead { count, next }
}

/// Multiplies the counts typed before and after an operator, which stay unset when neither was typed.
fn multiply(first: Option<usize>, second: Option<usize>) -> Option<usize> {
    match (first, second) {
        (None, None) => None,
        (first, second) => Some(first.unwrap_or(1).saturating_mul(second.unwrap_or(1))),
    }
}

/// Reads the keys typed so far in normal mode, or in visual mode when `visual` is set.
pub fn parse(keys: &[String], visual: bool) -> Parse {
    if keys.is_empty() {
        return Parse::Incomplete;
    }
    let mut start = 0;
    let mut register = None;
    if keys[0] == "\"" {
        let Some(name) = keys.get(1) else {
            return Parse::Incomplete;
        };
        match typed_character(name).filter(|character| is_register_name(*character)) {
            Some(character) => register = Some(character),
            None => return Parse::Invalid,
        }
        start = 2;
    }
    let first_count = read_count(keys, start);
    if first_count.next >= keys.len() {
        return Parse::Incomplete;
    }
    let rest = &keys[first_count.next..];
    let finish = |count, used: usize, action| {
        let consumed_keys = rest[..used].to_vec();
        Parse::Complete(Parsed { register, count, keys: consumed_keys, action })
    };
    if visual {
        return parse_visual(rest, first_count.count, finish);
    }
    if let Some((operator, operator_keys)) = operator_for(rest) {
        return parse_operator(rest, operator, operator_keys, first_count.count, register);
    }
    if is_lone_g(rest) {
        return Parse::Incomplete;
    }
    match parse_motion(rest) {
        MotionParse::Incomplete => return Parse::Incomplete,
        MotionParse::Motion(spec, used) => return finish(first_count.count, used, Action::Move(spec)),
        MotionParse::NotMotion => {}
    }
    match parse_simple(rest) {
        SimpleParse::Incomplete => Parse::Incomplete,
        SimpleParse::Invalid => Parse::Invalid,
        SimpleParse::Simple(simple, used) => finish(first_count.count, used, Action::Simple(simple)),
    }
}

/// Reads an operator and what it acts on.
fn parse_operator(
    rest: &[String],
    operator: Operator,
    operator_keys: usize,
    first_count: Option<usize>,
    register: Option<char>,
) -> Parse {
    let after_operator = &rest[operator_keys..];
    let second_count = read_count(after_operator, 0);
    let target_keys = &after_operator[second_count.next..];
    let count = multiply(first_count, second_count.count);
    if target_keys.is_empty() {
        return Parse::Incomplete;
    }
    let complete = |used: usize, target: TargetSpec| {
        let command_keys = [&rest[..operator_keys], &target_keys[..used]].concat();
        Parse::Complete(Parsed { register, count, keys: command_keys, action: Action::Operate { operator, target } })
    };
    let doubled = rest[operator_keys - 1].as_str();
    if target_keys[0] == doubled {
        return complete(1, TargetSpec::Lines);
    }
    if operator_keys == 2 && target_keys[0] == "g" {
        let Some(second) = target_keys.get(1) else {
            return Parse::Incomplete;
        };
        if second == doubled {
            return complete(2, TargetSpec::Lines);
        }
    }
    if target_keys[0] == "i" || target_keys[0] == "a" {
        let Some(object_key) = target_keys.get(1) else {
            return Parse::Incomplete;
        };
        let object = typed_character(object_key).and_then(object_for);
        return match object {
            Some(object) => complete(2, TargetSpec::Object { object, around: target_keys[0] == "a" }),
            None => Parse::Invalid,
        };
    }
    match parse_motion(target_keys) {
        MotionParse::Incomplete => Parse::Incomplete,
        MotionParse::NotMotion => Parse::Invalid,
        MotionParse::Motion(MotionSpec::Mark { .. }, _) => Parse::Invalid,
        MotionParse::Motion(spec, used) => complete(used, TargetSpec::Motion(spec)),
    }
}

/// What reading a command that is not a motion or an operator found.
enum SimpleParse {
    Incomplete,
    Invalid,
    Simple(Simple, usize),
}

/// Reads the commands that are not motions or operators.
fn parse_simple(keys: &[String]) -> SimpleParse {
    let simple = |simple| SimpleParse::Simple(simple, 1);
    let short = |operator, motion, lines| simple(Simple::ShortOperator { operator, motion, lines });
    match keys[0].as_str() {
        "x" | "delete" => short(Operator::Delete, Some(Motion::ColumnRight), false),
        "X" => short(Operator::Delete, Some(Motion::ColumnLeft), false),
        "D" => short(Operator::Delete, Some(Motion::LineEnd), false),
        "C" => short(Operator::Change, Some(Motion::LineEnd), false),
        "S" => short(Operator::Change, None, true),
        "Y" => short(Operator::Yank, None, true),
        "J" => simple(Simple::Join),
        "p" => simple(Simple::Put { before: false, cursor_after: false }),
        "P" => simple(Simple::Put { before: true, cursor_after: false }),
        "u" => simple(Simple::Undo),
        "C-r" => simple(Simple::Redo),
        "." => simple(Simple::Repeat),
        "i" => simple(Simple::Insert(InsertAt::Cursor)),
        "a" => simple(Simple::Insert(InsertAt::AfterCursor)),
        "I" => simple(Simple::Insert(InsertAt::FirstNonBlank)),
        "A" => simple(Simple::Insert(InsertAt::LineEnd)),
        "o" => simple(Simple::Insert(InsertAt::LineBelow)),
        "O" => simple(Simple::Insert(InsertAt::LineAbove)),
        "R" => simple(Simple::ReplaceMode),
        "~" => simple(Simple::ToggleCaseChar),
        "v" => simple(Simple::Visual(SelectionKind::Characters)),
        "V" => simple(Simple::Visual(SelectionKind::Lines)),
        "C-v" => simple(Simple::Visual(SelectionKind::Block)),
        ":" => simple(Simple::ExCommandLine),
        "C-n" => simple(Simple::NextMatch),
        "C-d" => simple(Simple::Page(PageStep::HalfDown)),
        "C-u" => simple(Simple::Page(PageStep::HalfUp)),
        "C-f" | "pagedown" => simple(Simple::Page(PageStep::PageDown)),
        "C-b" | "pageup" => simple(Simple::Page(PageStep::PageUp)),
        "escape" | "C-[" | "C-c" => simple(Simple::Escape),
        "C-o" => simple(Simple::JumpOlder),
        "C-i" | "tab" => simple(Simple::JumpNewer),
        "q" => parse_macro(keys, true),
        "@" => parse_macro(keys, false),
        "r" => parse_replace_char(keys),
        "m" => parse_set_mark(keys),
        "z" => parse_scroll(keys),
        "Z" => parse_save_and_close(keys),
        "]" | "[" => parse_goto_change(keys),
        "g" => parse_g_simple(keys),
        _ => SimpleParse::Invalid,
    }
}

/// `q` or `@` and the register a macro is recorded in or played from. Playing also takes `@` for the last one.
fn parse_macro(keys: &[String], record: bool) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    let name = typed_character(next).filter(|character| {
        character.is_ascii_alphanumeric() || character == &'"' || (!record && character == &'@')
    });
    match (name, record) {
        (Some(name), true) => SimpleParse::Simple(Simple::MacroRecord(name), 2),
        (Some(name), false) => SimpleParse::Simple(Simple::MacroPlay(name), 2),
        (None, _) => SimpleParse::Invalid,
    }
}

/// `r` and the character that replaces.
fn parse_replace_char(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    if next == "enter" {
        return SimpleParse::Simple(Simple::ReplaceChar('\n'), 2);
    }
    match typed_character(next) {
        Some(character) => SimpleParse::Simple(Simple::ReplaceChar(character), 2),
        None => SimpleParse::Invalid,
    }
}

/// `m` and the mark's name.
fn parse_set_mark(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    match typed_character(next) {
        Some(name) => SimpleParse::Simple(Simple::SetMark(name), 2),
        None => SimpleParse::Invalid,
    }
}

/// `zt`, `zz` and `zb`.
fn parse_scroll(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    let align = match next.as_str() {
        "t" => ScrollAlign::Top,
        "z" | "." => ScrollAlign::Center,
        "b" | "-" => ScrollAlign::Bottom,
        _ => return SimpleParse::Invalid,
    };
    SimpleParse::Simple(Simple::Scroll(align), 2)
}

/// `ZZ` and `ZQ`.
fn parse_save_and_close(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    match next.as_str() {
        "Z" => SimpleParse::Simple(Simple::SaveAndClose, 2),
        "Q" => SimpleParse::Simple(Simple::CloseWithoutSaving, 2),
        _ => SimpleParse::Invalid,
    }
}

/// `]c` and `[c`.
fn parse_goto_change(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    if next != "c" {
        return SimpleParse::Invalid;
    }
    SimpleParse::Simple(Simple::GotoChange { forward: keys[0] == "]" }, 2)
}

/// The commands that start with `g` and are not motions or operators.
fn parse_g_simple(keys: &[String]) -> SimpleParse {
    let Some(next) = keys.get(1) else {
        return SimpleParse::Incomplete;
    };
    match next.as_str() {
        "J" => SimpleParse::Simple(Simple::Join, 2),
        "p" => SimpleParse::Simple(Simple::Put { before: false, cursor_after: true }, 2),
        "P" => SimpleParse::Simple(Simple::Put { before: true, cursor_after: true }, 2),
        "I" => SimpleParse::Simple(Simple::Insert(InsertAt::LineStart), 2),
        "v" => SimpleParse::Simple(Simple::ReselectVisual, 2),
        _ => SimpleParse::Invalid,
    }
}

/// Reads a command in visual mode, where an operator is one key and acts on the selection.
fn parse_visual(
    rest: &[String],
    count: Option<usize>,
    finish: impl Fn(Option<usize>, usize, Action) -> Parse,
) -> Parse {
    let visual = |simple| finish(count, 1, Action::Simple(simple));
    let first = rest[0].as_str();
    match first {
        "d" | "x" | "delete" => return visual(Simple::VisualOperator(Operator::Delete)),
        "y" => return visual(Simple::VisualOperator(Operator::Yank)),
        "c" => return visual(Simple::VisualOperator(Operator::Change)),
        ">" => return visual(Simple::VisualOperator(Operator::Indent)),
        "<" => return visual(Simple::VisualOperator(Operator::Outdent)),
        "u" => return visual(Simple::VisualOperator(Operator::Lowercase)),
        "U" => return visual(Simple::VisualOperator(Operator::Uppercase)),
        "~" => return visual(Simple::VisualOperator(Operator::ToggleCase)),
        "X" | "D" => return visual(Simple::VisualLinesOperator(Operator::Delete)),
        "Y" => return visual(Simple::VisualLinesOperator(Operator::Yank)),
        "C" | "S" | "R" => return visual(Simple::VisualLinesOperator(Operator::Change)),
        "o" | "O" => return visual(Simple::VisualSwapEnds),
        "i" | "a" => return parse_visual_object(rest, count, &finish),
        "g" => {
            if let Some((operator, used)) = operator_for(rest) {
                return finish(count, used, Action::Simple(Simple::VisualOperator(operator)));
            }
        }
        _ => {}
    }
    if is_lone_g(rest) {
        return Parse::Incomplete;
    }
    match parse_motion(rest) {
        MotionParse::Incomplete => return Parse::Incomplete,
        MotionParse::Motion(spec, used) => return finish(count, used, Action::Move(spec)),
        MotionParse::NotMotion => {}
    }
    match parse_simple(rest) {
        SimpleParse::Incomplete => Parse::Incomplete,
        SimpleParse::Invalid => Parse::Invalid,
        SimpleParse::Simple(simple, used) => finish(count, used, Action::Simple(simple)),
    }
}

/// `i` or `a` and an object key, in visual mode.
fn parse_visual_object(
    rest: &[String],
    count: Option<usize>,
    finish: &impl Fn(Option<usize>, usize, Action) -> Parse,
) -> Parse {
    let Some(object_key) = rest.get(1) else {
        return Parse::Incomplete;
    };
    let object = typed_character(object_key).and_then(object_for);
    match object {
        Some(object) => finish(count, 2, Action::Simple(Simple::VisualObject { object, around: rest[0] == "a" })),
        None => Parse::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(typed: &str) -> Parse {
        let keys: Vec<String> = typed.chars().map(|character| character.to_string()).collect();
        parse(&keys, false)
    }

    fn complete(typed: &str) -> Parsed {
        match read(typed) {
            Parse::Complete(parsed) => parsed,
            other => panic!("{typed:?} read as {other:?}"),
        }
    }

    #[test]
    fn counts_before_and_after_an_operator_multiply() {
        let parsed = complete("2d3w");
        assert_eq!(parsed.count, Some(6));
        assert_eq!(parsed.keys, vec!["d", "w"]);
        assert!(matches!(parsed.action, Action::Operate { operator: Operator::Delete, .. }));
    }

    #[test]
    fn a_register_comes_first() {
        let parsed = complete("\"ayy");
        assert_eq!(parsed.register, Some('a'));
        assert_eq!(parsed.action, Action::Operate { operator: Operator::Yank, target: TargetSpec::Lines });
    }

    #[test]
    fn zero_is_a_motion_unless_it_follows_a_digit() {
        assert!(matches!(complete("0").action, Action::Move(MotionSpec::Fixed(Motion::LineStart))));
        assert_eq!(complete("10j").count, Some(10));
    }

    #[test]
    fn unfinished_commands_wait_for_more_keys() {
        for typed in ["d", "2", "\"", "f", "di", "gU", "g", "dg", "ya", "z", "\"a"] {
            assert_eq!(read(typed), Parse::Incomplete, "{typed:?}");
        }
    }

    #[test]
    fn text_objects_and_g_operators_read_whole() {
        let parsed = complete("ci\"");
        assert_eq!(
            parsed.action,
            Action::Operate {
                operator: Operator::Change,
                target: TargetSpec::Object { object: TextObject::Quote { quote: '"' }, around: false }
            }
        );
        assert_eq!(
            complete("gUU").action,
            Action::Operate { operator: Operator::Uppercase, target: TargetSpec::Lines }
        );
        assert_eq!(complete("gugu").keys, vec!["g", "u", "g", "u"]);
    }

    #[test]
    fn s_is_a_motion_that_an_operator_can_take() {
        assert_eq!(complete("s").action, Action::Move(MotionSpec::Jump));
        assert_eq!(
            complete("ds").action,
            Action::Operate { operator: Operator::Delete, target: TargetSpec::Motion(MotionSpec::Jump) }
        );
    }

    #[test]
    fn nonsense_is_invalid() {
        assert_eq!(read("dq"), Parse::Invalid);
        assert_eq!(read("\"\u{1}"), Parse::Invalid);
    }
}
