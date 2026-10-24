//! How the view scrolls: straight to a place, or gliding there (see `smooth_scroll.rs`). Page
//! jumps and wheel notches glide; a trackpad's pixels, a short step and anything while smooth
//! scrolling is off go straight there.

use std::time::Instant;

use svelte_gpui::gpui::{Context, Pixels, ScrollDelta, Window, px};

use super::Editor;
use super::element::LINE_HEIGHT;
use super::smooth_scroll::{ScrollAnimation, glide_start, logging_enabled};

/// The shortest jump that glides when the view follows the cursor: three rows. Following the
/// cursor one line at a time stays immediate, so typing at the bottom of the view does not lag.
pub const MIN_GLIDE: Pixels = px(63.0);

impl Editor {
    /// Where the view is going: the end of the glide it is in, or else where it is.
    pub(super) fn scroll_target(&self) -> Pixels {
        match &self.scroll_animation {
            Some(animation) => px(animation.target()),
            None => self.scroll_top,
        }
    }

    /// Scrolls to `target`, gliding there when it is more than `min_distance` away from where the
    /// view is and smooth scrolling is on, and going straight there otherwise.
    pub(super) fn scroll_to(&mut self, target: Pixels, min_distance: Pixels) {
        let current = f32::from(self.scroll_top);
        let target = f32::from(target);
        let distance = (target - current).abs();
        let gliding = self.documents.options().smooth_scroll;
        if !gliding || distance <= f32::from(min_distance) {
            self.scroll_animation = None;
            self.set_scroll_top(px(target));
            return;
        }
        let page_height = self.layout.as_ref().map_or(0.0, |layout| f32::from(layout.bounds.size.height));
        let start = glide_start(current, target, page_height);
        self.set_scroll_top(px(start));
        self.scroll_animation = Some(ScrollAnimation::new(start, target, Instant::now()));
    }

    /// Scrolls for the wheel. A notch glides one step further than where the view is going, and a
    /// trackpad's pixels move the view at once.
    pub(super) fn wheel_scrolled(&mut self, delta: ScrollDelta) {
        match delta {
            ScrollDelta::Pixels(pixels) => {
                self.scroll_animation = None;
                let target = self.clamp_scroll(self.scroll_top - pixels.y);
                self.set_scroll_top(target);
            }
            ScrollDelta::Lines(lines) => {
                let target = self.clamp_scroll(self.scroll_target() - LINE_HEIGHT * lines.y);
                self.scroll_to(target, px(0.0));
            }
        }
    }

    /// Moves a glide on to the time of this frame and asks for another frame while it lasts. The
    /// occurrences are looked for once it has arrived.
    pub(super) fn advance_glide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(animation) = self.scroll_animation else {
            return;
        };
        let now = Instant::now();
        let top = animation.value_at(now);
        self.set_scroll_top(px(top));
        self.scroll_group_to_here(cx);
        if logging_enabled() {
            eprintln!("scroll {:>4}ms top={top:.1}", animation.elapsed_at(now).as_millis());
        }
        if !animation.is_finished(now) {
            window.request_animation_frame();
            return;
        }
        self.scroll_animation = None;
        self.occurrences_may_have_changed(cx);
    }

    /// Scrolls the view down by some rows, or up when negative, for vim's page keys. The view may
    /// go as far as the last line at its top, as it does in vim.
    pub(super) fn scroll_by_rows(&mut self, rows: isize) {
        let target = self.clamp_scroll(self.scroll_target() + LINE_HEIGHT * rows as f32);
        self.scroll_to(target, px(0.0));
    }

    /// Keeps a scroll offset between the top and the last row, which may sit at the top of the view.
    /// Blocks count as rows.
    fn clamp_scroll(&self, top: Pixels) -> Pixels {
        if self.read(|state| state.buffer().line_count()).is_none() {
            return top;
        }
        top.clamp(px(0.0), self.furthest_scroll())
    }

    /// The most the view can scroll: the last row at its top. Blocks count as rows.
    pub(super) fn furthest_scroll(&self) -> Pixels {
        let Some(line_count) = self.read(|state| state.buffer().line_count()) else {
            return px(0.0);
        };
        let total_rows = match &self.layout {
            Some(layout) => layout.blocks.total_rows(line_count),
            None => line_count,
        };
        LINE_HEIGHT * total_rows.saturating_sub(1) as f32
    }
}
