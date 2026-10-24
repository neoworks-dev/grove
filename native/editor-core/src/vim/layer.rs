//! The vim input layer: modes, counts, registers' names, dot repeat and the command line, as a
//! state machine over key presses. It never looks at the text. Everything that depends on the
//! text is left to the commands it makes, which the editor state carries out at every cursor.

use std::collections::HashMap;

use crate::buffer::Position;
use crate::command::Command;
use crate::keymap::{
    CursorShape, InputContext, InputLayer, InputStatus, KeyInput, Modifiers, SelectionStyle, standard_command,
};
use crate::movement::Motion;
use crate::vim::ex::parse_ex;
use crate::vim::parse::{
    Action, InsertAt, MotionSpec, PageStep, Parse, Parsed, ScreenRow, Simple, TargetSpec, parse, typed_character,
};
use crate::vim::types::{AppRequest, BlockExit, Operator, SearchRequest, SelectionKind, Target};

/// Which mode the layer is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Normal,
    Insert,
    /// `R`: typed characters replace the ones they land on.
    Replace,
    Visual(SelectionKind),
}

/// The line being typed after `:`, `/` or `?`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CommandLine {
    prefix: char,
    text: String,
    /// The count typed before `/`, which says how many matches to go on.
    count: usize,
    /// An operator that was waiting for the search to say what it covers.
    operator: Option<(Operator, Option<char>)>,
}

/// The last `f`, `t`, `F` or `T`, for `;` and `,`.
#[derive(Clone, Copy, Debug)]
struct LastFind {
    character: char,
    forward: bool,
    till: bool,
}

/// A change that `.` can do again: the keys that made it, which include everything typed in
/// insert mode until Escape.
#[derive(Clone, Debug)]
struct Change {
    register: Option<char>,
    count: Option<usize>,
    keys: Vec<KeyInput>,
    /// The kind of visual selection the keys were typed over, when there was one: `.` then selects
    /// as much text from the cursor first.
    visual: Option<SelectionKind>,
}

/// What typing in insert mode has done, for a count to do again when the mode ends.
#[derive(Clone, Debug, Default)]
struct InsertSession {
    repeat: usize,
    repeated: Vec<Command>,
}

/// Vim's keys: normal, insert, replace and visual modes, counts, operators with motions and
/// text objects, registers, `.`, searching and the ex commands `:w`, `:q`, `:e`, `:s` and a line number.
#[derive(Debug)]
pub struct VimLayer {
    mode: Mode,
    /// The keys of the normal or visual mode command typed so far.
    keys: Vec<String>,
    command_line: Option<CommandLine>,
    last_find: Option<LastFind>,
    last_change: Option<Change>,
    /// The change being typed, which becomes the last one when it is done.
    recording: Option<Change>,
    /// Whether keys are being fed in by `.`, which must not record themselves.
    replaying: bool,
    insert: InsertSession,
    /// Whether the insert mode being typed in was started at every line of a visual block, and
    /// ends on one cursor.
    block_insert: bool,
    /// The kind of the last visual selection that was left, for `gv`.
    last_visual_kind: Option<SelectionKind>,
    /// The keys of each macro recorded, by register name.
    macros: HashMap<char, Vec<KeyInput>>,
    /// The register and keys of the macro being recorded.
    macro_recording: Option<(char, Vec<KeyInput>)>,
    /// The macro `@@` plays again.
    last_macro: Option<char>,
    /// How many macros are being played, one inside another, which is limited.
    macro_depth: usize,
    /// Whether the app has a leader sequence bound, so a bare space in normal mode is left to it.
    leader_key: bool,
}

impl Default for VimLayer {
    fn default() -> Self {
        VimLayer::new()
    }
}

impl VimLayer {
    /// A layer in normal mode with nothing remembered.
    pub fn new() -> Self {
        VimLayer {
            mode: Mode::Normal,
            keys: Vec::new(),
            command_line: None,
            last_find: None,
            last_change: None,
            recording: None,
            replaying: false,
            insert: InsertSession::default(),
            block_insert: false,
            last_visual_kind: None,
            macros: HashMap::new(),
            macro_recording: None,
            last_macro: None,
            macro_depth: 0,
            leader_key: false,
        }
    }
}

/// A key as the parser reads it: the key's name, with `C-` in front when Control is held.
fn token_of(key: &KeyInput) -> String {
    if key.modifiers.control {
        return format!("C-{}", key.key);
    }
    key.key.clone()
}

/// The key a token came from.
fn key_of(token: &str) -> KeyInput {
    match token.strip_prefix("C-") {
        Some(name) => {
            KeyInput { key: name.to_string(), modifiers: Modifiers { control: true, alt: false, shift: false } }
        }
        None => KeyInput { key: token.to_string(), modifiers: Modifiers::default() },
    }
}

