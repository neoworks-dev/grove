//! Undo and redo. Every command that edits is one transaction, and typed characters that
//! belong together join one, so undo takes back a word at a time rather than a letter.
//!
//! A transaction is a list of steps, each the edits that were applied and the edits that undo
//! them, plus the selections from before and after, so undo puts the cursors back where they
//! were as well as the text. Keeping steps rather than merging their edits is what lets typing
//! join a transaction without working out how two sets of edits compose.
//!
//! # When typed text joins the previous transaction
//!
//! Typed text starts a new transaction unless all of these hold:
//!
//! - the previous change was typed text too, with no other command since, so moving the
//!   cursor, deleting, pressing Enter and undoing all end a group;
//! - no more than [`COALESCE_PAUSE`] has passed since that text was typed;
//! - the new text is made of one kind of character, word characters, whitespace or
//!   punctuation, and it is the kind the previous text ended with.
//!
//! So typing `foo bar();` undoes as `foo`, ` `, `bar`, `();` in four steps. Typing over a
//! selection is never joined onto what came before. Everything an input method composes, from
//! the first marked character to the committed text, is one transaction.

use std::time::{Duration, Instant};

use crate::edit::Edits;
use crate::selections::Selections;

/// How long a pause in typing ends a group.
pub const COALESCE_PAUSE: Duration = Duration::from_secs(1);

/// The edits of one change, and the edits that undo it.
#[derive(Clone, Debug)]
pub struct Step {
    pub edits: Edits,
    pub inverse: Edits,
}

/// What undo and redo move over as one unit.
#[derive(Clone, Debug)]
pub struct Transaction {
    pub steps: Vec<Step>,
    pub selections_before: Selections,
    pub selections_after: Selections,
    /// The revisions of the text before the transaction and after it, which tell whether the
    /// text is what was last saved.
    pub revision_before: u64,
    pub revision_after: u64,
}

/// What kind of change was made, as far as grouping goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind<'a> {
    /// Text typed at cursors, which may join the typing before it.
    Typing(&'a str),
    /// A change made by an input method while it composes text, which all belongs to one
    /// transaction from the first composed character to the last.
    Composing,
    /// Anything else, which is a transaction of its own.
    Other,
}

/// The kinds of character typing is grouped by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CharacterClass {
    Word,
    Whitespace,
    Punctuation,
}

fn class_of(character: char) -> CharacterClass {
    if character.is_alphanumeric() || character == '_' {
        return CharacterClass::Word;
    }
    if character.is_whitespace() {
        return CharacterClass::Whitespace;
    }
    CharacterClass::Punctuation
}

/// The one class every character of some text belongs to, or none when they differ.
fn single_class(text: &str) -> Option<CharacterClass> {
    let mut characters = text.chars();
    let class = class_of(characters.next()?);
    characters.all(|character| class_of(character) == class).then_some(class)
}

/// The last transaction, while more changes of its kind may still join it.
#[derive(Clone, Copy, Debug)]
enum OpenGroup {
    Typing { last_typed_at: Instant, last_class: CharacterClass },
    Composition,
}

#[derive(Default)]
pub struct History {
    undo: Vec<Transaction>,
    redo: Vec<Transaction>,
    open_group: Option<OpenGroup>,
    /// Set while an undo group is open: whether its first change is recorded yet, after which
    /// every change joins that transaction.
    held: Option<bool>,
}

impl History {
    /// Records a change that was just applied, as a transaction of one step. Typing joins the
    /// open group when the rules in the module's documentation allow it; otherwise the change
    /// is a transaction of its own. Either way, what could be redone is gone.
    pub fn record(&mut self, transaction: Transaction, kind: EditKind, now: Instant) {
        self.redo.clear();
        let Some(transaction) = self.join_held_group(transaction) else {
            return;
        };
        let Some(transaction) = self.join_open_group(transaction, kind, now) else {
            return;
        };
        self.undo.push(transaction);
        self.open_group = open_group_for(kind, now);
    }

    /// Opens an undo group: from the next change until `release`, every change is one
    /// transaction, whatever its kind. Vim's insert mode and its operators use it, so
    /// `cwfoo<Esc>` undoes in one step.
    pub fn hold(&mut self) {
        self.held = Some(false);
        self.open_group = None;
    }

    /// Closes the undo group.
    pub fn release(&mut self) {
        self.held = None;
        self.open_group = None;
    }

    /// Adds the change to the held group's transaction once that has begun. Otherwise this
    /// change begins it, and comes back to be recorded.
    fn join_held_group(&mut self, transaction: Transaction) -> Option<Transaction> {
        let Some(begun) = self.held else {
            return Some(transaction);
        };
        if !begun {
            self.held = Some(true);
            return Some(transaction);
        }
        let Some(last) = self.undo.last_mut() else {
            return Some(transaction);
        };
        last.steps.extend(transaction.steps);
        last.selections_after = transaction.selections_after;
        last.revision_after = transaction.revision_after;
        None
    }

    /// Adds the change to the last transaction when it may join it. When it may not, the
    /// change comes back.
    fn join_open_group(&mut self, transaction: Transaction, kind: EditKind, now: Instant) -> Option<Transaction> {
        let Some(group) = self.open_group else {
            return Some(transaction);
        };
        let typed_class = match (kind, group) {
            (EditKind::Composing, OpenGroup::Composition) => None,
            (EditKind::Typing(text), OpenGroup::Typing { last_typed_at, last_class }) => {
                let Some(class) = single_class(text) else {
                    return Some(transaction);
                };
                let pause = now.duration_since(last_typed_at);
                if class != last_class || pause > COALESCE_PAUSE {
                    return Some(transaction);
                }
                Some(class)
            }
            _ => return Some(transaction),
        };
        let Some(last) = self.undo.last_mut() else {
            return Some(transaction);
        };
        last.steps.extend(transaction.steps);
        last.selections_after = transaction.selections_after;
        last.revision_after = transaction.revision_after;
        if let Some(last_class) = typed_class {
            self.open_group = Some(OpenGroup::Typing { last_typed_at: now, last_class });
        }
        None
    }

    /// Ends the open group, so the next typing starts a new transaction.
    pub fn close_group(&mut self) {
        self.open_group = None;
    }

    /// Takes the transaction to undo off the history. It is not on the redo stack until `push_redo`.
    pub fn take_undo(&mut self) -> Option<Transaction> {
        self.open_group = None;
        self.held = None;
        self.undo.pop()
    }

    /// Takes the transaction to redo off the history.
    pub fn take_redo(&mut self) -> Option<Transaction> {
        self.open_group = None;
        self.held = None;
        self.redo.pop()
    }

    /// Puts an undone transaction where redo finds it.
    pub fn push_redo(&mut self, transaction: Transaction) {
        self.redo.push(transaction);
    }

    /// Puts a redone transaction back where undo finds it, without clearing what can still be redone.
    pub fn push_undo(&mut self, transaction: Transaction) {
        self.undo.push(transaction);
    }

    /// How many transactions undo would go back through.
    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }
}

/// The group a change opens: typing can be joined by more of the same kind of character, and
/// a composition by the rest of it.
fn open_group_for(kind: EditKind, now: Instant) -> Option<OpenGroup> {
    match kind {
        EditKind::Typing(text) => {
            let last_class = class_of(text.chars().last()?);
            Some(OpenGroup::Typing { last_typed_at: now, last_class })
        }
        EditKind::Composing => Some(OpenGroup::Composition),
        EditKind::Other => None,
    }
}
