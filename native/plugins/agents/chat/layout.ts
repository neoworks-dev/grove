// What the item renderers share.

/** Width of the glyph column (bullet, spinner, ✓) that results and text hang from. */
export const GUTTER = 20;

/**
 * Pixels an item takes from the chat's width before its content starts: the item's padding on both
 * sides (the large space, 16) and the glyph column.
 */
export const ITEM_INSET = GUTTER + 2 * 16;

/** Lines of a diff or code a question shows before its buttons (Ctrl-O shows all). */
export const PREVIEW_LINES = 12;
