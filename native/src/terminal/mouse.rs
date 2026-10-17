//! The mouse as a terminal program asks to hear of it: the sequences for presses, releases, drags,
//! motion and the wheel, in the SGR form (mode 1006) or the older X10 one, and the arrow keys a
//! wheel turns into on the alternate screen.

use alacritty_terminal::term::TermMode;

/// A button as the protocol numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportedButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    /// Motion with no button down.
    None,
}

/// What happened to the button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportedAction {
    Press,
    Release,
    Motion,
}

/// The keys held while the pointer did it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReportedModifiers {
    pub shift: bool,
    pub alt: bool,
    pub control: bool,
}

/// The largest column or row the X10 form can name (a byte offset by 32).
const LEGACY_LIMIT: usize = 222;

/// The sequence for a mouse event at a cell, or none when the program did not ask for it or the
/// cell is out of range for the form it asked for. Cells count from zero.
pub fn encode_mouse(
    button: ReportedButton,
    action: ReportedAction,
    modifiers: ReportedModifiers,
    column: usize,
    line: usize,
    mode: TermMode,
) -> Option<String> {
    if !wants_event(action, button, mode) {
        return None;
    }
    let code = button_code(button, action, modifiers, mode);
    if mode.contains(TermMode::SGR_MOUSE) {
        let final_byte = match action {
            ReportedAction::Release => 'm',
            _ => 'M',
        };
        return Some(format!("\x1b[<{code};{};{}{final_byte}", column + 1, line + 1));
    }
    legacy_sequence(code, column, line)
}

/// Whether the modes the program set include this kind of event.
fn wants_event(action: ReportedAction, button: ReportedButton, mode: TermMode) -> bool {
    match action {
        ReportedAction::Press | ReportedAction::Release => mode.intersects(TermMode::MOUSE_MODE),
        ReportedAction::Motion => {
            if button == ReportedButton::None {
                return mode.contains(TermMode::MOUSE_MOTION);
            }
            mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION)
        }
    }
}

/// The button number with the modifier and motion bits added.
fn button_code(button: ReportedButton, action: ReportedAction, modifiers: ReportedModifiers, mode: TermMode) -> u8 {
    let mut code = match button {
        ReportedButton::Left => 0,
        ReportedButton::Middle => 1,
        ReportedButton::Right => 2,
        ReportedButton::None => 3,
        ReportedButton::WheelUp => 64,
        ReportedButton::WheelDown => 65,
    };
    // The X10 form has no release per button: it reports button 3.
    if action == ReportedAction::Release && !mode.contains(TermMode::SGR_MOUSE) {
        code = 3;
    }
    if modifiers.shift {
        code += 4;
    }
    if modifiers.alt {
        code += 8;
    }
    if modifiers.control {
        code += 16;
    }
    if action == ReportedAction::Motion {
        code += 32;
    }
    code
}

/// `ESC [ M` followed by three bytes, each offset by 32 (and the position by one more).
fn legacy_sequence(code: u8, column: usize, line: usize) -> Option<String> {
    if column > LEGACY_LIMIT || line > LEGACY_LIMIT {
        return None;
    }
    let bytes = [32 + code, 33 + column as u8, 33 + line as u8];
    let mut sequence = String::from("\x1b[M");
    for byte in bytes {
        sequence.push(char::from(byte));
    }
    Some(sequence)
}

/// The arrow keys that scrolling `lines` lines on the alternate screen sends: up for positive.
pub fn wheel_as_arrows(lines: i32, mode: TermMode) -> String {
    let letter = if lines > 0 { 'A' } else { 'B' };
    let sequence =
        if mode.contains(TermMode::APP_CURSOR) { format!("\x1bO{letter}") } else { format!("\x1b[{letter}") };
    sequence.repeat(lines.unsigned_abs() as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: ReportedModifiers = ReportedModifiers { shift: false, alt: false, control: false };

    fn sgr_mode() -> TermMode {
        TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE
    }

    #[test]
    fn nothing_is_sent_until_the_program_asks() {
        let sequence = encode_mouse(ReportedButton::Left, ReportedAction::Press, NONE, 3, 4, TermMode::NONE);
        assert_eq!(sequence, None);
    }

    #[test]
    fn sgr_press_and_release_count_from_one() {
        let press = encode_mouse(ReportedButton::Left, ReportedAction::Press, NONE, 0, 0, sgr_mode());
        assert_eq!(press.as_deref(), Some("\x1b[<0;1;1M"));
        let release = encode_mouse(ReportedButton::Right, ReportedAction::Release, NONE, 9, 4, sgr_mode());
        assert_eq!(release.as_deref(), Some("\x1b[<2;10;5m"));
    }

    #[test]
    fn modifiers_and_the_wheel_add_their_bits() {
        let modifiers = ReportedModifiers { shift: true, alt: false, control: true };
        let press = encode_mouse(ReportedButton::Left, ReportedAction::Press, modifiers, 1, 1, sgr_mode());
        assert_eq!(press.as_deref(), Some("\x1b[<20;2;2M"));
        let wheel = encode_mouse(ReportedButton::WheelDown, ReportedAction::Press, NONE, 1, 1, sgr_mode());
        assert_eq!(wheel.as_deref(), Some("\x1b[<65;2;2M"));
    }

    #[test]
    fn motion_needs_the_drag_or_motion_mode() {
        let motion = encode_mouse(ReportedButton::Left, ReportedAction::Motion, NONE, 2, 2, sgr_mode());
        assert_eq!(motion, None);
        let drag_mode = TermMode::MOUSE_DRAG | TermMode::SGR_MOUSE;
        let motion = encode_mouse(ReportedButton::Left, ReportedAction::Motion, NONE, 2, 2, drag_mode);
        assert_eq!(motion.as_deref(), Some("\x1b[<32;3;3M"));
        let hover = encode_mouse(ReportedButton::None, ReportedAction::Motion, NONE, 2, 2, drag_mode);
        assert_eq!(hover, None);
    }

    #[test]
    fn the_legacy_form_offsets_bytes_and_reports_release_as_three() {
        let mode = TermMode::MOUSE_REPORT_CLICK;
        let press = encode_mouse(ReportedButton::Left, ReportedAction::Press, NONE, 0, 0, mode);
        assert_eq!(press.as_deref(), Some("\x1b[M !!"));
        let release = encode_mouse(ReportedButton::Left, ReportedAction::Release, NONE, 0, 0, mode);
        assert_eq!(release.as_deref(), Some("\x1b[M#!!"));
        let too_far = encode_mouse(ReportedButton::Left, ReportedAction::Press, NONE, 300, 0, mode);
        assert_eq!(too_far, None);
    }

    #[test]
    fn the_wheel_on_the_alternate_screen_sends_arrows() {
        assert_eq!(wheel_as_arrows(2, TermMode::NONE), "\x1b[A\x1b[A");
        assert_eq!(wheel_as_arrows(-1, TermMode::APP_CURSOR), "\x1bOB");
    }
}
