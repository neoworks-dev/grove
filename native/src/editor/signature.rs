//! Signature help: while the person types the arguments of a call, a popover above the cursor
//! shows the signature with the parameter being typed in bold. The server is asked when a
//! trigger character is typed, and again as the text or the cursor changes, and it answers
//! with nothing once the cursor is out of the call, which closes the popover.

use editor_core::{Command, DocumentId, Outcome};
use lsp_client::protocol::ResponseError;
use lsp_client::signature::{SignatureHelp, request_context};
use serde_json::Value;
use svelte_gpui::gpui::{Context, Keystroke};

use super::Editor;
use super::Signal;
use super::features::FeatureSignal;
use crate::lsp::Pending;

/// A popover that is showing, or whose first answer is awaited.
pub struct SignatureSession {
    pub document: DocumentId,
    /// The number of the request whose answer is wanted.
    pub request: u64,
    pub pending: Option<Pending>,
    pub help: Option<SignatureHelp>,
    /// The answer as the server gave it, sent back with the next request.
    pub raw: Option<Value>,
    /// The overload shown, which the person may have moved off the one the server preferred.
    pub choice: usize,
    pub chosen_by_person: bool,
}

impl SignatureSession {
    /// Whether there is anything to show yet.
    pub fn is_visible(&self) -> bool {
        self.help.is_some()
    }
}

impl Editor {
    /// Reacts to a command: typing a trigger character opens the popover, any other change to
    /// the text or the cursor asks again while it is open, and a closing parenthesis ends it.
    pub(super) fn track_signature(&mut self, command: &Command, outcome: &Outcome, cx: &mut Context<Self>) {
        if !self.is_typing_mode() {
            self.close_signature();
            return;
        }
        let typed = match command {
            Command::InsertText { text } if outcome.text_changed => single_character(text),
            _ => None,
        };
        let Some(document) = self.document else {
            return;
        };
        let Some(capabilities) = self.lsp.capabilities(document) else {
            return;
        };
        if !capabilities.signature_help {
            return;
        }
        if let Some(character) = typed {
            let is_trigger = capabilities.signature_trigger_characters.iter().any(|t| t.chars().eq([character]));
            let is_retrigger = capabilities.signature_retrigger_characters.iter().any(|t| t.chars().eq([character]));
            if is_trigger || is_retrigger {
                if is_retrigger && !is_trigger {
                    self.close_signature();
                }
                self.request_signature(Some(character), cx);
                return;
            }
        }
        if self.features.signature.is_some() && (outcome.changed || outcome.text_changed) {
            self.request_signature(None, cx);
        }
    }

    /// Asks the server for the signatures at the cursor, opening the session if there is none.
    pub(super) fn request_signature(&mut self, trigger: Option<char>, cx: &mut Context<Self>) {
        let (Some(document), Some(head)) = (self.document, self.cursor()) else {
            return;
        };
        let request = self.next_request_number();
        let sender = self.signals.clone();
        let active = self.features.signature.as_ref().and_then(|session| session.raw.clone());
        let context = request_context(trigger, active.as_ref());
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let help = match result {
                Ok(answer) => SignatureHelp::parse(&answer).map(|help| (help, answer)),
                Err(_) => None,
            };
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Signature { request, help }));
        });
        let extra = serde_json::json!({ "context": context });
        let Some(pending) = self.lsp.request_at(document, head, "textDocument/signatureHelp", extra, reply) else {
            return;
        };
        match &mut self.features.signature {
            Some(session) => {
                if let Some(old) = session.pending.replace(pending) {
                    old.cancel();
                }
                session.request = request;
            }
            None => {
                self.features.signature = Some(SignatureSession {
                    document,
                    request,
                    pending: Some(pending),
                    help: None,
                    raw: None,
                    choice: 0,
                    chosen_by_person: false,
                });
            }
        }
        cx.notify();
    }

    /// Takes in the server's answer, if it is the one being waited for. No signatures ends the session.
    pub(super) fn signature_arrived(
        &mut self,
        request: u64,
        help: Option<(SignatureHelp, Value)>,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = &mut self.features.signature else {
            return;
        };
        if session.request != request {
            return;
        }
        session.pending = None;
        let Some((help, raw)) = help else {
            self.close_signature();
            cx.notify();
            return;
        };
        if !session.chosen_by_person || session.choice >= help.signatures.len() {
            session.choice = help.active_signature;
            session.chosen_by_person = false;
        }
        session.help = Some(help);
        session.raw = Some(raw);
        cx.notify();
    }

    /// Closes the popover and gives up on a request that is out.
    pub(super) fn close_signature(&mut self) {
        let Some(session) = self.features.signature.take() else {
            return;
        };
        if let Some(pending) = session.pending {
            pending.cancel();
        }
    }

    /// Handles a key while the popover is up: Up and Down (with Alt in vim's insert mode, where
    /// they move the cursor) move between the overloads, and Escape closes it.
    pub(super) fn signature_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        if self.features.signature.is_none() {
            return false;
        }
        let key = keystroke.key.as_str();
        let modifiers = keystroke.modifiers;
        if key == "escape" && !modifiers.control && !modifiers.alt {
            self.close_signature();
            cx.notify();
            return false;
        }
        let step: isize = match key {
            "down" => 1,
            "up" => -1,
            _ => return false,
        };
        let in_vim = !self.input.status().mode.is_empty();
        if modifiers.control || modifiers.shift || (in_vim && !modifiers.alt) {
            return false;
        }
        let Some(session) = &mut self.features.signature else {
            return false;
        };
        let count = session.help.as_ref().map_or(0, |help| help.signatures.len()) as isize;
        if count < 2 {
            return false;
        }
        session.choice = (session.choice as isize + step).rem_euclid(count) as usize;
        session.chosen_by_person = true;
        cx.notify();
        true
    }
}

/// The character in a text of exactly one.
fn single_character(text: &str) -> Option<char> {
    let mut characters = text.chars();
    let first = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    Some(first)
}
