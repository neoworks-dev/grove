//! Input layers: the part that turns keys into commands, and nothing else. The standard layer
//! is VS Code's keys. A vim layer slots in beside it as another [`InputLayer`], a state machine
//! over mode, count and pending operator that emits the same commands, so a motion and multiple
//! cursors work the same in both.

use crate::command::Command;
use crate::movement::Motion;

/// The modifier keys held with a key. Only the ones the editor reads are here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

/// A key press, in terms of the editor rather than any window system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyInput {
    /// The key's name as GPUI spells it: `left`, `pageup`, `escape`, or the character itself.
    pub key: String,
    pub modifiers: Modifiers,
}

/// What a layer may need to know about the view to translate a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputContext {
    /// How many rows a page is, for the keys that move by one.
    pub page_rows: usize,
}

/// Turns key presses into commands. A layer may keep state between keys, which is why it is
/// borrowed mutably; the view holds one and asks it about every key.
pub trait InputLayer {
    /// The command a key makes, or none when the layer leaves the key for whatever is behind
    /// the editor.
    fn translate(&mut self, key: &KeyInput, context: &InputContext) -> Option<Command>;
}

/// VS Code's keys: cursor keys, Home and End, Ctrl-A and Ctrl-D, Ctrl-Alt-Up and Down, Escape.
#[derive(Clone, Copy, Debug, Default)]
pub struct StandardKeymap;

impl InputLayer for StandardKeymap {
    fn translate(&mut self, key: &KeyInput, context: &InputContext) -> Option<Command> {
        standard_command(key, context)
    }
}

/// The command the standard keymap gives a key.
pub fn standard_command(key: &KeyInput, context: &InputContext) -> Option<Command> {
    let modifiers = key.modifiers;
    if modifiers.control && modifiers.alt {
        return multi_cursor_command(&key.key);
    }
    if modifiers.control {
        return control_command(&key.key, modifiers.shift);
    }
    if key.key == "escape" {
        return Some(Command::CollapseSelections);
    }
    let motion = cursor_key_motion(&key.key, context.page_rows)?;
    Some(Command::MoveSelections { motion, extend: modifiers.shift })
}

/// Ctrl-Alt-Up and Ctrl-Alt-Down add a cursor on the line above or below.
fn multi_cursor_command(key: &str) -> Option<Command> {
    match key {
        "up" => Some(Command::AddCursorAbove),
        "down" => Some(Command::AddCursorBelow),
        _ => None,
    }
}

/// Ctrl with another key: the buffer's ends, selecting all, and selecting the next match.
fn control_command(key: &str, extend: bool) -> Option<Command> {
    match key {
        "home" => Some(Command::MoveSelections { motion: Motion::BufferStart, extend }),
        "end" => Some(Command::MoveSelections { motion: Motion::BufferEnd, extend }),
        "a" => Some(Command::SelectAll),
        "d" => Some(Command::SelectNextOccurrence),
        _ => None,
    }
}

/// The motion a plain cursor key makes.
fn cursor_key_motion(key: &str, page_rows: usize) -> Option<Motion> {
    let page = page_rows as isize;
    let motion = match key {
        "left" => Motion::Left,
        "right" => Motion::Right,
        "up" => Motion::Vertical(-1),
        "down" => Motion::Vertical(1),
        "pageup" => Motion::Vertical(-page),
        "pagedown" => Motion::Vertical(page),
        "home" => Motion::LineStart,
        "end" => Motion::LineEnd,
        _ => return None,
    };
    Some(motion)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: InputContext = InputContext { page_rows: 30 };

    fn press(key: &str, control: bool, alt: bool, shift: bool) -> Option<Command> {
        let input = KeyInput { key: key.to_string(), modifiers: Modifiers { control, alt, shift } };
        StandardKeymap.translate(&input, &PAGE)
    }

    fn movement(motion: Motion, extend: bool) -> Option<Command> {
        Some(Command::MoveSelections { motion, extend })
    }

    #[test]
    fn cursor_keys_move_and_shift_extends() {
        assert_eq!(press("left", false, false, false), movement(Motion::Left, false));
        assert_eq!(press("right", false, false, true), movement(Motion::Right, true));
        assert_eq!(press("up", false, false, false), movement(Motion::Vertical(-1), false));
        assert_eq!(press("down", false, false, false), movement(Motion::Vertical(1), false));
        assert_eq!(press("home", false, false, false), movement(Motion::LineStart, false));
        assert_eq!(press("end", false, false, true), movement(Motion::LineEnd, true));
    }

    #[test]
    fn pages_are_as_many_rows_as_the_view_says() {
        assert_eq!(press("pageup", false, false, false), movement(Motion::Vertical(-30), false));
        assert_eq!(press("pagedown", false, false, true), movement(Motion::Vertical(30), true));
    }

    #[test]
    fn control_keys_reach_the_ends_select_all_and_the_next_match() {
        assert_eq!(press("home", true, false, false), movement(Motion::BufferStart, false));
        assert_eq!(press("end", true, false, true), movement(Motion::BufferEnd, true));
        assert_eq!(press("a", true, false, false), Some(Command::SelectAll));
        assert_eq!(press("d", true, false, false), Some(Command::SelectNextOccurrence));
        assert_eq!(press("left", true, false, false), None);
    }

    #[test]
    fn control_alt_up_and_down_add_cursors() {
        assert_eq!(press("up", true, true, false), Some(Command::AddCursorAbove));
        assert_eq!(press("down", true, true, false), Some(Command::AddCursorBelow));
        assert_eq!(press("a", true, true, false), None);
    }

    #[test]
    fn escape_collapses_and_other_keys_are_left_alone() {
        assert_eq!(press("escape", false, false, false), Some(Command::CollapseSelections));
        assert_eq!(press("x", false, false, false), None);
        assert_eq!(press("tab", false, false, false), None);
    }

    #[test]
    fn alt_alone_does_not_change_a_cursor_key() {
        assert_eq!(press("left", false, true, false), movement(Motion::Left, false));
    }
}
