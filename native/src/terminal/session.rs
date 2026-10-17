//! A shell running in a pseudo-terminal, and the terminal emulator that reads what it prints.
//!
//! The pty, the thread that reads it and the emulator come from `alacritty_terminal`, the same
//! library Zed's terminal is built on. A thread of its own reads the shell's output and feeds the
//! emulator's grid, so output never passes through the app's JavaScript. The view locks the grid
//! when it paints. What the library reports (new output, a title, the bell, the shell exiting) is
//! handled by `Listener`, which wakes the view that shows the session, once per frame at most.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use alacritty_terminal::Term;
use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::Config;
use alacritty_terminal::tty::{self, Options, Shell};
use alacritty_terminal::vte::ansi::Rgb;
use futures::channel::mpsc::UnboundedSender;
use parking_lot::Mutex;
use serde_json::json;
use svelte_gpui::Emitter;

use super::theme::TerminalTheme;

/// How much output a terminal keeps above the screen.
const SCROLLBACK_LINES: usize = 10_000;

/// The size of the grid in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridSize {
    pub columns: usize,
    pub rows: usize,
}

impl GridSize {
    /// A grid of this many columns and rows, at least one of each.
    pub fn new(columns: usize, rows: usize) -> Self {
        GridSize { columns: columns.max(1), rows: rows.max(1) }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

/// The size of one cell in whole pixels, which programs ask for to draw images.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellPixels {
    pub width: u16,
    pub height: u16,
}

/// What to run and where.
pub struct SpawnOptions {
    pub working_directory: PathBuf,
    /// The program and its arguments; the user's shell as a login shell when none is given.
    pub command: Option<(String, Vec<String>)>,
}

/// The title of a terminal, from the program or from the process in front.
#[derive(Default)]
struct TitleState {
    /// What the program set with an escape sequence, if it did.
    set_by_program: Option<String>,
    /// The name of the process running in the foreground.
    process: String,
    /// The last title announced to the app.
    announced: String,
}

/// State the reading thread and the window's thread both touch.
pub struct Shared {
    id: String,
    emitter: Option<Emitter>,
    /// Whether a redraw has been asked for and not yet painted.
    redraw_pending: AtomicBool,
    /// Where to ask for a redraw: the view showing this session, if there is one.
    redraw: Mutex<Option<UnboundedSender<()>>>,
    /// How to write to the shell, once the event loop that does it exists.
    writer: Mutex<Option<EventLoopSender>>,
    title: Mutex<TitleState>,
    exited: AtomicBool,
    theme: Mutex<TerminalTheme>,
    size: Mutex<(GridSize, CellPixels)>,
}

impl Shared {
    /// Asks the view to draw again, unless it already has been asked to.
    fn request_redraw(&self) {
        if self.redraw_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let redraw = self.redraw.lock();
        if let Some(sender) = redraw.as_ref() {
            let _ = sender.unbounded_send(());
        }
    }

    /// Tells the app about something that happened in this terminal.
    fn emit(&self, name: &str, mut payload: serde_json::Value) {
        let Some(emitter) = &self.emitter else {
            return;
        };
        payload["id"] = json!(self.id);
        emitter.emit(name, payload);
    }

    /// Writes bytes to the shell.
    fn write(&self, bytes: Cow<'static, [u8]>) {
        let writer = self.writer.lock();
        if let Some(sender) = writer.as_ref() {
            let _ = sender.send(Msg::Input(bytes));
        }
    }

    /// Announces the title the tab should show if it changed: the program's own, else the process.
    fn refresh_title(&self) {
        let mut state = self.title.lock();
        let mut title = match &state.set_by_program {
            Some(set) if !set.is_empty() => set.clone(),
            _ => state.process.clone(),
        };
        if title.is_empty() {
            title = "shell".to_string();
        }
        if title == state.announced {
            return;
        }
        state.announced = title.clone();
        drop(state);
        self.emit("terminal-title", json!({ "title": title }));
    }

    /// What the library asks of the terminal's colours: a palette entry, the foreground, the
    /// background or the cursor.
    fn color_for_request(&self, index: usize) -> Rgb {
        let theme = self.theme.lock();
        match index {
            0..=255 => theme.indexed(index as u8),
            256 | 267 => theme.foreground,
            257 => theme.background,
            258 => theme.cursor,
            _ => theme.foreground,
        }
    }

