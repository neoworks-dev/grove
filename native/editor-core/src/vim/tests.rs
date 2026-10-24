//! Vim driven the way a person drives it: keys in, text and cursors out. Each case types keys
//! through the layer and applies the commands it makes to an editor state, so these cover the
//! layer and the state carrying out its commands together.

use std::time::Instant;

use crate::buffer::{Buffer, Position};
use crate::command::Command;
use crate::keymap::{InputContext, InputLayer, KeyInput, Modifiers};
use crate::state::EditorState;
use crate::vim::VimLayer;

const CONTEXT: InputContext = InputContext { page_rows: 10, top_row: 0 };

/// Where the cursor starts in a test's text.
const CURSOR: char = '¦';

fn at(row: usize, column: usize) -> Position {
    Position { row, column }
}

/// An editor state and a vim layer, driven by typing.
struct Vim {
    state: EditorState,
    layer: VimLayer,
    errors: Vec<String>,
    requests: Vec<crate::vim::types::AppRequest>,
    copied: Vec<String>,
    /// The first row of the view the keys are typed in, which scroll commands move.
    top_row: usize,
}

impl Vim {
    /// A document from text with `¦` marking the cursor, in normal mode.
    fn new(marked: &str) -> Vim {
        let offset = marked.chars().position(|character| character == CURSOR).expect("a cursor in the text");
        let text: String = marked.chars().filter(|character| *character != CURSOR).collect();
        let mut state = EditorState::new(Buffer::from_text(&text));
        let position = state.buffer().position_of(offset);
        state.apply(&Command::PlaceCursor { at: position });
        Vim { state, layer: VimLayer::new(), errors: Vec::new(), requests: Vec::new(), copied: Vec::new(), top_row: 0 }
    }

    /// Adds a cursor at a position.
    fn with_cursor(mut self, row: usize, column: usize) -> Vim {
        self.state.apply(&Command::ToggleCursor { at: at(row, column) });
        self
    }

    /// Types keys: each character is a key, and `<Esc>`, `<CR>`, `<BS>`, `<Space>`, `<Tab>`,
    /// `<C-x>` and `<A-C-x>` name the others.
    fn keys(&mut self, typed: &str) -> &mut Vim {
        for key in key_list(typed) {
            let context = InputContext { page_rows: CONTEXT.page_rows, top_row: self.top_row };
            let commands = self.layer.translate(&key, &context);
            for command in commands {
                let outcome = self.state.apply_at(&command, Instant::now());
                if let Some(rows) = outcome.scroll_rows {
                    self.top_row = (self.top_row as isize + rows).max(0) as usize;
                }
                if let Some(message) = outcome.error {
                    self.errors.push(message);
                }
                if let Some(request) = outcome.request {
                    self.requests.push(request);
                }
                if let Some(text) = outcome.copied {
                    self.copied.push(text);
                }
            }
        }
        self
    }

    fn text(&self) -> String {
        self.state.buffer().slice(0..self.state.buffer().length())
    }

    fn heads(&self) -> Vec<Position> {
        self.state.selections().all().iter().map(|selection| selection.head).collect()
    }

    fn mode(&self) -> &'static str {
        self.layer.status().mode
    }

    fn register(&self, name: char) -> String {
        match self.state.memory.read(Some(name)) {
            Some(register) => register.joined(),
            None => String::new(),
        }
    }
}

/// The keys a typed string stands for.
fn key_list(typed: &str) -> Vec<KeyInput> {
    let mut keys = Vec::new();
    let characters: Vec<char> = typed.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '<' {
            if let Some(close) = characters[index..].iter().position(|character| *character == '>') {
                let name: String = characters[index + 1..index + close].iter().collect();
                if name.len() > 1 {
                    keys.push(named_key(&name));
                    index += close + 1;
                    continue;
                }
            }
        }
        keys.push(KeyInput { key: characters[index].to_string(), modifiers: Modifiers::default() });
        index += 1;
    }
    keys
}

