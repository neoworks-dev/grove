//! The colours the terminal paints with. The app's theme sends them as the element's `theme`
//! prop and again when the theme changes. Until the first one arrives the terminal uses the
//! defaults here.
//!
//! ```json
//! { "background": "#1c1c1e", "foreground": "#fafafa", "cursor": "#a78bfa",
//!   "selection": "#a78bfa59",
//!   "ansi": ["#000000", "#cd3131", …] }
//! ```
//!
//! `ansi` holds the sixteen colours a program names with SGR 30 to 37 and 90 to 97. The colours
//! after those, the 6x6x6 cube and the grey ramp of the 256-colour palette, are the same in
//! every theme.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use serde_json::Value;

/// The colours of one theme.
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalTheme {
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Rgb,
    /// The selection's colour and opacity, as red, green, blue and alpha.
    pub selection: [u8; 4],
    pub ansi: [Rgb; 16],
}

/// A colour from three bytes.
const fn rgb(red: u8, green: u8, blue: u8) -> Rgb {
    Rgb { r: red, g: green, b: blue }
}

impl Default for TerminalTheme {
    /// A dark theme with the common xterm-like colours.
    fn default() -> Self {
        TerminalTheme {
            background: rgb(0x1c, 0x1c, 0x1e),
            foreground: rgb(0xe4, 0xe4, 0xe7),
            cursor: rgb(0xa7, 0x8b, 0xfa),
            selection: [0xa7, 0x8b, 0xfa, 0x59],
            ansi: [
                rgb(0x00, 0x00, 0x00),
                rgb(0xcd, 0x31, 0x31),
                rgb(0x0d, 0xbc, 0x79),
                rgb(0xe5, 0xe5, 0x10),
                rgb(0x24, 0x72, 0xc8),
                rgb(0xbc, 0x3f, 0xbc),
                rgb(0x11, 0xa8, 0xcd),
                rgb(0xe5, 0xe5, 0xe5),
                rgb(0x66, 0x66, 0x66),
                rgb(0xf1, 0x4c, 0x4c),
                rgb(0x23, 0xd1, 0x8b),
                rgb(0xf5, 0xf5, 0x43),
                rgb(0x3b, 0x8e, 0xea),
                rgb(0xd6, 0x70, 0xd6),
                rgb(0x29, 0xb8, 0xdb),
                rgb(0xff, 0xff, 0xff),
            ],
        }
    }
}

impl TerminalTheme {
    /// The theme a `theme` prop describes; anything it leaves out or gets wrong keeps its default.
    pub fn from_json(value: &Value) -> Self {
        let mut theme = TerminalTheme::default();
        if let Some(color) = value.get("background").and_then(Value::as_str).and_then(parse_rgb) {
            theme.background = color;
        }
        if let Some(color) = value.get("foreground").and_then(Value::as_str).and_then(parse_rgb) {
            theme.foreground = color;
        }
        if let Some(color) = value.get("cursor").and_then(Value::as_str).and_then(parse_rgb) {
            theme.cursor = color;
        }
        if let Some(color) = value.get("selection").and_then(Value::as_str).and_then(parse_rgba) {
            theme.selection = color;
        }
        if let Some(names) = value.get("ansi").and_then(Value::as_array) {
            for (slot, name) in theme.ansi.iter_mut().zip(names) {
                if let Some(color) = name.as_str().and_then(parse_rgb) {
                    *slot = color;
                }
            }
        }
        theme
    }

    /// The colour of an entry of the 256-colour palette, the first sixteen being the theme's.
    pub fn indexed(&self, index: u8) -> Rgb {
        let index = usize::from(index);
        if index < 16 {
            return self.ansi[index];
        }
        if index < 232 {
            let cube = index - 16;
            return rgb(cube_level(cube / 36), cube_level(cube / 6 % 6), cube_level(cube % 6));
        }
        let level = (8 + (index - 232) * 10) as u8;
        rgb(level, level, level)
    }

    /// The colour a cell's colour stands for. A colour the program set itself with OSC 4, 10, 11
    /// or 12 wins over the theme's.
    pub fn resolve(&self, color: Color, overrides: &Colors) -> Rgb {
        match color {
            Color::Spec(spec) => spec,
            Color::Indexed(index) => match overrides[usize::from(index)] {
                Some(overridden) => overridden,
                None => self.indexed(index),
            },
            Color::Named(named) => self.resolve_named(named, overrides),
        }
    }

