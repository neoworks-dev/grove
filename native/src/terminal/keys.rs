//! Keys to the bytes a terminal program expects, as xterm sends them. Text that needs no
//! translation (letters, digits, symbols) is not handled here: the view writes the keystroke's own
//! character. What this module covers is everything a terminal gives a meaning of its own: named
//! keys such as arrows and function keys, Control letters, and Alt as a prefix.

use alacritty_terminal::term::TermMode;
use svelte_gpui::gpui::Keystroke;

/// The escape character that starts a control sequence.
const ESCAPE: &str = "\x1b";

/// The bytes to write for a keystroke, or none when it is plain text the view writes as typed.
pub fn encode_key(keystroke: &Keystroke, mode: TermMode) -> Option<String> {
    let modifiers = &keystroke.modifiers;
    if modifiers.platform {
        return None;
    }
    let code = modifier_code(keystroke);
    if let Some(sequence) = encode_named_key(&keystroke.key, keystroke, mode, code) {
        return Some(sequence);
    }
    let mut characters = keystroke.key.chars();
    let (Some(character), None) = (characters.next(), characters.next()) else {
        return None;
    };
    if modifiers.control {
        return encode_control(character, modifiers.alt);
    }
    if modifiers.alt {
        return Some(format!("{ESCAPE}{}", typed_text(keystroke, character)));
    }
    None
}

/// What the key types: its character with Shift applied, or the key itself.
fn typed_text(keystroke: &Keystroke, key: char) -> String {
    match &keystroke.key_char {
        Some(text) => text.clone(),
        None => key.to_string(),
    }
}

/// xterm's modifier parameter: 1 for none, plus 1 for Shift, 2 for Alt and 4 for Control.
fn modifier_code(keystroke: &Keystroke) -> u8 {
    let modifiers = &keystroke.modifiers;
    let mut code = 1;
    if modifiers.shift {
        code += 1;
    }
    if modifiers.alt {
        code += 2;
    }
    if modifiers.control {
        code += 4;
    }
    code
}

/// The sequence for a key that has a name, or none for one that does not.
fn encode_named_key(name: &str, keystroke: &Keystroke, mode: TermMode, code: u8) -> Option<String> {
    let modifiers = &keystroke.modifiers;
    match name {
        "enter" => Some(with_alt_prefix("\r", modifiers.alt)),
        "escape" => Some(with_alt_prefix(ESCAPE, modifiers.alt)),
        "tab" => Some(encode_tab(modifiers.shift, modifiers.alt)),
        "backspace" => Some(encode_backspace(modifiers.control, modifiers.alt)),
        "space" => Some(encode_space(modifiers.control, modifiers.alt)),
        "up" => Some(cursor_key('A', mode, code)),
        "down" => Some(cursor_key('B', mode, code)),
        "right" => Some(cursor_key('C', mode, code)),
        "left" => Some(cursor_key('D', mode, code)),
        "home" => Some(cursor_key('H', mode, code)),
        "end" => Some(cursor_key('F', mode, code)),
        "insert" => Some(tilde_key(2, code)),
        "delete" => Some(tilde_key(3, code)),
        "pageup" => Some(tilde_key(5, code)),
        "pagedown" => Some(tilde_key(6, code)),
        _ => encode_function_key(name, code),
    }
}

/// A sequence with Escape in front when Alt is held.
fn with_alt_prefix(sequence: &str, alt: bool) -> String {
    if alt {
        return format!("{ESCAPE}{sequence}");
    }
    sequence.to_string()
}

/// Tab, back-tab with Shift, and Alt as a prefix.
fn encode_tab(shift: bool, alt: bool) -> String {
    if shift {
        return format!("{ESCAPE}[Z");
    }
    with_alt_prefix("\t", alt)
}

/// Backspace is DEL, Control-Backspace is BS, and Alt puts Escape in front.
fn encode_backspace(control: bool, alt: bool) -> String {
    if control {
        return "\x08".to_string();
    }
    with_alt_prefix("\x7f", alt)
}

/// Space is a space, Control-Space is NUL, and Alt puts Escape in front.
fn encode_space(control: bool, alt: bool) -> String {
    if control {
        return "\0".to_string();
    }
    with_alt_prefix(" ", alt)
}

/// An arrow, Home or End: `ESC [ X`, `ESC O X` while the program asked for application cursor
/// keys, and `ESC [ 1 ; m X` with modifiers.
fn cursor_key(letter: char, mode: TermMode, code: u8) -> String {
    if code > 1 {
        return format!("{ESCAPE}[1;{code}{letter}");
    }
    if mode.contains(TermMode::APP_CURSOR) {
        return format!("{ESCAPE}O{letter}");
    }
    format!("{ESCAPE}[{letter}")
}

/// A key written as `ESC [ n ~`, with the modifier after a semicolon when there is one.
fn tilde_key(number: u8, code: u8) -> String {
    if code > 1 {
        return format!("{ESCAPE}[{number};{code}~");
    }
    format!("{ESCAPE}[{number}~")
}

/// F1 to F20: the first four are `ESC O P` to `ESC O S`, the rest are numbered tilde keys.
fn encode_function_key(name: &str, code: u8) -> Option<String> {
    let number: u8 = name.strip_prefix('f')?.parse().ok()?;
    if (1..=4).contains(&number) {
        let letter = ['P', 'Q', 'R', 'S'][usize::from(number) - 1];
        if code > 1 {
            return Some(format!("{ESCAPE}[1;{code}{letter}"));
        }
        return Some(format!("{ESCAPE}O{letter}"));
    }
    let tilde_number = match number {
        5 => 15,
        6 => 17,
        7 => 18,
        8 => 19,
        9 => 20,
        10 => 21,
        11 => 23,
        12 => 24,
        13 => 25,
        14 => 26,
        15 => 28,
        16 => 29,
        17 => 31,
        18 => 32,
        19 => 33,
        20 => 34,
        _ => return None,
    };
    Some(tilde_key(tilde_number, code))
}

