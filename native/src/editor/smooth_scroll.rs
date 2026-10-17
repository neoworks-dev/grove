//! Smooth scrolling: a jump of a page, or a notch of the mouse wheel, glides to where it is going
//! over a fraction of a second, easing out so it arrives gently. Trackpads already send small
//! steps, so those are never animated. The view starts an animation when it wants to scroll
//! somewhere, and every frame asks it where to be until it is done.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// How long a glide takes.
pub const GLIDE_DURATION: Duration = Duration::from_millis(130);

/// A far jump (`G`, `gg`) starts this many pages from where it is going, so the glide is the last
/// stretch rather than a blur of the whole file.
const MAX_GLIDE_PAGES: f32 = 2.0;

/// A scroll from one offset to another, started at a moment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollAnimation {
    from: f32,
    to: f32,
    started: Instant,
}

impl ScrollAnimation {
    /// A glide from `from` to `to`, that starts at `now`.
    pub fn new(from: f32, to: f32, now: Instant) -> Self {
        ScrollAnimation { from, to, started: now }
    }

    /// Where the glide ends.
    pub fn target(&self) -> f32 {
        self.to
    }

    /// Where the glide is at a moment: the start before it, the end after it.
    pub fn value_at(&self, now: Instant) -> f32 {
        let progress = self.progress_at(now);
        self.from + (self.to - self.from) * ease_out_cubic(progress)
    }

    /// How long the glide has been going at a moment, for the log.
    pub fn elapsed_at(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.started)
    }

    /// Whether the glide has arrived.
    pub fn is_finished(&self, now: Instant) -> bool {
        self.progress_at(now) >= 1.0
    }

    /// How far through its time the glide is, from zero to one.
    fn progress_at(&self, now: Instant) -> f32 {
        let elapsed = now.saturating_duration_since(self.started);
        (elapsed.as_secs_f32() / GLIDE_DURATION.as_secs_f32()).clamp(0.0, 1.0)
    }
}

/// Fast at first and slowing to a stop, with `progress` and the result both from zero to one.
pub fn ease_out_cubic(progress: f32) -> f32 {
    let remaining = 1.0 - progress.clamp(0.0, 1.0);
    1.0 - remaining * remaining * remaining
}

/// Where a glide from `current` to `target` should begin: `current`, or when that is further
/// than a couple of pages away, a couple of pages short of `target`.
pub fn glide_start(current: f32, target: f32, page_height: f32) -> f32 {
    let furthest = page_height * MAX_GLIDE_PAGES;
    if (target - current).abs() <= furthest {
        return current;
    }
    if target > current { target - furthest } else { target + furthest }
}

/// Whether `GROVE_LOG_SCROLL` is set, which makes every animated frame print its offset so a
/// glide can be checked without watching it.
pub fn logging_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("GROVE_LOG_SCROLL").is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glide_starts_where_it_was_and_ends_where_it_was_going() {
        let start = Instant::now();
        let animation = ScrollAnimation::new(100.0, 700.0, start);
        assert_eq!(animation.value_at(start), 100.0);
        assert_eq!(animation.value_at(start + GLIDE_DURATION), 700.0);
        assert_eq!(animation.value_at(start + GLIDE_DURATION * 3), 700.0);
        assert!(!animation.is_finished(start + GLIDE_DURATION / 2));
        assert!(animation.is_finished(start + GLIDE_DURATION));
    }

    #[test]
    fn a_glide_eases_out_so_it_covers_most_of_the_way_in_the_first_half() {
        let start = Instant::now();
        let animation = ScrollAnimation::new(0.0, 1000.0, start);
        let halfway = animation.value_at(start + GLIDE_DURATION / 2);
        assert!(halfway > 800.0 && halfway < 1000.0, "{halfway}");
        let mut previous = 0.0;
        for step in 0..=13 {
            let value = animation.value_at(start + Duration::from_millis(step * 10));
            assert!(value >= previous);
            previous = value;
        }
    }

    #[test]
    fn a_glide_works_upward_too() {
        let start = Instant::now();
        let animation = ScrollAnimation::new(900.0, 300.0, start);
        let middle = animation.value_at(start + GLIDE_DURATION / 4);
        assert!(middle < 900.0 && middle > 300.0);
    }

    #[test]
    fn a_far_jump_glides_only_its_last_pages() {
        assert_eq!(glide_start(0.0, 500.0, 400.0), 0.0);
        assert_eq!(glide_start(0.0, 100_000.0, 400.0), 100_000.0 - 800.0);
        assert_eq!(glide_start(100_000.0, 0.0, 400.0), 800.0);
    }
}
