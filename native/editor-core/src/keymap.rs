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
    /// The first row in view, for the keys that go to the top, middle or bottom of the view.
    pub top_row: usize,
}

/// Turns key presses into commands. A layer may keep state between keys, which is why it is
/// borrowed mutably; the view holds one and asks it about every key.
pub trait InputLayer {
    /// The commands a key makes, in the order to apply them, or none when the layer leaves the
    /// key for whatever is behind the editor. A layer with several to give, such as a vim key
    /// that deletes and then switches mode, returns them all.
    fn translate(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command>;

    /// What the view shows of the layer's state: the mode, keys waiting for the rest of a
    /// command, and the cursor to draw. A layer without modes keeps the default.
    fn status(&self) -> InputStatus {
        InputStatus::default()
    }

    /// Whether the app has a leader key sequence bound, which a modal layer then leaves a bare space
    /// for instead of using it as a motion. A layer without modes ignores it.
    fn set_leader_key(&mut self, _enabled: bool) {}
}

/// The cursor a layer asks for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorShape {
    /// A thin line between characters, as the standard keymap and insert mode use.
    #[default]
    Bar,
    /// A box over the character, as vim's normal and visual modes use.
    Block,
    /// A line under the character, as replace mode and a pending operator use.
    Underline,
}

/// How selections are painted: whether the character under the head is part of them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectionStyle {
    /// From the anchor up to the head.
    #[default]
    Exclusive,
    /// Both the anchor's and the head's characters, as in vim's visual mode.
    Inclusive,
    /// Every line the selection touches, whole.
    Lines,
}

/// What a layer shows of itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputStatus {
    /// The mode's name, such as `NORMAL`, or empty for a layer that has none.
    pub mode: &'static str,
    /// The keys typed so far of a command that is not complete.
    pub pending: String,
    /// The line being typed after `:`, `/` or `?`, with that character first.
    pub command_line: Option<String>,
    pub cursor: CursorShape,
    pub selection: SelectionStyle,
}

/// VS Code's keys: cursor keys, Home and End, Ctrl-A and Ctrl-D, Ctrl-Alt-Up and Down, Escape,
/// Backspace, Delete, Enter and Tab, undo and redo, the clipboard keys and Ctrl-S.
#[derive(Clone, Copy, Debug, Default)]
pub struct StandardKeymap;

impl InputLayer for StandardKeymap {
    fn translate(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command> {
        standard_command(key, context).into_iter().collect()
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
    if modifiers.alt && key.key == "j" {
        return Some(Command::StartJump { then: Box::new(jump_target_move()) });
    }
    if modifiers.alt {
        return cursor_key_command(key, context);
    }
    if key.key == "tab" && modifiers.shift {
        return Some(Command::Outdent);
    }
    if let Some(command) = editing_key_command(&key.key) {
        return Some(command);
    }
    if key.key == "escape" {
        return Some(Command::CollapseSelections);
    }
    cursor_key_command(key, context)
}

/// What the standard keys do with the place a jump picks: move the cursor there.
fn jump_target_move() -> Command {
    Command::MoveSelections { motion: Motion::To(crate::buffer::Position::default()), extend: false }
}

/// Backspace, Delete, Enter and Tab, which Shift does not change.
fn editing_key_command(key: &str) -> Option<Command> {
    match key {
        "backspace" => Some(Command::Delete { motion: Motion::Left }),
        "delete" => Some(Command::Delete { motion: Motion::Right }),
        "enter" => Some(Command::InsertNewline),
        "tab" => Some(Command::InsertTab),
        _ => None,
    }
}

/// A cursor key: moving, or extending the selection with Shift.
fn cursor_key_command(key: &KeyInput, context: &InputContext) -> Option<Command> {
    let modifiers = key.modifiers;
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

/// Ctrl with another key: the buffer's ends, selecting, undo and redo, the clipboard and saving.
fn control_command(key: &str, extend: bool) -> Option<Command> {
    match key {
        "z" if extend => Some(Command::Redo),
        "z" => Some(Command::Undo),
        "y" => Some(Command::Redo),
        "c" => Some(Command::Copy),
        "x" => Some(Command::Cut),
        "v" => Some(Command::PasteClipboard),
        "s" => Some(Command::Save),
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

    const PAGE: InputContext = InputContext { page_rows: 30, top_row: 0 };

    fn press(key: &str, control: bool, alt: bool, shift: bool) -> Option<Command> {
        let input = KeyInput { key: key.to_string(), modifiers: Modifiers { control, alt, shift } };
        let mut commands = StandardKeymap.translate(&input, &PAGE);
        assert!(commands.len() <= 1, "the standard keymap gives one command per key");
        commands.pop()
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
        assert_eq!(press("f5", false, false, false), None);
    }

    #[test]
    fn keys_the_layer_leaves_alone_give_an_empty_list() {
        let input = KeyInput { key: "space".to_string(), modifiers: Modifiers::default() };
        assert!(StandardKeymap.translate(&input, &PAGE).is_empty());
    }

    #[test]
    fn editing_keys_make_edit_commands() {
        assert_eq!(press("backspace", false, false, false), Some(Command::Delete { motion: Motion::Left }));
        assert_eq!(press("delete", false, false, false), Some(Command::Delete { motion: Motion::Right }));
        assert_eq!(press("enter", false, false, true), Some(Command::InsertNewline));
        assert_eq!(press("tab", false, false, false), Some(Command::InsertTab));
        assert_eq!(press("tab", false, false, true), Some(Command::Outdent));
        assert_eq!(press("backspace", false, true, false), None);
    }

    #[test]
    fn control_keys_undo_redo_copy_paste_and_save() {
        assert_eq!(press("z", true, false, false), Some(Command::Undo));
        assert_eq!(press("z", true, false, true), Some(Command::Redo));
        assert_eq!(press("y", true, false, false), Some(Command::Redo));
        assert_eq!(press("c", true, false, false), Some(Command::Copy));
        assert_eq!(press("x", true, false, false), Some(Command::Cut));
        assert_eq!(press("v", true, false, false), Some(Command::PasteClipboard));
        assert_eq!(press("s", true, false, false), Some(Command::Save));
    }

    #[test]
    fn alt_j_starts_jump_labels() {
        assert_eq!(press("j", false, true, false), Some(Command::StartJump { then: Box::new(jump_target_move()) }));
    }

    #[test]
    fn alt_alone_does_not_change_a_cursor_key() {
        assert_eq!(press("left", false, true, false), movement(Motion::Left, false));
    }
}
