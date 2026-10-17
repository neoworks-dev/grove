//! What reaches an editor view from other threads. A view runs on the window's thread; language
//! server answers arrive on reader threads. Each view listens to a channel, and everything sent
//! on it is handled on the window's thread, between frames.

use std::sync::{Arc, Mutex};

use editor_core::DocumentId;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use lsp_client::completion::ItemList;
use lsp_client::protocol::Target;

/// One thing a view is told. Answers carry the number of the request they answer, so a view
/// ignores the ones it has since stopped waiting for.
pub enum Signal {
    /// A document's decorations changed, so every view of it has to redraw.
    Redraw(DocumentId),
    /// The items for a completion request, or why there are none.
    Completions { request: u64, result: Result<ItemList, String> },
    /// The fuller item a server answered a resolve request with.
    Resolved { request: u64, item: serde_json::Value },
    /// What the server says about the symbol under the pointer or the cursor, as markdown.
    Hover { request: u64, markdown: Option<String> },
    /// Where a go-to-definition request leads.
    Targets { request: u64, targets: Vec<Target> },
    /// The language features switches changed, so hints and the like are asked for or taken away.
    SettingsChanged,
    /// A server asked for the inlay hints to be asked for again.
    HintsStale,
    /// The answer to one of the requests around the cursor (see `features.rs`).
    Feature(super::features::FeatureSignal),
}

/// Where a view's signals are sent from.
pub type SignalSender = UnboundedSender<Signal>;

/// The channels of every view, so something that concerns all of them can reach each. Cheap to clone.
#[derive(Clone, Default)]
pub struct Signals {
    senders: Arc<Mutex<Vec<SignalSender>>>,
}

impl Signals {
    /// Starts a channel for a view. Returns the end the view reads and the end answers are sent on.
    pub fn subscribe(&self) -> (SignalSender, UnboundedReceiver<Signal>) {
        let (sender, receiver) = unbounded();
        self.lock().push(sender.clone());
        (sender, receiver)
    }

    /// Tells every view that a document's decorations changed. Views that have gone are forgotten.
    pub fn redraw(&self, document: DocumentId) {
        self.lock().retain(|sender| sender.unbounded_send(Signal::Redraw(document)).is_ok());
    }

    /// Tells every view that the settings the language features follow changed.
    pub fn settings_changed(&self) {
        self.lock().retain(|sender| sender.unbounded_send(Signal::SettingsChanged).is_ok());
    }

    /// Tells every view that a server wants its inlay hints asked for again.
    pub fn hints_stale(&self) {
        self.lock().retain(|sender| sender.unbounded_send(Signal::HintsStale).is_ok());
    }

    /// Locks the list, carrying on after a thread that held it panicked.
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<SignalSender>> {
        self.senders.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
