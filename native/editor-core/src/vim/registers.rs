//! What vim remembers between commands: the registers that yanks and deletes fill, and the last
//! search. It lives with the documents rather than with one of them, so a yank in one file
//! can be put in another.

use std::collections::HashMap;

/// The text a register holds: one piece per cursor that took part, and whether the pieces are
/// whole lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Register {
    pub texts: Vec<String>,
    pub linewise: bool,
    /// Whether the pieces were the lines of a visual block, which are put back as a block.
    pub blockwise: bool,
}

impl Register {
    /// A register of one piece of text.
    pub fn single(text: impl Into<String>, linewise: bool) -> Self {
        Register { texts: vec![text.into()], linewise, blockwise: false }
    }

    /// Every piece, one to a line.
    pub fn joined(&self) -> String {
        self.texts.join("\n")
    }

    /// What goes on the system clipboard: the pieces one to a line, with a line break after
    /// whole lines so pasting them elsewhere puts them on their own lines.
    pub fn clipboard_text(&self) -> String {
        if self.linewise {
            return format!("{}\n", self.joined());
        }
        self.joined()
    }
}

/// The last search, for `n` and `N`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastSearch {
    pub pattern: String,
    pub forward: bool,
    /// Whether the pattern only matches as a whole word, as `*` makes it.
    pub whole_word: bool,
}

/// Registers and the last search.
#[derive(Clone, Debug, Default)]
pub struct VimMemory {
    registers: HashMap<char, Register>,
    pub last_search: Option<LastSearch>,
    /// Whether the matches of the last search are marked in the text, until `:noh`.
    pub search_highlight: bool,
}

impl VimMemory {
    /// The register a name refers to: the unnamed one for none, or for `"`. The black hole
    /// register is always empty, and an upper case name reads the lower case register.
    pub fn read(&self, name: Option<char>) -> Option<&Register> {
        let name = name.unwrap_or('"');
        if name == '_' {
            return None;
        }
        self.registers.get(&name.to_ascii_lowercase())
    }

    /// Stores what a yank or a delete took. It always becomes the unnamed register, goes to
    /// the named one when there is one (an upper case name appends to the lower case one),
    /// and otherwise to register 0 for a yank, or to the numbered registers, or the small
    /// delete register, for a delete.
    pub fn record(&mut self, name: Option<char>, register: Register, is_yank: bool) {
        if name == Some('_') {
            return;
        }
        let mut stored = register.clone();
        if let Some(name) = name.filter(char::is_ascii_uppercase) {
            let lower = name.to_ascii_lowercase();
            stored = append(self.registers.get(&lower), &register);
            self.registers.insert(lower, stored.clone());
        } else if let Some(name) = name {
            self.registers.insert(name, register.clone());
        } else if is_yank {
            self.registers.insert('0', register.clone());
        } else {
            self.record_delete(&register);
        }
        self.registers.insert('"', stored);
    }

    /// Puts a delete in register 1 and shifts the older ones along when it is whole lines or
    /// spans lines, and in the small delete register otherwise.
    fn record_delete(&mut self, register: &Register) {
        let spans_lines = register.linewise || register.texts.iter().any(|text| text.contains('\n'));
        if !spans_lines {
            self.registers.insert('-', register.clone());
            return;
        }
        for digit in (1..9).rev() {
            let older = char::from_digit(digit, 10).unwrap_or('1');
            let newer = char::from_digit(digit + 1, 10).unwrap_or('9');
            if let Some(held) = self.registers.get(&older).cloned() {
                self.registers.insert(newer, held);
            }
        }
        self.registers.insert('1', register.clone());
    }
}

/// What appending to a register leaves in it: the old pieces with the new text added to each.
fn append(existing: Option<&Register>, addition: &Register) -> Register {
    let Some(existing) = existing else {
        return addition.clone();
    };
    let linewise = existing.linewise || addition.linewise;
    let separator = if linewise { "\n" } else { "" };
    let text = format!("{}{separator}{}", existing.joined(), addition.joined());
    Register { texts: vec![text], linewise, blockwise: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_yank_fills_the_unnamed_register_and_register_zero() {
        let mut memory = VimMemory::default();
        memory.record(None, Register::single("one", false), true);
        memory.record(None, Register::single("two", false), false);
        assert_eq!(memory.read(None), Some(&Register::single("two", false)));
        assert_eq!(memory.read(Some('0')), Some(&Register::single("one", false)));
        assert_eq!(memory.read(Some('-')), Some(&Register::single("two", false)));
    }

    #[test]
    fn named_registers_append_when_upper_case() {
        let mut memory = VimMemory::default();
        memory.record(Some('a'), Register::single("one", false), true);
        memory.record(Some('A'), Register::single("two", false), true);
        assert_eq!(memory.read(Some('a')), Some(&Register::single("onetwo", false)));
        assert_eq!(memory.read(None), Some(&Register::single("onetwo", false)));
    }

    #[test]
    fn line_deletes_shift_through_the_numbered_registers() {
        let mut memory = VimMemory::default();
        memory.record(None, Register::single("a", true), false);
        memory.record(None, Register::single("b", true), false);
        assert_eq!(memory.read(Some('1')), Some(&Register::single("b", true)));
        assert_eq!(memory.read(Some('2')), Some(&Register::single("a", true)));
    }

    #[test]
    fn the_black_hole_keeps_nothing() {
        let mut memory = VimMemory::default();
        memory.record(Some('_'), Register::single("gone", false), false);
        assert_eq!(memory.read(None), None);
        assert_eq!(memory.read(Some('_')), None);
    }
}