    /// A named colour: one of the sixteen, the default foreground and background, the cursor, or
    /// a dim variant of one of those.
    fn resolve_named(&self, named: NamedColor, overrides: &Colors) -> Rgb {
        if let Some(overridden) = overrides[named as usize] {
            return overridden;
        }
        match named {
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimForeground => dimmed(self.foreground),
            _ => self.resolve_ansi_name(named),
        }
    }

    /// The sixteen colours by name, and the dim ones as a fainter normal colour.
    fn resolve_ansi_name(&self, named: NamedColor) -> Rgb {
        let number = named as usize;
        if number < 16 {
            return self.ansi[number];
        }
        let dim_start = NamedColor::DimBlack as usize;
        if number >= dim_start && number < dim_start + 8 {
            return dimmed(self.ansi[number - dim_start]);
        }
        self.foreground
    }
}

/// A colour two thirds as bright, which is what the dim attribute does.
pub fn dimmed(color: Rgb) -> Rgb {
    let scale = |channel: u8| (u16::from(channel) * 2 / 3) as u8;
    rgb(scale(color.r), scale(color.g), scale(color.b))
}

/// One step of the colour cube's six levels: 0, then 95 and up by 40.
fn cube_level(step: usize) -> u8 {
    if step == 0 {
        return 0;
    }
    (55 + step * 40) as u8
}

/// A colour from `#rrggbb`.
fn parse_rgb(text: &str) -> Option<Rgb> {
    let [red, green, blue, _] = parse_rgba(text)?;
    Some(rgb(red, green, blue))
}

/// A colour from `#rrggbb` or `#rrggbbaa`, opaque when there is no alpha.
fn parse_rgba(text: &str) -> Option<[u8; 4]> {
    let digits = text.strip_prefix('#')?;
    let value = u32::from_str_radix(digits, 16).ok()?;
    match digits.len() {
        6 => Some([(value >> 16) as u8, (value >> 8) as u8, value as u8, 0xff]),
        8 => Some([(value >> 24) as u8, (value >> 16) as u8, (value >> 8) as u8, value as u8]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_theme_prop_replaces_what_it_names_and_keeps_the_rest() {
        let theme = TerminalTheme::from_json(&json!({
            "background": "#ffffff",
            "selection": "#11223344",
            "ansi": ["#010203"],
        }));
        assert_eq!(theme.background, rgb(255, 255, 255));
        assert_eq!(theme.selection, [0x11, 0x22, 0x33, 0x44]);
        assert_eq!(theme.ansi[0], rgb(1, 2, 3));
        assert_eq!(theme.ansi[1], TerminalTheme::default().ansi[1]);
        assert_eq!(theme.foreground, TerminalTheme::default().foreground);
    }

    #[test]
    fn the_256_colour_palette_has_a_cube_and_a_grey_ramp() {
        let theme = TerminalTheme::default();
        assert_eq!(theme.indexed(1), theme.ansi[1]);
        assert_eq!(theme.indexed(16), rgb(0, 0, 0));
        assert_eq!(theme.indexed(21), rgb(0, 0, 255));
        assert_eq!(theme.indexed(196), rgb(255, 0, 0));
        assert_eq!(theme.indexed(231), rgb(255, 255, 255));
        assert_eq!(theme.indexed(232), rgb(8, 8, 8));
        assert_eq!(theme.indexed(255), rgb(238, 238, 238));
    }

    #[test]
    fn named_colours_resolve_through_the_theme() {
        let theme = TerminalTheme::default();
        let overrides = Colors::default();
        assert_eq!(theme.resolve(Color::Named(NamedColor::Red), &overrides), theme.ansi[1]);
        assert_eq!(theme.resolve(Color::Named(NamedColor::BrightBlue), &overrides), theme.ansi[12]);
        assert_eq!(theme.resolve(Color::Named(NamedColor::Foreground), &overrides), theme.foreground);
        assert_eq!(theme.resolve(Color::Named(NamedColor::Background), &overrides), theme.background);
        assert_eq!(theme.resolve(Color::Named(NamedColor::DimRed), &overrides), dimmed(theme.ansi[1]));
        assert_eq!(theme.resolve(Color::Spec(rgb(9, 8, 7)), &overrides), rgb(9, 8, 7));
    }

    #[test]
    fn a_colour_the_program_set_wins() {
        let theme = TerminalTheme::default();
        let mut overrides = Colors::default();
        overrides[NamedColor::Background as usize] = Some(rgb(1, 1, 1));
        overrides[5] = Some(rgb(2, 2, 2));
        assert_eq!(theme.resolve(Color::Named(NamedColor::Background), &overrides), rgb(1, 1, 1));
        assert_eq!(theme.resolve(Color::Indexed(5), &overrides), rgb(2, 2, 2));
    }
}
