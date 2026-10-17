//! Box-drawing and block characters drawn as rectangles instead of from the font. A font's glyphs
//! for these rarely fill the cell exactly, which leaves gaps between the lines of a frame drawn
//! by a program such as `htop`, `btop` or `lazygit`. Drawing them from the cell's own size makes
//! the lines meet. Characters this does not cover, such as the double lines and the diagonals,
//! are left to the font.

/// A rectangle inside a cell, in pixels from the cell's top left, and how opaque it is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub alpha: f32,
}

/// How heavy one arm of a box-drawing character is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Weight {
    None,
    Light,
    Heavy,
}

/// The four arms of a box-drawing character.
#[derive(Clone, Copy, Debug)]
struct Arms {
    left: Weight,
    right: Weight,
    up: Weight,
    down: Weight,
}

/// Whether a character is drawn here rather than by the font.
pub fn is_drawn(character: char) -> bool {
    arms_of(character).is_some() || block_rects(character, 1.0, 1.0).is_some()
}

/// The rectangles that draw a character in a cell of the given size, or none for a character
/// this does not draw.
pub fn rects_for(character: char, cell_width: f32, cell_height: f32) -> Option<Vec<GlyphRect>> {
    if let Some(arms) = arms_of(character) {
        return Some(line_rects(arms, cell_width, cell_height));
    }
    block_rects(character, cell_width, cell_height)
}

/// One digit of the table below: 0 for no arm, 1 for light, 2 for heavy.
const fn weight(digit: u8) -> Weight {
    match digit {
        0 => Weight::None,
        1 => Weight::Light,
        _ => Weight::Heavy,
    }
}

/// The arms of a box-drawing character as left, right, up and down weights, or none for one that
/// has a double line or is a diagonal.
fn arms_of(character: char) -> Option<Arms> {
    let code = u32::from(character);
    if !(0x2500..=0x257f).contains(&code) {
        return None;
    }
    let (left, right, up, down) = ARMS[(code - 0x2500) as usize];
    if left > 2 || right > 2 || up > 2 || down > 2 {
        return None;
    }
    Some(Arms { left: weight(left), right: weight(right), up: weight(up), down: weight(down) })
}