/// The key `<Esc>`, `<C-r>` and the like stand for.
fn named_key(name: &str) -> KeyInput {
    let mut modifiers = Modifiers::default();
    let mut rest = name;
    loop {
        if let Some(stripped) = rest.strip_prefix("C-") {
            modifiers.control = true;
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix("A-") {
            modifiers.alt = true;
            rest = stripped;
        } else {
            break;
        }
    }
    let key = match rest {
        "Esc" => "escape",
        "CR" => "enter",
        "BS" => "backspace",
        "Space" => "space",
        "Tab" => "tab",
        "lt" => "<",
        "gt" => ">",
        "Del" => "delete",
        "Left" => "left",
        "Right" => "right",
        "Up" => "up",
        "Down" => "down",
        other => other,
    };
    KeyInput { key: key.to_string(), modifiers }
}

/// Types keys at a cursor in some text and checks the text and the cursor that are left.
fn check(marked: &str, typed: &str, expected_text: &str, expected_cursor: (usize, usize)) {
    let mut vim = Vim::new(marked);
    vim.keys(typed);
    assert_eq!(vim.text(), expected_text, "text after {typed:?} in {marked:?}");
    assert_eq!(vim.heads(), vec![at(expected_cursor.0, expected_cursor.1)], "cursor after {typed:?} in {marked:?}");
}

#[test]
fn motions_move_the_cursor() {
    check("¦one two three", "w", "one two three", (0, 4));
    check("¦one two three", "2w", "one two three", (0, 8));
    check("¦one two three", "e", "one two three", (0, 2));
    check("one two th¦ree", "b", "one two three", (0, 8));
    check("one two th¦ree", "2b", "one two three", (0, 4));
    check("¦one two three", "$", "one two three", (0, 12));
    check("one ¦two", "0", "one two", (0, 0));
    check("   ¦one", "^", "   one", (0, 3));
    check("¦a\nb\nc", "G", "a\nb\nc", (2, 0));
    check("a\nb\n¦c", "gg", "a\nb\nc", (0, 0));
    check("¦a\nb\nc\nd", "3G", "a\nb\nc\nd", (2, 0));
    check("¦a\nb\nc\nd", "2j", "a\nb\nc\nd", (2, 0));
    check("a\nb\n¦c\nd", "k", "a\nb\nc\nd", (1, 0));
    check("¦abc", "l", "abc", (0, 1));
    check("ab¦c", "l", "abc", (0, 2));
    check("a¦bc", "h", "abc", (0, 0));
    check("¦a b\n\nc d", "}", "a b\n\nc d", (1, 0));
    check("¦if (a) { b }", "f{", "if (a) { b }", (0, 7));
    check("¦if (a) { b }", "t{", "if (a) { b }", (0, 6));
    check("a a a ¦a", "Fa", "a a a a", (0, 4));
    check("¦a-b-c-d", "f-;", "a-b-c-d", (0, 3));
    check("¦a-b-c-d", "f-;,", "a-b-c-d", (0, 1));
    check("¦(a (b) c)", "%", "(a (b) c)", (0, 8));
}

#[test]
fn the_cursor_stays_on_a_character_in_normal_mode() {
    check("ab¦c", "l", "abc", (0, 2));
    check("ab¦c", "$", "abc", (0, 2));
    check("¦abc", "A<Esc>", "abc", (0, 2));
    check("¦abc", "ix<Esc>", "xabc", (0, 0));
}

#[test]
fn x_and_dw_and_dd_delete() {
    check("a¦bc", "x", "ac", (0, 1));
    check("ab¦c", "x", "ab", (0, 1));
    check("¦abcd", "3x", "d", (0, 0));
    check("ab¦c", "X", "ac", (0, 1));
    check("¦one two three", "dw", "two three", (0, 0));
    check("¦one two three", "d2w", "three", (0, 0));
    check("¦one two three", "2dw", "three", (0, 0));
    check("one ¦two three", "db", "two three", (0, 0));
    check("¦one two", "de", " two", (0, 0));
    check("¦one two", "d$", "", (0, 0));
    check("one ¦two", "D", "one ", (0, 3));
    check("a\n¦b\nc", "dd", "a\nc", (1, 0));
    check("a\nb\n¦c", "dd", "a\nb", (1, 0));
    check("¦a\nb\nc", "2dd", "c", (0, 0));
    check("¦only", "dd", "", (0, 0));
    check("a\n  ¦b\nc", "dj", "a", (0, 0));
    check("¦a\nb\nc", "dG", "", (0, 0));
    check("a\nb\n¦c", "dgg", "", (0, 0));
}

#[test]
fn dw_on_the_last_word_of_a_line_keeps_the_line_break() {
    check("foo ¦bar\nbaz", "dw", "foo \nbaz", (0, 3));
    check("¦foo\nbar", "dw", "\nbar", (0, 0));
}

#[test]
fn change_enters_insert_and_cw_keeps_the_space() {
    let mut vim = Vim::new("¦one two");
    vim.keys("cw");
    assert_eq!(vim.mode(), "INSERT");
    vim.keys("1<Esc>");
    assert_eq!(vim.text(), "1 two");
    assert_eq!(vim.mode(), "NORMAL");
    check("¦one two", "cwx<Esc>", "x two", (0, 0));
    check("¦one two three", "c2wx<Esc>", "x three", (0, 0));
    check("one ¦two", "C!<Esc>", "one !", (0, 4));
    check("¦abc", "clx<Esc>", "xbc", (0, 0));
    check("a\n  ¦b\nc", "ccx<Esc>", "a\n  x\nc", (1, 2));
    check("¦a\nb", "Sx<Esc>", "x\nb", (0, 0));
}

#[test]
fn yank_and_put_use_registers() {
    check("¦one two", "yw$p", "one twoone ", (0, 10));
    check("¦one two", "ywP", "one one two", (0, 3));
    check("¦a\nb", "yyp", "a\na\nb", (1, 0));
    check("¦a\nb", "yyP", "a\na\nb", (0, 0));
    check("a\n¦b", "yyp", "a\nb\nb", (2, 0));
    check("¦a\nb", "2yyGp", "a\nb\na\nb", (2, 0));
    check("¦ab", "xp", "ba", (0, 1));
    check("¦one two", "ywwP", "one one two", (0, 7));
    check("¦a", "yy3p", "a\na\na\na", (1, 0));
    check("¦ab", "ylp", "aab", (0, 1));
    check("¦ab", "y$$p", "abab", (0, 3));
}

#[test]
fn named_registers_and_the_clipboard_registers() {
    let mut vim = Vim::new("¦one two");
    vim.keys("\"ayw");
    vim.keys("w\"byw");
    assert_eq!(vim.register('a'), "one ");
    assert_eq!(vim.register('b'), "two");
    vim.keys("$\"ap");
    assert_eq!(vim.text(), "one twoone ");
    vim.keys("0\"Ayw");
    assert_eq!(vim.register('a'), "one one ");
    vim.keys("\"+yy");
    assert_eq!(vim.copied.last().map(String::as_str), Some("one twoone \n"));
}

#[test]
fn the_black_hole_register_keeps_nothing() {
    let mut vim = Vim::new("¦one two");
    vim.keys("yw");
    vim.keys("\"_dw");
    assert_eq!(vim.text(), "two");
    vim.keys("P");
    assert_eq!(vim.text(), "one two");
}

#[test]
fn text_objects() {
    check("one ¦two three", "diw", "one  three", (0, 4));
    check("one ¦two three", "daw", "one three", (0, 4));
    check("one two ¦three", "daw", "one two", (0, 6));
    check("say \"h¦i there\" now", "di\"", "say \"\" now", (0, 5));
    check("say \"h¦i there\" now", "da\"", "say now", (0, 4));
    check("say ¦\"hi\" now", "ci\"x<Esc>", "say \"x\" now", (0, 5));
    check("f(a, ¦b)", "di(", "f()", (0, 2));
    check("f(a, ¦b)", "da(", "f", (0, 0));
    check("f(a, (b¦), c)", "di(", "f(a, (), c)", (0, 6));
    check("{\n  a¦\n  b\n}", "di{", "{\n}", (1, 0));
    check("{\n  a¦\n  b\n}", "ci{x<Esc>", "{\n  x\n}", (1, 2));
    check("a\nb¦\n\nc", "dip", "\nc", (0, 0));
    check("a\nb¦\n\nc", "dap", "c", (0, 0));
}

#[test]
fn indent_and_case_operators() {
    check("¦a\nb", ">>", "    a\nb", (0, 4));
    check("¦a\nb", "2>>", "    a\n    b", (0, 4));
    check("    ¦a", "<<", "a", (0, 0));
    check("¦a\nb", ">j", "    a\n    b", (0, 4));
    check("¦hello world", "gUw", "HELLO world", (0, 0));
    check("hello ¦WORLD", "guw", "hello world", (0, 6));
    check("¦Hello", "g~~", "hELLO", (0, 0));
    check("¦hello", "~~", "HEllo", (0, 2));
    check("¦hello", "gUU", "HELLO", (0, 0));
}

#[test]
fn join_and_replace() {
    check("¦a\n  b\nc", "J", "a b\nc", (0, 1));
    check("¦a\nb\nc", "3J", "a b c", (0, 3));
    check("¦abc", "rx", "xbc", (0, 0));
    check("¦abc", "2rx", "xxc", (0, 1));
    check("¦abc", "r<CR>", "\nbc", (1, 0));
    check("¦abc", "Rxy<Esc>", "xyc", (0, 1));
    check("a¦bc", "Rxyz<Esc>", "axyz", (0, 3));
}

#[test]
fn insert_keys() {
    check("¦abc", "ix<Esc>", "xabc", (0, 0));
    check("¦abc", "ax<Esc>", "axbc", (0, 1));
    check("a¦bc", "Ix<Esc>", "xabc", (0, 0));
    check("¦abc", "Ax<Esc>", "abcx", (0, 3));
    check("  ¦abc", "Ix<Esc>", "  xabc", (0, 2));
    check("a¦b", "ox<Esc>", "ab\nx", (1, 0));
    check("a¦b", "Ox<Esc>", "x\nab", (0, 0));
    check("  a¦b", "ox<Esc>", "  ab\n  x", (1, 2));
    check("¦ab", "3ix<Esc>", "xxxab", (0, 2));
    check("¦ab", "2ox<Esc>", "ab\nx\nx", (2, 0));
    check("¦ab", "ixy<BS><Esc>", "xab", (0, 0));
    check("¦ab", "i<CR><Esc>", "\nab", (1, 0));
    check("¦a", "gIx<Esc>", "xa", (0, 0));
}

#[test]
fn dot_repeats_the_last_change() {
    check("¦a b c d", "dw.", "c d", (0, 0));
    check("¦a b c d e", "dw3.", "e", (0, 0));
    check("¦one\ntwo\nthree", "ddj.", "two", (0, 0));
    check("¦a a a", "cwx<Esc>w.", "x x a", (0, 2));
    check("¦a a a", "ix<Esc>.", "xxa a a", (0, 0));
    check("¦ab ab", "Ax<Esc>.", "ab abxx", (0, 6));
    check("¦a\nb\nc", "ox<Esc>.", "a\nx\nx\nb\nc", (2, 0));
    check("¦abcd", "x.", "cd", (0, 0));
    check("¦aaaa", "2x.", "", (0, 0));
    check("¦aaa", "rb.l.", "bba", (0, 1));
    check("¦a b", "yw.", "a b", (0, 0));
    check("¦abc abc", "x$.", "bc ab", (0, 4));
}

#[test]
fn counts_and_dot_with_a_new_count() {
    check("¦a b c d e f", "2dw.", "e f", (0, 0));
    check("¦abcdef", "2x3.", "f", (0, 0));
}

#[test]
fn undo_is_one_step_for_each_change() {
    let mut vim = Vim::new("¦one two three");
    vim.keys("cwxyz<Esc>");
    assert_eq!(vim.text(), "xyz two three");
    vim.keys("u");
    assert_eq!(vim.text(), "one two three");
    vim.keys("<C-r>");
    assert_eq!(vim.text(), "xyz two three");
    vim.keys("u");

    vim.keys("ihello world<Esc>");
    assert_eq!(vim.text(), "hello worldone two three");
    vim.keys("u");
    assert_eq!(vim.text(), "one two three");

    vim.keys("dwdw");
    assert_eq!(vim.text(), "three");
    vim.keys("u");
    assert_eq!(vim.text(), "two three");
    vim.keys("u");
    assert_eq!(vim.text(), "one two three");

    vim.keys("ofoo<CR>bar<Esc>");
    assert_eq!(vim.text(), "one two three\nfoo\nbar");
    vim.keys("u");
    assert_eq!(vim.text(), "one two three");

    vim.keys("3ix<Esc>");
    assert_eq!(vim.text(), "xxxone two three");
    vim.keys("u");
    assert_eq!(vim.text(), "one two three");

    vim.keys("2u");
    assert_eq!(vim.text(), "one two three");
}

#[test]
fn undo_with_a_count_goes_back_several_steps() {
    let mut vim = Vim::new("¦a b c d");
    vim.keys("dwdwdw");
    assert_eq!(vim.text(), "d");
    vim.keys("2u");
    assert_eq!(vim.text(), "b c d");
}

#[test]
fn visual_mode_selects_and_operates() {
    check("¦one two", "vd", "ne two", (0, 0));
    check("¦one two", "vly", "one two", (0, 0));
    check("¦one two", "vex", " two", (0, 0));
    check("¦one two", "vey$p", "one twoone", (0, 9));
    check("¦one two", "wviwd", "one ", (0, 3));
    check("¦one two", "viwc1<Esc>", "1 two", (0, 0));
    check("a\n¦b\nc", "Vd", "a\nc", (1, 0));
    check("a\n¦b\nc\nd", "Vjd", "a\nd", (1, 0));
    check("¦a\nb", "Vjy", "a\nb", (0, 0));
    check("¦a\nb", "Vy$p", "a\na\nb", (1, 0));
    check("¦ab", "vlU", "AB", (0, 0));
    check("¦ab", "v~", "Ab", (0, 0));
    check("¦a\nb", "VjJ", "a b", (0, 1));
    check("¦abc", "vlrx", "xxc", (0, 0));
    check("¦abc", "v$d", "", (0, 0));
    check("¦a\nb", "Vj>", "    a\n    b", (0, 4));
    check("¦one two", "ve<Esc>x", "on two", (0, 2));
}

#[test]
fn search_moves_to_matches_and_n_repeats_it() {
    check("¦foo bar foo baz foo", "/foo<CR>", "foo bar foo baz foo", (0, 8));
    check("¦foo bar foo baz foo", "/foo<CR>n", "foo bar foo baz foo", (0, 16));
    check("¦foo bar foo baz foo", "/foo<CR>nn", "foo bar foo baz foo", (0, 0));
    check("¦foo bar foo baz foo", "/foo<CR>N", "foo bar foo baz foo", (0, 0));
    check("foo bar ¦foo baz foo", "?foo<CR>", "foo bar foo baz foo", (0, 0));
    check("¦foo bar foo", "*", "foo bar foo", (0, 8));
    check("foo bar ¦foo", "#", "foo bar foo", (0, 0));
    check("¦foo bar foo baz foo", "2/foo<CR>", "foo bar foo baz foo", (0, 16));
    check("¦foo bar foo", "d/bar<CR>", "bar foo", (0, 0));
}

#[test]
fn the_search_is_remembered_between_commands() {
    let mut vim = Vim::new("¦a x a x a");
    vim.keys("/x<CR>");
    assert_eq!(vim.heads(), vec![at(0, 2)]);
    vim.keys("n");
    assert_eq!(vim.heads(), vec![at(0, 6)]);
    vim.keys("/<CR>");
    assert_eq!(vim.heads(), vec![at(0, 2)]);
    vim.keys("/nothing<CR>");
    assert_eq!(vim.errors.last().map(String::as_str), Some("E486: Pattern not found: nothing"));
    assert_eq!(vim.heads(), vec![at(0, 2)]);
}

#[test]
fn bracket_c_asks_the_app_for_the_next_and_previous_change() {
    use crate::vim::types::AppRequest;
    let mut vim = Vim::new("¦a\nb");
    vim.keys("]c[c");
    assert_eq!(vim.requests, vec![AppRequest::GotoChange { forward: true }, AppRequest::GotoChange { forward: false }]);
    vim.keys("]x");
    assert_eq!(vim.requests.len(), 2);
    assert_eq!(vim.mode(), "NORMAL");
}

#[test]
fn ex_commands_save_close_open_and_go_to_lines() {
    let mut vim = Vim::new("¦a\nb\nc\nd");
    vim.keys(":3<CR>");
    assert_eq!(vim.heads(), vec![at(2, 0)]);
    vim.keys(":$<CR>");
    assert_eq!(vim.heads(), vec![at(3, 0)]);
    vim.keys(":1<CR>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    vim.keys(":q<CR>");
    vim.keys(":q!<CR>");
    vim.keys(":e other.txt<CR>");
    use crate::vim::types::AppRequest;
    assert_eq!(
        vim.requests,
        vec![
            AppRequest::CloseTab { discard: false },
            AppRequest::CloseTab { discard: true },
            AppRequest::OpenFile { path: "other.txt".to_string() },
        ]
    );
    vim.keys(":bogus<CR>");
    assert_eq!(vim.errors.last().map(String::as_str), Some("E492: Not an editor command: bogus"));
    assert_eq!(vim.mode(), "NORMAL");
}

#[test]
fn ex_write_saves_and_wq_saves_then_closes() {
    let directory = std::env::temp_dir().join(format!("vim-ex-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("file.txt");
    std::fs::write(&path, "one\n").unwrap();
    let mut vim = Vim::new("¦x");
    vim.state.replace_buffer(Buffer::open(&path).unwrap());
    vim.keys("ihi <Esc>:w<CR>");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hi one\n");
    vim.keys("x:wq<CR>");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hione\n");
    assert_eq!(vim.requests.len(), 1);
}

#[test]
fn substitute_replaces_on_the_line_or_everywhere() {
    check("¦a a\na a", ":s/a/b/<CR>", "b a\na a", (0, 0));
    check("¦a a\na a", ":s/a/b/g<CR>", "b b\na a", (0, 0));
    check("¦a a\na a", ":%s/a/b/g<CR>", "b b\nb b", (1, 0));
    check("¦a a\na a", "Vj:s/a/b/g<CR>", "b b\nb b", (1, 0));
}

#[test]
fn the_command_line_can_be_edited_and_cancelled() {
    let mut vim = Vim::new("¦abc");
    vim.keys(":wx<BS><BS><BS>");
    assert_eq!(vim.layer.status().command_line, None);
    vim.keys(":abc<Esc>");
    assert_eq!(vim.layer.status().command_line, None);
    vim.keys(":ab");
    assert_eq!(vim.layer.status().command_line.as_deref(), Some(":ab"));
}

#[test]
fn modes_show_in_the_status() {
    let mut vim = Vim::new("¦abc");
    assert_eq!(vim.mode(), "NORMAL");
    vim.keys("v");
    assert_eq!(vim.mode(), "VISUAL");
    vim.keys("<Esc>V");
    assert_eq!(vim.mode(), "V-LINE");
    vim.keys("<Esc>i");
    assert_eq!(vim.mode(), "INSERT");
    vim.keys("<Esc>R");
    assert_eq!(vim.mode(), "REPLACE");
    vim.keys("<Esc>2d");
    assert_eq!(vim.layer.status().pending, "2d");
    vim.keys("<Esc>");
    assert_eq!(vim.layer.status().pending, "");
}

#[test]
fn the_cursor_shape_follows_the_mode() {
    use crate::keymap::CursorShape;
    let mut vim = Vim::new("¦abc");
    assert_eq!(vim.layer.status().cursor, CursorShape::Block);
    vim.keys("d");
    assert_eq!(vim.layer.status().cursor, CursorShape::Underline);
    vim.keys("<Esc>i");
    assert_eq!(vim.layer.status().cursor, CursorShape::Bar);
    vim.keys("<Esc>R");
    assert_eq!(vim.layer.status().cursor, CursorShape::Underline);
    vim.keys("<Esc>v");
    assert_eq!(vim.layer.status().cursor, CursorShape::Block);
}

#[test]
fn operators_apply_at_every_cursor() {
    let mut vim = Vim::new("¦one two\none two\none two");
    vim = vim.with_cursor(1, 0).with_cursor(2, 0);
    vim.keys("dw");
    assert_eq!(vim.text(), "two\ntwo\ntwo");
    assert_eq!(vim.heads(), vec![at(0, 0), at(1, 0), at(2, 0)]);
    vim.keys("u");
    assert_eq!(vim.text(), "one two\none two\none two");
    vim.keys("cwX<Esc>");
    assert_eq!(vim.text(), "X two\nX two\nX two");
    vim.keys("ix<Esc>");
    assert_eq!(vim.text(), "xX two\nxX two\nxX two");
    vim.keys("u");
    assert_eq!(vim.text(), "X two\nX two\nX two");
}

#[test]
fn motions_and_edits_reach_every_cursor() {
    let mut vim = Vim::new("¦ab cd\nef gh");
    vim = vim.with_cursor(1, 0);
    vim.keys("wx");
    assert_eq!(vim.text(), "ab d\nef h");
    vim.keys("0A!<Esc>");
    assert_eq!(vim.text(), "ab d!\nef h!");
    vim.keys("yyP");
    assert_eq!(vim.text(), "ab d!\nab d!\nef h!\nef h!");
}

#[test]
fn putting_a_register_with_a_piece_for_each_cursor_gives_each_its_own() {
    let mut vim = Vim::new("¦a b\nc d");
    vim = vim.with_cursor(1, 0);
    vim.keys("yl$p");
    assert_eq!(vim.text(), "a ba\nc dc");
}

#[test]
fn marks_jump_back() {
    check("¦one\ntwo\nthree", "majj'a", "one\ntwo\nthree", (0, 0));
    check("on¦e\ntwo\nthree", "majj`a", "one\ntwo\nthree", (0, 2));
}

#[test]
fn control_keys_the_layer_does_not_use_go_to_the_app() {
    let mut vim = Vim::new("¦abc");
    let key = KeyInput { key: "p".to_string(), modifiers: Modifiers { control: true, alt: false, shift: false } };
    assert!(vim.layer.translate(&key, &CONTEXT).is_empty());
    let save = KeyInput { key: "s".to_string(), modifiers: Modifiers { control: true, alt: false, shift: false } };
    assert_eq!(vim.layer.translate(&save, &CONTEXT), vec![Command::Save]);
}

#[test]
fn page_keys_scroll_the_view_and_bring_the_cursor() {
    let text: String = (0..40).map(|row| format!("{row}\n")).collect();
    let mut vim = Vim::new(&format!("¦{text}"));
    vim.keys("<C-d>");
    assert_eq!((vim.top_row, vim.heads()), (5, vec![at(5, 0)]));
    vim.keys("<C-f>");
    assert_eq!((vim.top_row, vim.heads()), (13, vec![at(13, 0)]));
    vim.keys("<C-b>");
    assert_eq!((vim.top_row, vim.heads()), (5, vec![at(14, 0)]));
    vim.keys("<C-u>");
    assert_eq!((vim.top_row, vim.heads()), (0, vec![at(9, 0)]));
}

#[test]
fn ctrl_f_moves_the_view_a_page_less_two_lines_and_ctrl_b_back() {
    let text: String = (0..60).map(|row| format!("{row}\n")).collect();
    let mut vim = Vim::new(&format!("¦{text}"));
    vim.keys("<C-f><C-f>");
    assert_eq!((vim.top_row, vim.heads()), (16, vec![at(16, 0)]));
    vim.keys("<C-b>");
    assert_eq!((vim.top_row, vim.heads()), (8, vec![at(17, 0)]));
    vim.keys("<C-b><C-b>");
    assert_eq!((vim.top_row, vim.heads()), (0, vec![at(9, 0)]));
}

#[test]
fn page_keys_extend_a_visual_selection() {
    let text: String = (0..40).map(|row| format!("{row}\n")).collect();
    let mut vim = Vim::new(&format!("¦{text}"));
    vim.keys("v<C-f>");
    let selection = vim.state.selections().newest();
    assert_eq!((selection.anchor, selection.head), (at(0, 0), at(8, 0)));
}

#[test]
fn screen_keys_use_the_rows_in_view() {
    let text: String = (0..40).map(|row| format!("{row}\n")).collect();
    let mut vim = Vim::new(&format!("¦{text}"));
    let context = InputContext { page_rows: 10, top_row: 20 };
    for (typed, row) in [("H", 20), ("M", 24), ("L", 29)] {
        for key in key_list(typed) {
            for command in vim.layer.translate(&key, &context) {
                vim.state.apply(&command);
            }
        }
        assert_eq!(vim.heads(), vec![at(row, 0)], "{typed}");
    }
}

#[test]
fn zz_asks_the_view_to_scroll() {
    use crate::vim::types::ScrollAlign;
    let mut vim = Vim::new("¦abc");
    let commands: Vec<Command> = key_list("zz").iter().flat_map(|key| vim.layer.translate(key, &CONTEXT)).collect();
    assert!(commands.contains(&Command::ScrollTo { align: ScrollAlign::Center }));
}

#[test]
fn ctrl_n_selects_the_word_and_each_next_match_then_operators_apply_to_all() {
    let mut vim = Vim::new("¦foo bar foo baz foo");
    vim.keys("<C-n>");
    assert_eq!(vim.mode(), "VISUAL");
    vim.keys("<C-n><C-n>");
    assert_eq!(vim.state.selections().count(), 3);
    vim.keys("cx<Esc>");
    assert_eq!(vim.text(), "x bar x baz x");
    assert_eq!(vim.state.selections().count(), 3);
    vim.keys("u");
    assert_eq!(vim.text(), "foo bar foo baz foo");
}

#[test]
fn escape_in_normal_mode_collapses_extra_cursors() {
    let mut vim = Vim::new("¦a\nb").with_cursor(1, 0);
    vim.keys("<Esc>");
    assert_eq!(vim.state.selections().count(), 1);
}

#[test]
fn vim_commands_round_trip_through_json() {
    use crate::movement::Motion;
    use crate::vim::types::{Operator, SearchRequest, Target};
    let commands = [
        Command::Operate {
            operator: Operator::Change,
            target: Target::Motion {
                motion: Motion::FindChar { character: 'x', forward: true, till: false, repeat: false },
                count: 2,
            },
            register: Some('a'),
        },
        Command::VimSearch {
            request: SearchRequest::Pattern { pattern: "foo".to_string(), forward: false },
            count: 1,
            extend: false,
        },
        Command::Put { register: None, before: true, count: 3, cursor_after: false, over: None, clipboard: None },
        Command::GroupUndo { open: true },
        Command::Noop,
        Command::StartJump {
            then: Box::new(Command::VimMove { motion: Motion::To(at(3, 4)), count: 1, extend: false }),
        },
    ];
    for command in commands {
        let json = serde_json::to_value(&command).unwrap();
        assert_eq!(serde_json::from_value::<Command>(json).unwrap(), command);
    }
    let from_svelte: Command =
        serde_json::from_str(r#"{"type": "vim_move", "motion": {"word_forward": {"big": false}}, "count": 2}"#)
            .unwrap();
    assert!(matches!(from_svelte, Command::VimMove { count: 2, extend: false, .. }));
}

/// The command a typed key started a jump with, or none when it started no jump.
fn jump_started_by(marked: &str, typed: &str) -> Option<Command> {
    let mut vim = Vim::new(marked);
    let mut started = None;
    for key in key_list(typed) {
        for command in vim.layer.translate(&key, &CONTEXT) {
            if let Command::StartJump { then } = command {
                started = Some(*then);
            }
        }
    }
    started
}

#[test]
fn s_starts_jump_labels_that_move_the_cursor_or_extend_the_selection() {
    let then = jump_started_by("¦one two", "s").unwrap();
    assert_eq!(
        then.with_jump_target(at(0, 4)),
        Command::VimMove { motion: crate::movement::Motion::To(at(0, 4)), count: 1, extend: false }
    );
    let in_visual = jump_started_by("¦one two", "vs").unwrap();
    assert!(matches!(in_visual, Command::VimMove { extend: true, .. }));
}

#[test]
fn an_operator_takes_the_jump_as_its_motion() {
    use crate::vim::types::Operator;
    let then = jump_started_by("¦one two three", "ds").unwrap();
    assert!(matches!(then, Command::Operate { operator: Operator::Delete, .. }));
    let mut vim = Vim::new("¦one two three");
    vim.state.apply(&then.with_jump_target(at(0, 8)));
    assert_eq!(vim.text(), "three");
    assert_eq!(jump_started_by("¦one two", "cs"), None);
}

#[test]
fn backspace_in_replace_mode_puts_back_what_was_typed_over() {
    check("¦abcd", "Rxy<BS><Esc>", "xbcd", (0, 0));
    check("¦abcd", "Rxyz<BS><BS><Esc>", "xbcd", (0, 0));
    check("¦abcd", "Rxyz<BS><BS><BS><Esc>", "abcd", (0, 0));
    check("a¦b", "Rxyz<BS><Esc>", "axy", (0, 2));
    check("¦abcd", "R<BS>x<Esc>", "xbcd", (0, 0));
    let mut vim = Vim::new("¦ab\ncd").with_cursor(1, 0);
    vim.keys("Rxy<BS><Esc>");
    assert_eq!(vim.text(), "xb\nxd");
}

#[test]
fn gv_selects_the_last_visual_selection_again() {
    let mut vim = Vim::new("¦one two three");
    vim.keys("vw<Esc>");
    assert_eq!(vim.mode(), "NORMAL");
    vim.keys("$gv");
    assert_eq!(vim.mode(), "VISUAL");
    let selection = vim.state.selections().newest();
    assert_eq!((selection.anchor, selection.head), (at(0, 0), at(0, 4)));
    vim.keys("d");
    assert_eq!(vim.text(), "wo three");
    let mut lines = Vim::new("a\n¦b\nc\nd");
    lines.keys("Vj<Esc>ggjjgv");
    assert_eq!(lines.mode(), "V-LINE");
    lines.keys("d");
    assert_eq!(lines.text(), "a\nd");
}

#[test]
fn dot_repeats_an_operator_on_a_visual_selection() {
    check("¦abcdef", "vld.", "ef", (0, 0));
    check("¦abcdef", "vlc1<Esc>l.", "11ef", (0, 1));
    check("¦a\nb\nc\nd\ne", "Vjd.", "e", (0, 0));
    check("¦abcdef", "vlUll.", "ABCDef", (0, 2));
    check("¦abc abc", "vlrxw.", "xxc xxc", (0, 4));
    check("¦a b c", "vlyx.", "b c", (0, 0));
}

#[test]
fn macros_record_keys_and_play_them_back() {
    check("¦a\nb\nc\nd", "qaA!<Esc>jq@a", "a!\nb!\nc\nd", (2, 0));
    check("¦a\nb\nc\nd", "qaA!<Esc>jq2@a", "a!\nb!\nc!\nd", (3, 0));
    check("¦a\nb\nc\nd", "qaA!<Esc>jq@a@@", "a!\nb!\nc!\nd", (3, 0));
    check("¦one two", "qqdwq@q", "", (0, 0));
    check("¦x", "@z", "x", (0, 0));
}

#[test]
fn a_macro_that_plays_itself_ends() {
    let mut vim = Vim::new("¦a\nb");
    vim.keys("qaix<Esc>@aq");
    vim.keys("@a");
    assert_eq!(vim.mode(), "NORMAL");
}

#[test]
fn ctrl_o_and_ctrl_i_move_through_the_jump_list() {
    let mut vim = Vim::new("¦a\nb\nc\nd\ne");
    vim.keys("G");
    assert_eq!(vim.heads(), vec![at(4, 0)]);
    vim.keys("<C-o>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    vim.keys("<C-i>");
    assert_eq!(vim.heads(), vec![at(4, 0)]);
    vim.keys("gg<C-o>");
    assert_eq!(vim.heads(), vec![at(4, 0)]);
    vim.keys("<Tab>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
}

#[test]
fn searches_and_line_numbers_are_jumps_too() {
    let mut vim = Vim::new("¦one\ntwo\nthree\nfour");
    vim.keys("/four<CR>");
    assert_eq!(vim.heads(), vec![at(3, 0)]);
    vim.keys("<C-o>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    vim.keys(":3<CR>");
    assert_eq!(vim.heads(), vec![at(2, 0)]);
    vim.keys("<C-o>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
}

#[test]
fn search_takes_regular_expressions() {
    check("¦a1 b22 c333", "/[0-9]\\{3}<CR>", "a1 b22 c333", (0, 8));
    check("¦one two three", "/t\\w\\+e<CR>", "one two three", (0, 8));
    check("¦let x = 1; let y = 2;", "/\\<lt>y\\<gt><CR>", "let x = 1; let y = 2;", (0, 15));
    check("¦foo\nbar\nfoo", "/^bar$<CR>", "foo\nbar\nfoo", (1, 0));
    check("¦cat dog bird", "/dog\\|bird<CR>n", "cat dog bird", (0, 8));
    check("a ¦b", "?a\\|b<CR>", "a b", (0, 0));
    check("¦Foo foo", "/foo\\c<CR>", "Foo foo", (0, 4));
}

#[test]
fn star_matches_the_word_as_text() {
    check("¦a.b x a.b ab", "*", "a.b x a.b ab", (0, 6));
    check("¦$el x $el", "*", "$el x $el", (0, 7));
}

#[test]
fn a_broken_pattern_says_so_and_stays_put() {
    let mut vim = Vim::new("¦abc");
    vim.keys("/\\(<CR>");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    assert!(vim.errors.iter().any(|message| message.starts_with("E486") || message.starts_with("E383")));
}

#[test]
fn substitute_takes_regular_expressions_groups_and_flags() {
    check("¦a1 b22", ":s/[0-9]\\+/N/g<CR>", "aN bN", (0, 0));
    check("¦foo bar", ":s/\\(\\w\\+\\) \\(\\w\\+\\)/\\2 \\1/<CR>", "bar foo", (0, 0));
    check("¦cat", ":s/c/[&]/<CR>", "[c]at", (0, 0));
    check("¦Cat cat", ":s/cat/dog/gi<CR>", "dog dog", (0, 0));
    check("¦Cat cat", ":s/cat/dog/g<CR>", "Cat dog", (0, 0));
    check("¦a b", ":s/ /\\r/<CR>", "a\nb", (0, 0));
    check("¦one\ntwo", ":%s/^/> /<CR>", "> one\n> two", (1, 0));
    check("¦aaa", ":s/a*/x/<CR>", "x", (0, 0));
}

#[test]
fn an_empty_substitute_pattern_uses_the_last_search() {
    check("¦foo bar foo", "/bar<CR>0:s//X/<CR>", "foo X foo", (0, 0));
    check("¦foo bar", ":s/foo/X/<CR>:s//Y/<CR>", "X bar", (0, 0));
}

#[test]
fn substitute_leaves_the_last_pattern_for_n() {
    let mut vim = Vim::new("¦ab ab ab\nab");
    vim.keys(":s/b/B/<CR>");
    assert_eq!(vim.text(), "aB ab ab\nab");
    vim.keys("n");
    assert_eq!(vim.heads(), vec![at(0, 4)]);
}

#[test]
fn visual_block_selects_a_rectangle_and_operators_work_on_it() {
    let mut vim = Vim::new("¦abcd\nabcd\nabcd");
    vim.keys("<C-v>jl");
    assert_eq!(vim.mode(), "V-BLOCK");
    assert_eq!(vim.state.selections().count(), 2);
    vim.keys("d");
    assert_eq!(vim.text(), "cd\ncd\nabcd");
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    assert_eq!(vim.mode(), "NORMAL");
    check("¦abcd\nabcd\nabcd", "l<C-v>jjld", "ad\nad\nad", (0, 1));
    check("¦abcd\nab\nabcd", "ll<C-v>jjd", "abd\nab\nabd", (0, 2));
    check("¦abcd\nabcd", "<C-v>j$d", "\n", (0, 0));
    check("¦abcd\nabcd", "<C-v>jly$p", "abcdab\nabcdab", (0, 4));
}

#[test]
fn visual_block_insert_append_and_change_type_on_every_line() {
    check("¦abc\nabc\nabc", "<C-v>jjIX<Esc>", "Xabc\nXabc\nXabc", (0, 0));
    check("¦abc\nabc\nabc", "l<C-v>jjAX<Esc>", "abXc\nabXc\nabXc", (0, 2));
    check("¦abc\nabc", "<C-v>jlcX<Esc>", "Xc\nXc", (0, 0));
    check("¦abc\nabc", "<C-v>j$AX<Esc>", "abcX\nabcX", (0, 3));
    check("¦abc\nabc", "<C-v>jrx", "xbc\nxbc", (0, 0));
    check("¦abc\nabc", "<C-v>jlU", "ABc\nABc", (0, 0));
}

#[test]
fn visual_block_moves_by_corner_and_can_become_another_selection() {
    let mut vim = Vim::new("¦abcd\nabcd\nabcd");
    vim.keys("<C-v>jlo");
    let selection = vim.state.selections().newest();
    assert_eq!(selection.head, at(0, 0));
    vim.keys("jj");
    assert_eq!(vim.state.selections().count(), 2);
    vim.keys("<Esc>");
    assert_eq!(vim.mode(), "NORMAL");
    assert_eq!(vim.state.selections().count(), 1);
    vim.keys("<C-v>jv");
    assert_eq!(vim.mode(), "VISUAL");
    assert_eq!(vim.state.selections().count(), 1);
    vim.keys("<C-v><C-v>");
    assert_eq!(vim.mode(), "NORMAL");
}

#[test]
fn gv_and_dot_work_with_a_block() {
    let mut vim = Vim::new("¦abcd\nabcd\nabcd\nabcd");
    vim.keys("<C-v>jd");
    assert_eq!(vim.text(), "bcd\nbcd\nabcd\nabcd");
    vim.keys("jj.");
    assert_eq!(vim.text(), "bcd\nbcd\nbcd\nbcd");
    let mut again = Vim::new("¦abc\nabc");
    again.keys("<C-v>j<Esc>gv");
    assert_eq!(again.mode(), "V-BLOCK");
    assert_eq!(again.state.selections().count(), 2);
}

#[test]
fn tag_and_sentence_objects_work_with_operators() {
    check("<p>hel¦lo <b>x</b></p>", "dit", "<p></p>", (0, 3));
    check("<p>hel¦lo</p>", "dat", "", (0, 0));
    check("<a><b>¦x</b></a>", "d2it", "<a></a>", (0, 3));
    check("One. Tw¦o three. Four.", "cisX<Esc>", "One. X Four.", (0, 5));
    check("One. Tw¦o three. Four.", "das", "One. Four.", (0, 5));
    check("One. Tw¦o three. Four.", "visd", "One.  Four.", (0, 5));
}

#[test]
fn escape_in_normal_mode_clears_the_search_highlight() {
    let mut vim = Vim::new("¦foo bar foo");
    vim.keys("/foo<CR>");
    assert!(vim.state.memory.search_highlight);
    vim.keys("<Esc>");
    assert!(!vim.state.memory.search_highlight);
    vim.keys("n");
    assert!(vim.state.memory.search_highlight);
    vim.keys(":noh<CR>");
    assert!(!vim.state.memory.search_highlight);
}

#[test]
fn a_bare_space_in_normal_mode_is_left_to_the_app_when_it_has_a_leader_key() {
    let mut vim = Vim::new("¦abc");
    vim.layer.set_leader_key(true);
    assert!(vim.layer.translate(&named_key("Space"), &CONTEXT).is_empty());
    assert_eq!(vim.heads(), vec![at(0, 0)]);
    // Space is still a motion once something else has begun the command.
    check_with_leader("¦abc", "d<Space>", "bc", (0, 0));
    check_with_leader("¦abcdef", "2<Space>x", "abdef", (0, 2));
    check_with_leader("¦abc", "v<Space>d", "c", (0, 0));
}

#[test]
fn space_moves_right_when_the_app_has_no_leader_key() {
    check("¦abc", "<Space>", "abc", (0, 1));
}

/// Like `check`, with the app's leader key bound.
fn check_with_leader(marked: &str, typed: &str, expected_text: &str, expected_cursor: (usize, usize)) {
    let mut vim = Vim::new(marked);
    vim.layer.set_leader_key(true);
    vim.keys(typed);
    assert_eq!(vim.text(), expected_text, "text after {typed:?} in {marked:?}");
    assert_eq!(vim.heads(), vec![at(expected_cursor.0, expected_cursor.1)], "cursor after {typed:?} in {marked:?}");
}
