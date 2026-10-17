//! The keys of a jump in progress. While jump labels are showing, every key goes to the session
//! (see `editor_core::jump`) instead of the input layer, until a label is chosen or the jump is
//! cancelled.

use editor_core::jump::{JumpKey, JumpSession, JumpStep};
use editor_core::{Command, Position};
use svelte_gpui::gpui::{Context, Keystroke};

use super::{Editor, typed_character};

impl Editor {
    /// Starts a jump over the rows in view, which runs `then` with the place that is chosen. Does
    /// nothing before the first frame, when there are no rows to label.
    pub(super) fn start_jump(&mut self, then: Command) {
        let Some((first_row, last_row)) = self.visible_text_rows() else {
            return;
        };
        let Some(origin) = self.read(|state| state.selections().newest().head) else {
            return;
        };
        self.jump = Some(JumpSession::new(then, origin, first_row..last_row + 1));
    }

    /// Gives a key to the jump. Characters narrow the search or pick a label, Backspace takes one
    /// back, Enter picks the nearest match and Escape cancels. Any other key cancels the jump and
    /// goes on to the app, so shortcuts keep working. Returns whether the key was used.
    pub(super) fn jump_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let Some(key) = jump_key_for(keystroke) else {
            self.jump = None;
            return false;
        };
        let Some(mut session) = self.jump.take() else {
            return false;
        };
        let step = self.read(|state| session.press(state.buffer(), key)).unwrap_or(JumpStep::Cancel);
        match step {
            JumpStep::Continue => self.jump = Some(session),
            JumpStep::Jump(at) => self.finish_jump(&session, at, cx),
            JumpStep::Cancel => {}
        }
        true
    }

    /// Runs the jump's command for the place that was chosen.
    fn finish_jump(&mut self, session: &JumpSession, at: Position, cx: &mut Context<Self>) {
        self.apply(&session.command_for(at), cx);
    }
}

/// The key a jump session takes a keystroke as, or none for one it does not use.
fn jump_key_for(keystroke: &Keystroke) -> Option<JumpKey> {
    match keystroke.key.as_str() {
        "escape" => return Some(JumpKey::Escape),
        "enter" => return Some(JumpKey::Enter),
        "backspace" => return Some(JumpKey::Backspace),
        "space" if !keystroke.modifiers.control && !keystroke.modifiers.alt => return Some(JumpKey::Character(' ')),
        _ => {}
    }
    let text = typed_character(keystroke)?;
    text.chars().next().map(JumpKey::Character)
}