    /// The window size in cells and pixels, as a program asks for it.
    fn window_size(&self) -> WindowSize {
        let (grid, cell) = *self.size.lock();
        WindowSize {
            num_lines: grid.rows as u16,
            num_cols: grid.columns as u16,
            cell_width: cell.width,
            cell_height: cell.height,
        }
    }
}

/// Receives the emulator's events on the reading thread.
#[derive(Clone)]
pub struct Listener {
    shared: Arc<Shared>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let shared = &self.shared;
        match event {
            Event::Wakeup | Event::MouseCursorDirty | Event::CursorBlinkingChange => shared.request_redraw(),
            Event::Title(title) => {
                shared.title.lock().set_by_program = Some(title);
                shared.refresh_title();
            }
            Event::ResetTitle => {
                shared.title.lock().set_by_program = None;
                shared.refresh_title();
            }
            Event::Bell => shared.emit("terminal-bell", json!({})),
            Event::PtyWrite(text) => shared.write(Cow::Owned(text.into_bytes())),
            Event::ColorRequest(index, format) => {
                let text = format(shared.color_for_request(index));
                shared.write(Cow::Owned(text.into_bytes()));
            }
            Event::TextAreaSizeRequest(format) => {
                let text = format(shared.window_size());
                shared.write(Cow::Owned(text.into_bytes()));
            }
            Event::ChildExit(status) => {
                shared.exited.store(true, Ordering::Release);
                shared.emit("terminal-exit", json!({ "code": status.code() }));
                shared.request_redraw();
            }
            Event::Exit | Event::ClipboardStore(..) | Event::ClipboardLoad(..) => {}
        }
    }
}

/// A running shell and the emulator that holds what it printed.
pub struct Session {
    term: Arc<FairMutex<Term<Listener>>>,
    sender: EventLoopSender,
    shared: Arc<Shared>,
    child_id: u32,
}

impl Session {
    /// Starts a shell in a pseudo-terminal of the given size. `emitter` carries the terminal's
    /// events (title, bell, exit) to the app; tests leave it out.
    pub fn spawn(
        id: &str,
        options: SpawnOptions,
        grid: GridSize,
        cell: CellPixels,
        theme: TerminalTheme,
        emitter: Option<Emitter>,
    ) -> io::Result<Arc<Session>> {
        let shared = Arc::new(Shared {
            id: id.to_string(),
            emitter,
            redraw_pending: AtomicBool::new(false),
            redraw: Mutex::new(None),
            writer: Mutex::new(None),
            title: Mutex::new(TitleState::default()),
            exited: AtomicBool::new(false),
            theme: Mutex::new(theme),
            size: Mutex::new((grid, cell)),
        });
        let listener = Listener { shared: shared.clone() };
        let window_size = WindowSize {
            num_lines: grid.rows as u16,
            num_cols: grid.columns as u16,
            cell_width: cell.width,
            cell_height: cell.height,
        };
        let pty = tty::new(&pty_options(options), window_size, 0)?;
        let child_id = pty.child().id();
        let config = Config { scrolling_history: SCROLLBACK_LINES, ..Config::default() };
        let term = Arc::new(FairMutex::new(Term::new(config, &grid, listener.clone())));
        let event_loop = EventLoop::new(term.clone(), listener, pty, true, false)?;
        let sender = event_loop.channel();
        *shared.writer.lock() = Some(sender.clone());
        event_loop.spawn();
        Ok(Arc::new(Session { term, sender, shared, child_id }))
    }