/// Left, right, up and down weights of U+2500 to U+257F. 0 is no arm, 1 light, 2 heavy and 9 a
/// double line or a diagonal, which are not drawn here. Dashed lines are drawn solid.
#[rustfmt::skip]
const ARMS: [(u8, u8, u8, u8); 128] = [
    (1,1,0,0), (2,2,0,0), (0,0,1,1), (0,0,2,2), (1,1,0,0), (2,2,0,0), (0,0,1,1), (0,0,2,2),
    (1,1,0,0), (2,2,0,0), (0,0,1,1), (0,0,2,2), (0,1,0,1), (0,2,0,1), (0,1,0,2), (0,2,0,2),
    (1,0,0,1), (2,0,0,1), (1,0,0,2), (2,0,0,2), (0,1,1,0), (0,2,1,0), (0,1,2,0), (0,2,2,0),
    (1,0,1,0), (2,0,1,0), (1,0,2,0), (2,0,2,0), (0,1,1,1), (0,2,1,1), (0,1,2,1), (0,1,1,2),
    (0,1,2,2), (0,2,2,1), (0,2,1,2), (0,2,2,2), (1,0,1,1), (2,0,1,1), (1,0,2,1), (1,0,1,2),
    (1,0,2,2), (2,0,2,1), (2,0,1,2), (2,0,2,2), (1,1,0,1), (2,1,0,1), (1,2,0,1), (2,2,0,1),
    (1,1,0,2), (2,1,0,2), (1,2,0,2), (2,2,0,2), (1,1,1,0), (2,1,1,0), (1,2,1,0), (2,2,1,0),
    (1,1,2,0), (2,1,2,0), (1,2,2,0), (2,2,2,0), (1,1,1,1), (2,1,1,1), (1,2,1,1), (2,2,1,1),
    (1,1,2,1), (1,1,1,2), (1,1,2,2), (2,1,2,1), (1,2,2,1), (2,1,1,2), (1,2,1,2), (2,2,2,1),
    (2,2,1,2), (2,1,2,2), (1,2,2,2), (2,2,2,2), (1,1,0,0), (2,2,0,0), (0,0,1,1), (0,0,2,2),
    (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9),
    (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9),
    (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9),
    (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (9,9,9,9), (0,1,0,1), (1,0,0,1), (1,0,1,0),
    (0,1,1,0), (9,9,9,9), (9,9,9,9), (9,9,9,9), (1,0,0,0), (0,0,1,0), (0,1,0,0), (0,0,0,1),
    (2,0,0,0), (0,0,2,0), (0,2,0,0), (0,0,0,2), (1,2,0,0), (0,0,1,2), (2,1,0,0), (0,0,2,1),
];

/// The thickness of a light line in a cell of this height, in whole pixels.
fn light_thickness(cell_height: f32) -> f32 {
    (cell_height / 14.0).round().max(1.0)
}

/// The thickness of one arm.
fn thickness(weight: Weight, light: f32) -> f32 {
    match weight {
        Weight::None => 0.0,
        Weight::Light => light,
        Weight::Heavy => light * 2.0,
    }
}

/// The rectangles of a box-drawing character: each arm runs from the cell's edge to just past the
/// middle, so arms of one character meet without a gap or a notch.
fn line_rects(arms: Arms, cell_width: f32, cell_height: f32) -> Vec<GlyphRect> {
    let light = light_thickness(cell_height);
    let horizontal = thickness(arms.left, light).max(thickness(arms.right, light));
    let vertical = thickness(arms.up, light).max(thickness(arms.down, light));
    let across = if horizontal > 0.0 { horizontal } else { vertical };
    let along = if vertical > 0.0 { vertical } else { horizontal };
    let line_top = ((cell_height - across) / 2.0).floor();
    let line_left = ((cell_width - along) / 2.0).floor();
    let solid = |x: f32, y: f32, width: f32, height: f32| GlyphRect { x, y, width, height, alpha: 1.0 };
    let mut rects = Vec::new();
    if arms.left != Weight::None {
        let height = thickness(arms.left, light);
        let top = ((cell_height - height) / 2.0).floor();
        rects.push(solid(0.0, top, line_left + along, height));
    }
    if arms.right != Weight::None {
        let height = thickness(arms.right, light);
        let top = ((cell_height - height) / 2.0).floor();
        rects.push(solid(line_left, top, cell_width - line_left, height));
    }
    if arms.up != Weight::None {
        let width = thickness(arms.up, light);
        let left = ((cell_width - width) / 2.0).floor();
        rects.push(solid(left, 0.0, width, line_top + across));
    }
    if arms.down != Weight::None {
        let width = thickness(arms.down, light);
        let left = ((cell_width - width) / 2.0).floor();
        rects.push(solid(left, line_top, width, cell_height - line_top));
    }
    rects
}

/// The rectangles of a block element or shade, or none for another character.
fn block_rects(character: char, cell_width: f32, cell_height: f32) -> Option<Vec<GlyphRect>> {
    let code = u32::from(character);
    if !(0x2580..=0x259f).contains(&code) {
        return None;
    }
    let width = cell_width;
    let height = cell_height;
    let rect = |x: f32, y: f32, w: f32, h: f32, alpha: f32| GlyphRect { x, y, width: w, height: h, alpha };
    let eighth_height = (height / 8.0).round();
    let eighth_width = (width / 8.0).round();
    let half_height = (height / 2.0).round();
    let half_width = (width / 2.0).round();
    let rects = match code {
        0x2580 => vec![rect(0.0, 0.0, width, half_height, 1.0)],
        0x2581..=0x2588 => {
            let filled = ((height * (code - 0x2580) as f32) / 8.0).round();
            vec![rect(0.0, height - filled, width, filled, 1.0)]
        }
        0x2589..=0x258f => {
            let filled = ((width * (0x2590 - code) as f32) / 8.0).round();
            vec![rect(0.0, 0.0, filled, height, 1.0)]
        }
        0x2590 => vec![rect(half_width, 0.0, width - half_width, height, 1.0)],
        0x2591 => vec![rect(0.0, 0.0, width, height, 0.25)],
        0x2592 => vec![rect(0.0, 0.0, width, height, 0.5)],
        0x2593 => vec![rect(0.0, 0.0, width, height, 0.75)],
        0x2594 => vec![rect(0.0, 0.0, width, eighth_height, 1.0)],
        0x2595 => vec![rect(width - eighth_width, 0.0, eighth_width, height, 1.0)],
        _ => quadrants(code, width, height, half_width, half_height),
    };
    Some(rects)
}

/// The quarter blocks U+2596 to U+259F, from which quarters each has.
fn quadrants(code: u32, width: f32, height: f32, half_width: f32, half_height: f32) -> Vec<GlyphRect> {
    // Upper left, upper right, lower left, lower right.
    let which: [bool; 4] = match code {
        0x2596 => [false, false, true, false],
        0x2597 => [false, false, false, true],
        0x2598 => [true, false, false, false],
        0x2599 => [true, false, true, true],
        0x259a => [true, false, false, true],
        0x259b => [true, true, true, false],
        0x259c => [true, true, false, true],
        0x259d => [false, true, false, false],
        0x259e => [false, true, true, false],
        _ => [false, true, true, true],
    };
    let mut rects = Vec::new();
    for (index, filled) in which.iter().enumerate() {
        if !filled {
            continue;
        }
        let (x, quarter_width) = if index % 2 == 0 { (0.0, half_width) } else { (half_width, width - half_width) };
        let (y, quarter_height) = if index < 2 { (0.0, half_height) } else { (half_height, height - half_height) };
        rects.push(GlyphRect { x, y, width: quarter_width, height: quarter_height, alpha: 1.0 });
    }
    rects
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The union of the rectangles on a grid of pixels, for looking at what a character covers.
    fn covered(character: char, width: usize, height: usize) -> Vec<Vec<bool>> {
        let rects = rects_for(character, width as f32, height as f32).expect("a drawn character");
        let mut pixels = vec![vec![false; width]; height];
        for rect in rects {
            for y in rect.y as usize..(rect.y + rect.height) as usize {
                for x in rect.x as usize..(rect.x + rect.width) as usize {
                    pixels[y][x] = true;
                }
            }
        }
        pixels
    }

    #[test]
    fn a_horizontal_line_runs_the_width_of_the_cell_with_no_gap() {
        let pixels = covered('\u{2500}', 8, 16);
        let rows_with_line: Vec<usize> = (0..16).filter(|row| pixels[*row].iter().any(|filled| *filled)).collect();
        assert_eq!(rows_with_line.len(), 1);
        assert!(pixels[rows_with_line[0]].iter().all(|filled| *filled));
    }

    #[test]
    fn a_vertical_line_runs_the_height_of_the_cell() {
        let pixels = covered('\u{2502}', 8, 16);
        let columns_with_line: Vec<usize> = (0..8).filter(|column| pixels[0][*column]).collect();
        assert_eq!(columns_with_line.len(), 1);
        assert!((0..16).all(|row| pixels[row][columns_with_line[0]]));
    }

    #[test]
    fn a_corner_joins_its_arms() {
        let pixels = covered('\u{250c}', 8, 16);
        // The arms go right and down, so the top left of the cell is empty and the centre is filled.
        assert!(!pixels[0][0]);
        assert!(!pixels[15][0]);
        assert!(pixels[7][4]);
        assert!(pixels[15][3] || pixels[15][4]);
        assert!(pixels[7][7]);
    }

    #[test]
    fn a_heavy_line_is_thicker_than_a_light_one() {
        let thin: usize = covered('\u{2500}', 8, 16).iter().filter(|row| row[0]).count();
        let thick: usize = covered('\u{2501}', 8, 16).iter().filter(|row| row[0]).count();
        assert!(thick > thin);
    }

    #[test]
    fn blocks_fill_their_part_of_the_cell() {
        let full = covered('\u{2588}', 8, 16);
        assert!(full.iter().all(|row| row.iter().all(|filled| *filled)));
        let lower_half = covered('\u{2584}', 8, 16);
        assert!(!lower_half[7][0] && lower_half[8][0] && lower_half[15][7]);
        let left_half = covered('\u{258c}', 8, 16);
        assert!(left_half[0][3] && !left_half[0][4]);
        let upper_left = covered('\u{2598}', 8, 16);
        assert!(upper_left[0][0] && !upper_left[0][7] && !upper_left[15][0]);
    }

    #[test]
    fn a_shade_is_the_whole_cell_at_part_opacity() {
        let rects = rects_for('\u{2592}', 8.0, 16.0).expect("a shade");
        assert_eq!(rects, vec![GlyphRect { x: 0.0, y: 0.0, width: 8.0, height: 16.0, alpha: 0.5 }]);
    }

    #[test]
    fn the_table_matches_unicode_for_some_known_characters() {
        let arms = |character: char| {
            let arms = arms_of(character).expect("arms");
            (arms.left, arms.right, arms.up, arms.down)
        };
        use Weight::{Heavy, Light, None as No};
        assert_eq!(arms('\u{250c}'), (No, Light, No, Light));
        assert_eq!(arms('\u{2510}'), (Light, No, No, Light));
        assert_eq!(arms('\u{2514}'), (No, Light, Light, No));
        assert_eq!(arms('\u{2518}'), (Light, No, Light, No));
        assert_eq!(arms('\u{251c}'), (No, Light, Light, Light));
        assert_eq!(arms('\u{2524}'), (Light, No, Light, Light));
        assert_eq!(arms('\u{252c}'), (Light, Light, No, Light));
        assert_eq!(arms('\u{2534}'), (Light, Light, Light, No));
        assert_eq!(arms('\u{253c}'), (Light, Light, Light, Light));
        assert_eq!(arms('\u{254b}'), (Heavy, Heavy, Heavy, Heavy));
        assert_eq!(arms('\u{256d}'), (No, Light, No, Light));
        assert_eq!(arms('\u{256e}'), (Light, No, No, Light));
        assert_eq!(arms('\u{256f}'), (Light, No, Light, No));
        assert_eq!(arms('\u{2570}'), (No, Light, Light, No));
        assert_eq!(arms('\u{2574}'), (Light, No, No, No));
        assert_eq!(arms('\u{257b}'), (No, No, No, Heavy));
        assert_eq!(arms('\u{257c}'), (Light, Heavy, No, No));
        assert_eq!(arms('\u{257f}'), (No, No, Heavy, Light));
    }

    #[test]
    fn double_lines_and_text_are_left_to_the_font() {
        assert!(!is_drawn('\u{2550}'));
        assert!(!is_drawn('\u{2571}'));
        assert!(!is_drawn('a'));
        assert!(is_drawn('\u{2500}'));
        assert!(is_drawn('\u{2580}'));
        assert!(is_drawn('\u{256d}'));
    }
}