/// A Control chord as the C0 character it stands for, with Escape in front for Alt. Chords that
/// have no such character are not sent.
fn encode_control(key: char, alt: bool) -> Option<String> {
    let byte = control_byte(key)?;
    let character = char::from(byte);
    if alt {
        return Some(format!("{ESCAPE}{character}"));
    }
    Some(character.to_string())
}

/// The control character for Control plus a key, following xterm: letters give 1 to 26, and a
/// few symbols and digits give the rest of the C0 range.
fn control_byte(key: char) -> Option<u8> {
    match key.to_ascii_lowercase() {
        letter @ 'a'..='z' => Some(letter as u8 - b'a' + 1),
        '@' | '2' | ' ' => Some(0x00),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '/' | '7' | '-' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keystroke(text: &str) -> Keystroke {
        Keystroke::parse(text).expect("a keystroke")
    }

    fn encode(text: &str) -> Option<String> {
        encode_key(&keystroke(text), TermMode::NONE)
    }

    #[test]
    fn plain_text_is_left_to_the_view() {
        assert_eq!(encode("a"), None);
        assert_eq!(encode("shift-a"), None);
        assert_eq!(encode("4"), None);
    }

    #[test]
    fn named_keys_send_their_sequences() {
        assert_eq!(encode("enter").as_deref(), Some("\r"));
        assert_eq!(encode("escape").as_deref(), Some("\x1b"));
        assert_eq!(encode("tab").as_deref(), Some("\t"));
        assert_eq!(encode("shift-tab").as_deref(), Some("\x1b[Z"));
        assert_eq!(encode("backspace").as_deref(), Some("\x7f"));
        assert_eq!(encode("delete").as_deref(), Some("\x1b[3~"));
        assert_eq!(encode("pageup").as_deref(), Some("\x1b[5~"));
        assert_eq!(encode("pagedown").as_deref(), Some("\x1b[6~"));
        assert_eq!(encode("space").as_deref(), Some(" "));
    }

    #[test]
    fn arrows_follow_the_cursor_key_mode() {
        let up = keystroke("up");
        assert_eq!(encode_key(&up, TermMode::NONE).as_deref(), Some("\x1b[A"));
        assert_eq!(encode_key(&up, TermMode::APP_CURSOR).as_deref(), Some("\x1bOA"));
        assert_eq!(encode_key(&keystroke("home"), TermMode::APP_CURSOR).as_deref(), Some("\x1bOH"));
        assert_eq!(encode_key(&keystroke("end"), TermMode::NONE).as_deref(), Some("\x1b[F"));
    }

    #[test]
    fn modifiers_on_cursor_keys_use_the_numbered_form_in_either_mode() {
        let shift_up = keystroke("shift-up");
        assert_eq!(encode_key(&shift_up, TermMode::APP_CURSOR).as_deref(), Some("\x1b[1;2A"));
        assert_eq!(encode("ctrl-left").as_deref(), Some("\x1b[1;5D"));
        assert_eq!(encode("alt-right").as_deref(), Some("\x1b[1;3C"));
        assert_eq!(encode("ctrl-shift-delete").as_deref(), Some("\x1b[3;6~"));
    }

    #[test]
    fn function_keys() {
        assert_eq!(encode("f1").as_deref(), Some("\x1bOP"));
        assert_eq!(encode("f4").as_deref(), Some("\x1bOS"));
        assert_eq!(encode("f5").as_deref(), Some("\x1b[15~"));
        assert_eq!(encode("f12").as_deref(), Some("\x1b[24~"));
        assert_eq!(encode("shift-f5").as_deref(), Some("\x1b[15;2~"));
        assert_eq!(encode("ctrl-f1").as_deref(), Some("\x1b[1;5P"));
        assert_eq!(encode("f21"), None);
    }

    #[test]
    fn control_letters_become_c0_characters() {
        assert_eq!(encode("ctrl-a").as_deref(), Some("\x01"));
        assert_eq!(encode("ctrl-c").as_deref(), Some("\x03"));
        assert_eq!(encode("ctrl-z").as_deref(), Some("\x1a"));
        assert_eq!(encode("ctrl-shift-a").as_deref(), Some("\x01"));
        assert_eq!(encode("ctrl-[").as_deref(), Some("\x1b"));
        assert_eq!(encode("ctrl-\\").as_deref(), Some("\x1c"));
        assert_eq!(encode("ctrl-space").as_deref(), Some("\0"));
        assert_eq!(encode("ctrl-backspace").as_deref(), Some("\x08"));
        assert_eq!(encode("ctrl-1"), None);
    }

    #[test]
    fn alt_puts_escape_in_front() {
        assert_eq!(encode("alt-b").as_deref(), Some("\x1bb"));
        let mut shifted = keystroke("alt-shift-b");
        shifted.key_char = Some("B".to_string());
        assert_eq!(encode_key(&shifted, TermMode::NONE).as_deref(), Some("\x1bB"));
        assert_eq!(encode("alt-enter").as_deref(), Some("\x1b\r"));
        assert_eq!(encode("alt-backspace").as_deref(), Some("\x1b\x7f"));
        assert_eq!(encode("ctrl-alt-a").as_deref(), Some("\x1b\x01"));
    }

    #[test]
    fn the_platform_key_is_never_sent() {
        assert_eq!(encode("cmd-c"), None);
    }
}