    /// Writes bytes to the shell, as typing would.
    pub fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        self.shared.write(bytes.into());
    }

    /// Runs `read` with the emulator locked. Keep it short: the reading thread waits.
    pub fn with_term<R>(&self, read: impl FnOnce(&mut Term<Listener>) -> R) -> R {
        let mut term = self.term.lock();
        read(&mut term)
    }

    /// Resizes the grid and tells the shell, unless the size is the one it already has.
    pub fn resize(&self, grid: GridSize, cell: CellPixels) {
        let mut current = self.shared.size.lock();
        if *current == (grid, cell) {
            return;
        }
        *current = (grid, cell);
        drop(current);
        self.term.lock().resize(grid);
        let window_size = self.shared.window_size();
        let _ = self.sender.send(Msg::Resize(window_size));
    }

    /// The size of the grid and of a cell as last set.
    #[cfg(test)]
    pub fn size(&self) -> (GridSize, CellPixels) {
        *self.shared.size.lock()
    }

    /// Sets the colours programs are told when they ask (OSC 10, 11 and 4).
    pub fn set_theme(&self, theme: TerminalTheme) {
        *self.shared.theme.lock() = theme;
    }

    /// Makes the view behind `sender` the one to wake when output arrives.
    pub fn attach(&self, sender: UnboundedSender<()>) {
        *self.shared.redraw.lock() = Some(sender);
        self.shared.redraw_pending.store(false, Ordering::Release);
    }

    /// Marks the pending redraw as taken, so the next output asks for another.
    pub fn redraw_taken(&self) {
        self.shared.redraw_pending.store(false, Ordering::Release);
    }

    /// Whether the shell has exited.
    pub fn has_exited(&self) -> bool {
        self.shared.exited.load(Ordering::Acquire)
    }

    /// Stops the shell: the pty closes, which hangs the shell up.
    pub fn shutdown(&self) {
        let _ = self.sender.send(Msg::Shutdown);
    }

    /// The directory the shell is in, if it can be read.
    pub fn working_directory(&self) -> Option<PathBuf> {
        std::fs::read_link(format!("/proc/{}/cwd", self.child_id)).ok()
    }

    /// Looks at the process in front of the terminal and announces its name as the title when no
    /// program has set one.
    pub fn sample_process(&self) {
        if self.has_exited() {
            return;
        }
        let Some(name) = foreground_process_name(self.child_id) else {
            return;
        };
        self.shared.title.lock().process = name;
        self.shared.refresh_title();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The pty's options for what to run: the command given, else the user's shell as a login shell.
fn pty_options(options: SpawnOptions) -> Options {
    let (program, arguments) = match options.command {
        Some(command) => command,
        None => (default_shell(), vec!["-l".to_string(), "-i".to_string()]),
    };
    let mut environment = HashMap::new();
    environment.insert("TERM".to_string(), "xterm-256color".to_string());
    environment.insert("COLORTERM".to_string(), "truecolor".to_string());
    environment.insert("TERM_PROGRAM".to_string(), "grove".to_string());
    Options {
        shell: Some(Shell::new(program, arguments)),
        working_directory: Some(options.working_directory),
        drain_on_exit: true,
        env: environment,
    }
}

/// `$SHELL`, else bash.
fn default_shell() -> String {
    match std::env::var("SHELL") {
        Ok(shell) if !shell.is_empty() => shell,
        _ => "/bin/bash".to_string(),
    }
}

/// The name of the process in the foreground of the shell's terminal: the foreground process
/// group id is in the shell's `/proc/<pid>/stat`, after the command's name in parentheses.
fn foreground_process_name(shell_id: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{shell_id}/stat")).ok()?;
    let after_name = stat.rsplit_once(')')?.1;
    let foreground_group: i64 = after_name.split_whitespace().nth(5)?.parse().ok()?;
    if foreground_group <= 0 {
        return None;
    }
    let name = std::fs::read_to_string(format!("/proc/{foreground_group}/comm")).ok()?;
    Some(name.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    use crate::terminal::grid::snapshot;

    const CELL: CellPixels = CellPixels { width: 8, height: 16 };

    /// Starts `sh -c script` in a grid of the given size.
    fn run(script: &str, columns: usize, rows: usize) -> Arc<Session> {
        let options = SpawnOptions {
            working_directory: std::env::temp_dir(),
            command: Some(("/bin/sh".to_string(), vec!["-c".to_string(), script.to_string()])),
        };
        Session::spawn("test", options, GridSize::new(columns, rows), CELL, TerminalTheme::default(), None)
            .expect("a shell")
    }

    /// The text on screen, one line per row with trailing blanks cut.
    fn screen_text(session: &Session) -> String {
        session.with_term(|term| {
            let snapshot = snapshot(term, &TerminalTheme::default());
            let mut lines = vec![String::new(); snapshot.rows];
            for span in &snapshot.spans {
                let line = &mut lines[span.row];
                while line.chars().count() < span.column {
                    line.push(' ');
                }
                line.push_str(&span.text);
            }
            lines.join("\n")
        })
    }

    /// Waits until the screen contains `needle`, or panics after a few seconds.
    fn wait_for(session: &Session, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if screen_text(session).contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("{needle:?} never appeared; the screen shows:\n{}", screen_text(session));
    }

    #[test]
    fn output_reaches_the_grid() {
        let session = run("printf 'hello \\033[31mred\\033[0m'", 40, 5);
        wait_for(&session, "hello red");
    }

    #[test]
    fn the_shell_starts_in_the_working_directory() {
        let directory = std::env::temp_dir().canonicalize().expect("temp dir");
        let session = run("pwd", 80, 5);
        wait_for(&session, directory.to_str().expect("utf-8 path"));
    }

    #[test]
    fn input_reaches_the_shell() {
        let session = run("read line; echo got:$line", 40, 5);
        session.write(b"ping\n".to_vec());
        wait_for(&session, "got:ping");
    }

    #[test]
    fn resizing_tells_the_shell_the_new_size() {
        let session = run("sleep 0.5; stty size", 80, 24);
        session.resize(GridSize::new(100, 30), CELL);
        wait_for(&session, "30 100");
        assert_eq!(session.size().0, GridSize::new(100, 30));
        session.with_term(|term| {
            assert_eq!((term.columns(), term.screen_lines()), (100, 30));
        });
    }

    #[test]
    fn the_exit_of_the_shell_is_noticed() {
        let session = run("true", 40, 5);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !session.has_exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(session.has_exited());
    }

    #[test]
    fn the_foreground_process_names_the_terminal() {
        let session = run("exec sleep 5", 40, 5);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut name = None;
        while name.as_deref() != Some("sleep") && Instant::now() < deadline {
            name = foreground_process_name(session.child_id);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(name.as_deref(), Some("sleep"));
    }

    #[test]
    fn scrollback_keeps_what_left_the_screen() {
        let session = run("seq 1 200", 20, 5);
        wait_for(&session, "200");
        session.with_term(|term| {
            assert!(term.history_size() >= 190);
        });
    }
}