/// Whether a key leaves insert mode and cancels what is typed in the command line.
fn is_escape(token: &str) -> bool {
    matches!(token, "escape" | "C-[" | "C-c")
}

/// The most steps one `u` or Ctrl-R goes through, so a mistyped count cannot hang the editor.
const MAX_UNDO_COUNT: usize = 1000;

/// The control keys vim uses in normal and visual mode. Others, such as Ctrl-S, are left to the standard keys.
const CONTROL_KEYS: [&str; 11] = ["C-r", "C-n", "C-d", "C-u", "C-f", "C-b", "C-[", "C-c", "C-o", "C-i", "C-v"];

/// The most macros that may be playing inside one another, so one that plays itself ends.
const MAX_MACRO_DEPTH: usize = 20;

/// The most times a macro is played for one count.
const MAX_MACRO_COUNT: usize = 10_000;

impl InputLayer for VimLayer {
    fn translate(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command> {
        if self.is_end_of_macro(key) {
            self.finish_macro();
            return vec![Command::Noop];
        }
        if !self.replaying && self.macro_depth == 0 {
            if let Some((_, keys)) = self.macro_recording.as_mut() {
                keys.push(key.clone());
            }
        }
        match self.mode {
            Mode::Insert | Mode::Replace => self.insert_key(key, context),
            Mode::Normal | Mode::Visual(_) => {
                if self.command_line.is_some() {
                    return self.command_line_key(key, context);
                }
                self.normal_key(key, context)
            }
        }
    }

    fn set_leader_key(&mut self, enabled: bool) {
        self.leader_key = enabled;
    }

    fn status(&self) -> InputStatus {
        let mode = match self.mode {
            Mode::Normal => "NORMAL",
            Mode::Insert => "INSERT",
            Mode::Replace => "REPLACE",
            Mode::Visual(SelectionKind::Characters) => "VISUAL",
            Mode::Visual(SelectionKind::Lines) => "V-LINE",
            Mode::Visual(SelectionKind::Block) => "V-BLOCK",
        };
        let cursor = match self.mode {
            Mode::Insert => CursorShape::Bar,
            Mode::Replace => CursorShape::Underline,
            _ if !self.keys.is_empty() => CursorShape::Underline,
            _ => CursorShape::Block,
        };
        let selection = match self.mode {
            Mode::Visual(SelectionKind::Characters | SelectionKind::Block) => SelectionStyle::Inclusive,
            Mode::Visual(SelectionKind::Lines) => SelectionStyle::Lines,
            _ => SelectionStyle::Exclusive,
        };
        let command_line = self.command_line.as_ref().map(|line| format!("{}{}", line.prefix, line.text));
        InputStatus { mode, pending: self.keys.concat(), command_line, cursor, selection }
    }
}

impl VimLayer {
    /// A key in normal or visual mode.
    fn normal_key(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command> {
        let token = token_of(key);
        if token == "C-a" && self.keys.is_empty() {
            return vec![Command::Noop];
        }
        if token == "space" && self.leader_key && self.mode == Mode::Normal && self.keys.is_empty() {
            // The leader key: no commands, so the key reaches the app's keymap, which starts a leader
            // sequence. Space still moves right after an operator or a count.
            return Vec::new();
        }
        let ours = !key.modifiers.control || CONTROL_KEYS.contains(&token.as_str());
        let alt_only = key.modifiers.alt && !key.modifiers.control;
        if (!ours || alt_only || key.modifiers.control && key.modifiers.alt) && self.keys.is_empty() {
            return standard_command(key, context).into_iter().collect();
        }
        self.keys.push(token);
        let visual = matches!(self.mode, Mode::Visual(_));
        match parse(&self.keys, visual) {
            Parse::Incomplete => vec![Command::Noop],
            Parse::Invalid => {
                self.keys.clear();
                vec![Command::Noop]
            }
            Parse::Complete(parsed) => {
                self.keys.clear();
                self.execute(parsed, context)
            }
        }
    }

    /// Carries out a command that was read in full.
    fn execute(&mut self, parsed: Parsed, context: &InputContext) -> Vec<Command> {
        self.recording = None;
        let was_visual = self.visual_kind();
        if !self.replaying && is_change(&parsed.action, self.mode) {
            let keys = parsed.keys.iter().map(|token| key_of(token)).collect();
            self.recording = Some(Change { register: parsed.register, count: parsed.count, keys, visual: was_visual });
        }
        let mut commands = match parsed.action.clone() {
            Action::Move(spec) => self.move_commands(spec, &parsed, context),
            Action::Operate { operator, target } => self.operate_with_target(operator, target, &parsed, context),
            Action::Simple(simple) => self.simple_commands(simple, &parsed, context),
        };
        if let (Some(kind), None) = (was_visual, self.visual_kind()) {
            commands.insert(0, Command::RememberVisual { kind });
            self.last_visual_kind = Some(kind);
        }
        let still_typing = matches!(self.mode, Mode::Insert | Mode::Replace) || self.command_line.is_some();
        if !still_typing && !self.replaying {
            if let Some(change) = self.recording.take() {
                self.last_change = Some(change);
            }
        }
        commands
    }

    /// Whether a visual selection is active, as the selection kind.
    fn visual_kind(&self) -> Option<SelectionKind> {
        match self.mode {
            Mode::Visual(kind) => Some(kind),
            _ => None,
        }
    }

    /// What a motion does as a command of its own: moves every cursor, or extends the selections in visual mode.
    fn move_commands(&mut self, spec: MotionSpec, parsed: &Parsed, context: &InputContext) -> Vec<Command> {
        let mut commands = Vec::new();
        if is_jump(spec) {
            commands.push(Command::PushJump);
        }
        let moves = self.motion_commands(spec, parsed, context);
        if self.visual_kind() == Some(SelectionKind::Block) {
            commands.extend(moves.into_iter().map(block_version_of));
            return commands;
        }
        commands.extend(moves);
        commands
    }

    /// The commands of a motion, without the note of where the jump came from.
    fn motion_commands(&mut self, spec: MotionSpec, parsed: &Parsed, context: &InputContext) -> Vec<Command> {
        let extend = self.visual_kind().is_some();
        let count = parsed.count.unwrap_or(1);
        match spec {
            MotionSpec::Mark { name, linewise } => vec![Command::JumpToMark { name, linewise, extend }],
            MotionSpec::SearchRepeat { reverse } => {
                vec![Command::VimSearch { request: SearchRequest::Repeat { reverse }, count, extend }]
            }
            MotionSpec::SearchWord { forward } => {
                vec![Command::VimSearch { request: SearchRequest::Word { forward }, count, extend }]
            }
            MotionSpec::SearchPrompt { forward } => {
                self.open_command_line(if forward { '/' } else { '?' }, "", count, None);
                vec![Command::Noop]
            }
            MotionSpec::Jump => {
                let then = Command::VimMove { motion: Motion::To(Position::default()), count: 1, extend };
                vec![Command::StartJump { then: Box::new(then) }]
            }
            _ => match self.motion_of(spec, parsed.count, context) {
                Some((motion, count)) => vec![Command::VimMove { motion, count, extend }],
                None => vec![Command::Noop],
            },
        }
    }

    /// The motion and count a spec stands for, which for some depends on the count, on the
    /// last `f`, and on what is in view.
    fn motion_of(&mut self, spec: MotionSpec, count: Option<usize>, context: &InputContext) -> Option<(Motion, usize)> {
        let times = count.unwrap_or(1);
        match spec {
            MotionSpec::Fixed(motion) => Some((motion, times)),
            MotionSpec::Find { character, forward, till } => {
                self.last_find = Some(LastFind { character, forward, till });
                Some((Motion::FindChar { character, forward, till, repeat: false }, times))
            }
            MotionSpec::FindRepeat { reverse } => {
                let last = self.last_find?;
                let forward = last.forward != reverse;
                Some((Motion::FindChar { character: last.character, forward, till: last.till, repeat: true }, times))
            }
            MotionSpec::GotoLine => {
                let row = count.map_or(usize::MAX, |line| line.saturating_sub(1));
                Some((Motion::Line(row), 1))
            }
            MotionSpec::GotoFirstLine => Some((Motion::Line(count.map_or(0, |line| line.saturating_sub(1))), 1)),
            MotionSpec::Screen(row) => Some((Motion::Line(screen_row(row, times, context)), 1)),
            _ => None,
        }
    }

    /// An operator and what it acts on. A search target first asks for its pattern.
    fn operate_with_target(
        &mut self,
        operator: Operator,
        target: TargetSpec,
        parsed: &Parsed,
        context: &InputContext,
    ) -> Vec<Command> {
        let count = parsed.count.unwrap_or(1);
        let target = match target {
            TargetSpec::Lines => Target::Lines { count },
            TargetSpec::Object { object, around } => Target::Object { object, around, count },
            TargetSpec::Motion(MotionSpec::SearchPrompt { forward }) => {
                self.open_command_line(if forward { '/' } else { '?' }, "", count, Some((operator, parsed.register)));
                return vec![Command::Noop];
            }
            TargetSpec::Motion(MotionSpec::SearchRepeat { reverse }) => {
                Target::Search { request: SearchRequest::Repeat { reverse }, count }
            }
            TargetSpec::Motion(MotionSpec::SearchWord { forward }) => {
                Target::Search { request: SearchRequest::Word { forward }, count }
            }
            TargetSpec::Motion(MotionSpec::Mark { .. }) => return vec![Command::Noop],
            TargetSpec::Motion(MotionSpec::Jump) => return self.operate_after_jump(operator, parsed.register),
            TargetSpec::Motion(spec) => match self.motion_of(spec, parsed.count, context) {
                Some((motion, count)) => Target::Motion { motion, count },
                None => return vec![Command::Noop],
            },
        };
        self.operator_commands(operator, target, parsed.register)
    }

    /// An operator that waits for jump labels to say what it covers: the text between the cursor
    /// and the label that is typed. A change is left out, since leaving the labels would leave
    /// insert mode half started.
    fn operate_after_jump(&mut self, operator: Operator, register: Option<char>) -> Vec<Command> {
        if operator == Operator::Change {
            return vec![Command::Noop];
        }
        self.mode = Mode::Normal;
        let target = Target::Motion { motion: Motion::To(Position::default()), count: 1 };
        let then = Command::Operate { operator, target, register };
        vec![Command::StartJump { then: Box::new(then) }]
    }

    /// The commands for an operator, which for a change also start insert mode inside an undo group.
    fn operator_commands(&mut self, operator: Operator, target: Target, register: Option<char>) -> Vec<Command> {
        let in_block = matches!(target, Target::Selection { kind: SelectionKind::Block });
        if operator != Operator::Change {
            self.mode = Mode::Normal;
            let mut commands = vec![Command::Operate { operator, target, register }];
            if in_block {
                commands.push(Command::BlockEnd { exit: BlockExit::TopLeft });
            }
            return commands;
        }
        self.start_insert(1, Vec::new());
        self.block_insert = in_block;
        let mut commands = vec![Command::GroupUndo { open: true }, Command::Operate { operator, target, register }];
        if in_block {
            commands.push(Command::BlockEnd { exit: BlockExit::Keep });
        }
        commands
    }

    /// Enters insert mode, to do again `repeat` times what is typed.
    fn start_insert(&mut self, repeat: usize, repeated: Vec<Command>) {
        self.mode = Mode::Insert;
        self.insert = InsertSession { repeat, repeated };
    }

    /// The commands for the commands that are not motions or operators.
    fn simple_commands(&mut self, simple: Simple, parsed: &Parsed, context: &InputContext) -> Vec<Command> {
        let count = parsed.count.unwrap_or(1);
        let register = parsed.register;
        if let Some(kind) = self.visual_kind() {
            if let Some(commands) = self.visual_commands(&simple, kind, parsed) {
                return commands;
            }
        }
        match simple {
            Simple::ShortOperator { operator, motion, lines } => {
                let target = match motion {
                    Some(motion) if !lines => Target::Motion { motion, count },
                    _ => Target::Lines { count },
                };
                self.operator_commands(operator, target, register)
            }
            Simple::Join => vec![Command::JoinLines { count, from_selection: false }],
            Simple::Put { before, cursor_after } => {
                vec![Command::Put { register, before, count, cursor_after, over: None, clipboard: None }]
            }
            Simple::Undo => repeat_commands(count.min(MAX_UNDO_COUNT), vec![Command::Undo, Command::ClampCursors]),
            Simple::Redo => repeat_commands(count.min(MAX_UNDO_COUNT), vec![Command::Redo, Command::ClampCursors]),
            Simple::Repeat => self.repeat_last_change(parsed.count, context),
            Simple::Insert(at) => self.insert_commands(at, count),
            Simple::ReplaceMode => {
                self.mode = Mode::Replace;
                self.insert = InsertSession { repeat: 1, repeated: Vec::new() };
                vec![Command::GroupUndo { open: true }]
            }
            Simple::ReplaceChar(character) => vec![Command::ReplaceChars { character, count, over: None }],
            Simple::ToggleCaseChar => vec![
                Command::Operate {
                    operator: Operator::ToggleCase,
                    target: Target::Motion { motion: Motion::ColumnRight, count },
                    register: None,
                },
                Command::VimMove { motion: Motion::ColumnRight, count, extend: false },
            ],
            Simple::Visual(kind) => {
                self.mode = Mode::Visual(kind);
                if kind == SelectionKind::Block {
                    return vec![Command::BlockStart];
                }
                vec![Command::Noop]
            }
            Simple::ExCommandLine => {
                self.open_command_line(':', "", count, None);
                vec![Command::Noop]
            }
            Simple::SetMark(name) => vec![Command::SetMark { name }],
            Simple::Scroll(align) => vec![Command::ScrollTo { align }],
            Simple::SaveAndClose => {
                vec![Command::Save, Command::Request { request: AppRequest::CloseTab { discard: false } }]
            }
            Simple::CloseWithoutSaving => vec![Command::Request { request: AppRequest::CloseTab { discard: true } }],
            Simple::GotoChange { forward } => vec![Command::Request { request: AppRequest::GotoChange { forward } }],
            Simple::Page(step) => self.page_commands(step, context),
            Simple::ReselectVisual => match self.last_visual_kind {
                Some(kind) => {
                    self.mode = Mode::Visual(kind);
                    vec![Command::ReselectVisual]
                }
                None => vec![Command::Noop],
            },
            Simple::JumpOlder => vec![Command::JumpOlder { count }],
            Simple::JumpNewer => vec![Command::JumpNewer { count }],
            Simple::MacroRecord(name) => {
                self.macro_recording = Some((name, Vec::new()));
                vec![Command::Noop]
            }
            Simple::MacroPlay(name) => self.play_macro(name, count, context),
            Simple::NextMatch => {
                self.mode = Mode::Visual(SelectionKind::Characters);
                vec![Command::SelectNextMatch { add: false }]
            }
            Simple::Escape => vec![Command::CollapseSelections, Command::ClearSearchHighlight],
            _ => vec![Command::Noop],
        }
    }

    /// The commands for visual mode's version of a command, or none when it works as in normal mode.
    fn visual_commands(&mut self, simple: &Simple, kind: SelectionKind, parsed: &Parsed) -> Option<Vec<Command>> {
        let count = parsed.count.unwrap_or(1);
        let register = parsed.register;
        let commands = match simple {
            Simple::VisualOperator(operator) => {
                return Some(self.operator_commands(*operator, Target::Selection { kind }, register));
            }
            Simple::VisualLinesOperator(operator) => {
                let target = Target::Selection { kind: SelectionKind::Lines };
                let mut commands = self.operator_commands(*operator, target, register);
                if kind == SelectionKind::Block {
                    let exit = if *operator == Operator::Change { BlockExit::Keep } else { BlockExit::TopLeft };
                    commands.push(Command::BlockEnd { exit });
                }
                return Some(commands);
            }
            Simple::VisualSwapEnds if kind == SelectionKind::Block => vec![Command::BlockSwap],
            Simple::VisualSwapEnds => vec![Command::SwapSelectionEnds],
            Simple::VisualObject { object, around } => {
                if matches!(object, crate::vim::types::TextObject::Paragraph) {
                    self.mode = Mode::Visual(SelectionKind::Lines);
                }
                vec![Command::SelectObject { object: *object, around: *around, count }]
            }
            Simple::Visual(other) if *other != kind => {
                self.mode = Mode::Visual(*other);
                match (kind, *other) {
                    (SelectionKind::Block, _) => vec![Command::BlockEnd { exit: BlockExit::Range }],
                    (_, SelectionKind::Block) => vec![Command::BlockStart],
                    _ => vec![Command::Noop],
                }
            }
            Simple::Visual(_) | Simple::Escape => {
                self.mode = Mode::Normal;
                if kind == SelectionKind::Block {
                    return Some(vec![Command::BlockEnd { exit: BlockExit::Head }]);
                }
                vec![Command::CollapseToHeads]
            }
            Simple::Insert(InsertAt::FirstNonBlank | InsertAt::LineEnd) if kind == SelectionKind::Block => {
                let append = matches!(simple, Simple::Insert(InsertAt::LineEnd));
                self.start_insert(1, Vec::new());
                self.block_insert = true;
                vec![Command::GroupUndo { open: true }, Command::BlockInsert { append }]
            }
            Simple::Put { before, cursor_after } => {
                self.mode = Mode::Normal;
                let mut commands = vec![Command::Put {
                    register,
                    before: *before,
                    count,
                    cursor_after: *cursor_after,
                    over: Some(kind),
                    clipboard: None,
                }];
                end_block_after(kind, &mut commands);
                commands
            }
            Simple::Join => {
                self.mode = Mode::Normal;
                let mut commands = vec![Command::JoinLines { count, from_selection: true }];
                end_block_after(kind, &mut commands);
                commands
            }
            Simple::ReplaceChar(character) => {
                self.mode = Mode::Normal;
                let mut commands = vec![Command::ReplaceChars { character: *character, count, over: Some(kind) }];
                end_block_after(kind, &mut commands);
                commands
            }
            Simple::ExCommandLine => {
                self.open_command_line(':', "'<,'>", count, None);
                vec![Command::Noop]
            }
            Simple::NextMatch => vec![Command::SelectNextMatch { add: true }],
            _ => return None,
        };
        Some(commands)
    }

    /// The commands that start insert mode somewhere.
    fn insert_commands(&mut self, at: InsertAt, count: usize) -> Vec<Command> {
        let mut commands = vec![Command::GroupUndo { open: true }];
        let mut repeated = Vec::new();
        match at {
            InsertAt::Cursor => {}
            InsertAt::AfterCursor => commands.push(move_without_extending(Motion::AfterCursor)),
            InsertAt::FirstNonBlank => commands.push(move_without_extending(Motion::FirstNonBlank)),
            InsertAt::LineStart => commands.push(move_without_extending(Motion::LineStart)),
            InsertAt::LineEnd => commands.push(move_without_extending(Motion::LineEnd)),
            InsertAt::LineBelow => {
                commands.push(Command::OpenLine { above: false });
                repeated.push(Command::OpenLine { above: false });
            }
            InsertAt::LineAbove => {
                commands.push(Command::OpenLine { above: true });
                repeated.push(Command::OpenLine { above: true });
            }
        }
        self.start_insert(count, repeated);
        commands
    }

    /// `.`: types again the keys of the last change, with a new count when one is given.
    fn repeat_last_change(&mut self, count: Option<usize>, context: &InputContext) -> Vec<Command> {
        let Some(change) = self.last_change.clone() else {
            return vec![Command::Noop];
        };
        let count = count.or(change.count);
        let mut keys = Vec::new();
        if let Some(register) = change.register {
            keys.push(key_of("\""));
            keys.push(key_of(&register.to_string()));
        }
        if let Some(count) = count {
            keys.extend(count.to_string().chars().map(|digit| key_of(&digit.to_string())));
        }
        keys.extend(change.keys.iter().cloned());
        self.replaying = true;
        let mut commands = Vec::new();
        if let Some(kind) = change.visual {
            commands.push(Command::SelectLastExtent);
            self.mode = Mode::Visual(kind);
        }
        for key in &keys {
            commands.extend(self.translate(key, context));
        }
        self.replaying = false;
        self.last_change = Some(Change { count, ..change });
        commands
    }

    /// The commands for `Ctrl-D`, `Ctrl-U`, `Ctrl-F` and `Ctrl-B`: they scroll the view, as vim does,
    /// and bring the cursor along.
    fn page_commands(&mut self, step: PageStep, context: &InputContext) -> Vec<Command> {
        let extend = self.visual_kind().is_some();
        let top_row = context.top_row as isize;
        let (rows, cursor) = match page_scroll(step, context) {
            PageScroll::Together(rows) => (rows, Motion::Vertical(rows)),
            PageScroll::CursorToTop(rows) => (rows, Motion::Line((top_row + rows).max(0) as usize)),
            PageScroll::CursorToBottom(rows) => {
                let bottom = (top_row + rows).max(0) + context.page_rows.max(1) as isize - 1;
                (rows, Motion::Line(bottom as usize))
            }
        };
        // The view moves first, so the cursor lands inside it and the view has no need to follow.
        let moves = Command::VimMove { motion: cursor, count: 1, extend };
        if self.visual_kind() == Some(SelectionKind::Block) {
            return vec![Command::ScrollView { rows }, block_version_of(moves)];
        }
        vec![Command::ScrollView { rows }, moves]
    }

    /// Whether a key ends the macro being recorded: `q` typed in normal mode between commands.
    fn is_end_of_macro(&self, key: &KeyInput) -> bool {
        let idle = self.mode == Mode::Normal && self.keys.is_empty() && self.command_line.is_none();
        let recording = self.macro_recording.is_some() && !self.replaying && self.macro_depth == 0;
        recording && idle && token_of(key) == "q"
    }

    /// Stores the macro that was being recorded under its register.
    fn finish_macro(&mut self) {
        if let Some((name, keys)) = self.macro_recording.take() {
            self.macros.insert(name, keys);
        }
    }

    /// `@a`: types a macro's keys `count` times, and `@@` the one played last.
    fn play_macro(&mut self, name: char, count: usize, context: &InputContext) -> Vec<Command> {
        let name = if name == '@' { self.last_macro.unwrap_or('@') } else { name };
        let Some(keys) = self.macros.get(&name).cloned() else {
            return vec![Command::Noop];
        };
        if self.macro_depth >= MAX_MACRO_DEPTH {
            return vec![Command::Noop];
        }
        self.last_macro = Some(name);
        self.macro_depth += 1;
        let mut commands = Vec::new();
        for _ in 0..count.min(MAX_MACRO_COUNT) {
            for key in &keys {
                commands.extend(self.translate(key, context));
            }
        }
        self.macro_depth -= 1;
        commands
    }

    /// Starts typing a command line.
    fn open_command_line(
        &mut self,
        prefix: char,
        text: &str,
        count: usize,
        operator: Option<(Operator, Option<char>)>,
    ) {
        self.command_line = Some(CommandLine { prefix, text: text.to_string(), count, operator });
    }

    /// A key typed in the command line.
    fn command_line_key(&mut self, key: &KeyInput, _context: &InputContext) -> Vec<Command> {
        let token = token_of(key);
        let Some(line) = self.command_line.as_mut() else {
            return Vec::new();
        };
        match token.as_str() {
            "enter" => return self.run_command_line(),
            "backspace" => {
                if line.text.is_empty() {
                    self.command_line = None;
                } else {
                    line.text.pop();
                }
            }
            "C-u" => line.text.clear(),
            "C-w" => {
                let trimmed = line.text.trim_end().len();
                let cut = line.text[..trimmed].rfind(' ').map_or(0, |index| index + 1);
                line.text.truncate(cut);
            }
            name if is_escape(name) => self.command_line = None,
            name => {
                if let Some(character) = typed_character(name).filter(|_| !key.modifiers.control) {
                    line.text.push(character);
                }
            }
        }
        vec![Command::Noop]
    }

    /// Does what a command line says when Enter ends it.
    fn run_command_line(&mut self) -> Vec<Command> {
        let Some(line) = self.command_line.take() else {
            return Vec::new();
        };
        let visual = self.visual_kind().is_some();
        if line.prefix == ':' {
            let mut commands = parse_ex(&line.text);
            if let Some(kind) = self.visual_kind() {
                self.mode = Mode::Normal;
                self.last_visual_kind = Some(kind);
                commands.insert(0, Command::RememberVisual { kind });
                if kind == SelectionKind::Block {
                    commands.push(Command::BlockEnd { exit: BlockExit::Head });
                } else {
                    commands.push(Command::CollapseToHeads);
                }
            }
            if line.text.trim().chars().all(|character| character.is_ascii_digit()) && !line.text.trim().is_empty() {
                commands.insert(0, Command::PushJump);
            }
            return commands;
        }
        let forward = line.prefix == '/';
        let request = if line.text.is_empty() {
            SearchRequest::Repeat { reverse: !forward }
        } else {
            SearchRequest::Pattern { pattern: line.text.clone(), forward }
        };
        if let Some((operator, register)) = line.operator {
            return self.operator_commands(operator, Target::Search { request, count: line.count }, register);
        }
        vec![Command::PushJump, Command::VimSearch { request, count: line.count, extend: visual }]
    }

    /// A key in insert or replace mode.
    fn insert_key(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command> {
        let token = token_of(key);
        if !self.replaying {
            if let Some(change) = self.recording.as_mut() {
                change.keys.push(key.clone());
            }
        }
        if is_escape(&token) {
            return self.leave_insert();
        }
        let replacing = self.mode == Mode::Replace;
        let typed = typed_character(&token).filter(|_| !key.modifiers.control && !key.modifiers.alt);
        if let Some(character) = typed {
            let text = character.to_string();
            let command = if replacing { Command::Overwrite { text } } else { Command::InsertText { text } };
            return self.typed(command);
        }
        let command = match token.as_str() {
            "enter" => Command::InsertNewline,
            "tab" => Command::InsertTab,
            "backspace" | "C-h" if replacing => Command::RestoreOverwritten,
            "backspace" | "C-h" => Command::Delete { motion: Motion::Left },
            "delete" => Command::Delete { motion: Motion::Right },
            "C-w" => Command::Delete { motion: Motion::WordBack { big: false } },
            "C-u" => Command::Delete { motion: Motion::LineStart },
            _ => return self.other_insert_key(key, context),
        };
        self.typed(command)
    }

    /// Remembers a command that typing made, so a count can do it again, and gives it.
    fn typed(&mut self, command: Command) -> Vec<Command> {
        self.insert.repeated.push(command.clone());
        vec![command]
    }

    /// Keys in insert mode that move the cursor or belong to the standard keys. Moving ends
    /// the undo group, as in vim, so what is typed after it is another change.
    fn other_insert_key(&mut self, key: &KeyInput, context: &InputContext) -> Vec<Command> {
        let Some(command) = standard_command(key, context) else {
            return Vec::new();
        };
        let moves = matches!(command, Command::MoveSelections { .. });
        if !moves {
            return vec![command];
        }
        self.insert.repeated.clear();
        vec![Command::GroupUndo { open: false }, command, Command::GroupUndo { open: true }]
    }

    /// Escape in insert or replace mode: does again what was typed for a count, ends the undo
    /// group and steps back onto the last character typed.
    fn leave_insert(&mut self) -> Vec<Command> {
        let mut commands = Vec::new();
        for _ in 1..self.insert.repeat {
            commands.extend(self.insert.repeated.iter().cloned());
        }
        commands.push(Command::GroupUndo { open: false });
        commands.push(Command::VimMove { motion: Motion::ColumnLeft, count: 1, extend: false });
        if std::mem::take(&mut self.block_insert) {
            commands.push(Command::CollapseSelections);
        }
        self.mode = Mode::Normal;
        self.insert = InsertSession::default();
        if !self.replaying {
            if let Some(change) = self.recording.take() {
                self.last_change = Some(change);
            }
        }
        commands
    }
}

/// Whether a motion is one of vim's jumps, which `Ctrl-O` goes back from.
fn is_jump(spec: MotionSpec) -> bool {
    match spec {
        MotionSpec::GotoLine
        | MotionSpec::GotoFirstLine
        | MotionSpec::Screen(_)
        | MotionSpec::Mark { .. }
        | MotionSpec::SearchRepeat { .. }
        | MotionSpec::SearchWord { .. } => true,
        MotionSpec::Fixed(motion) => {
            matches!(motion, Motion::ParagraphBack | Motion::ParagraphForward | Motion::MatchingBracket)
        }
        _ => false,
    }
}

/// A move that extends the selection, as the same move of a visual block's corner. Anything else
/// that would extend a selection does nothing in a block, which has no one selection to extend.
fn block_version_of(command: Command) -> Command {
    match command {
        Command::VimMove { motion, count, extend: true } => Command::BlockMove { motion, count },
        Command::VimSearch { extend: true, .. } | Command::JumpToMark { extend: true, .. } => Command::Noop,
        other => other,
    }
}

/// Ends the visual block after a command that worked on it, with one cursor at its top left corner.
fn end_block_after(kind: SelectionKind, commands: &mut Vec<Command>) {
    if kind == SelectionKind::Block {
        commands.push(Command::BlockEnd { exit: BlockExit::TopLeft });
    }
}

/// A plain move of every cursor.
fn move_without_extending(motion: Motion) -> Command {
    Command::MoveSelections { motion, extend: false }
}

/// A group of commands done `count` times over.
fn repeat_commands(count: usize, group: Vec<Command>) -> Vec<Command> {
    let mut commands = Vec::new();
    for _ in 0..count {
        commands.extend(group.iter().cloned());
    }
    commands
}

/// The row `H`, `M` or `L` goes to, counting from zero.
fn screen_row(row: ScreenRow, offset: usize, context: &InputContext) -> usize {
    let rows = context.page_rows.max(1);
    match row {
        ScreenRow::Top => context.top_row + offset.saturating_sub(1),
        ScreenRow::Middle => context.top_row + (rows - 1) / 2,
        ScreenRow::Bottom => (context.top_row + rows - 1).saturating_sub(offset.saturating_sub(1)),
    }
}

/// What a scroll key does to the view and the cursor.
enum PageScroll {
    /// `Ctrl-D` and `Ctrl-U`: the view scrolls by rows and the cursor goes the same distance, so it stays where it is on the screen.
    Together(isize),
    /// `Ctrl-F`: the view scrolls by rows and the cursor goes to its top line.
    CursorToTop(isize),
    /// `Ctrl-B`: the view scrolls by rows and the cursor goes to its bottom line.
    CursorToBottom(isize),
}

/// How a scroll key moves the view and the cursor, for a view of `context.page_rows` rows.
fn page_scroll(step: PageStep, context: &InputContext) -> PageScroll {
    let rows = context.page_rows.max(1) as isize;
    let half = (rows / 2).max(1);
    let page = (rows - 2).max(1);
    match step {
        PageStep::HalfDown => PageScroll::Together(half),
        PageStep::HalfUp => PageScroll::Together(-half),
        PageStep::PageDown => PageScroll::CursorToTop(page),
        PageStep::PageUp => PageScroll::CursorToBottom(-page),
    }
}

/// Whether `.` repeats a command: everything that changes the text.
fn is_change(action: &Action, mode: Mode) -> bool {
    if matches!(mode, Mode::Visual(_)) {
        return match action {
            Action::Simple(Simple::VisualOperator(operator) | Simple::VisualLinesOperator(operator)) => {
                *operator != Operator::Yank
            }
            Action::Simple(Simple::Put { .. } | Simple::Join | Simple::ReplaceChar(_)) => true,
            _ => false,
        };
    }
    match action {
        Action::Move(_) => false,
        Action::Operate { operator, .. } => *operator != Operator::Yank,
        Action::Simple(simple) => match simple {
            Simple::ShortOperator { operator, .. } => *operator != Operator::Yank,
            Simple::Join
            | Simple::Put { .. }
            | Simple::Insert(_)
            | Simple::ReplaceMode
            | Simple::ReplaceChar(_)
            | Simple::ToggleCaseChar => true,
            _ => false,
        },
    }
}
