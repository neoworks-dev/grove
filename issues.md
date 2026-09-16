# Issues

## Open

- **Accept-edits mode doesn't accept edits** — with accept-edits mode on, agent writes still open the review overlay instead of being auto-approved.
- **Pane `...` overflow button needs a redesign** — the whole thing is bad, not just its placement.
  - It sits on top of whatever is at the end of the tab strip, which makes the terminal pane's new-terminal plus button, the close button of the last buffer in the editor pane and the worktrees view's plus button all unclickable.
  - "Close pane" is the last entry in the menu, so it always needs a scroll to reach.
  - Direction: go for the OS-window feel — title-bar style controls on the pane rather than one overflow menu.
- **Top bar still has an agent button** — leftover from before panes; question whether it's still needed.
- **Spawning panes needs a better entry point** — plus buttons only appear on the dividers between panes, never on the outer edges of the layout, so a new pane can't be added at an edge.
- **Left sidebar reuses the wrong pane** — open the explorer, move that pane somewhere else, then launch another view from the left sidebar: it opens into the explorer's pane and overwrites the explorer instead of getting its own.
  Idea: make the left sidebar behave like a desktop taskbar — list the panes that are currently open (click to focus) alongside the ones that can still be opened. Also, terminal isn't in the left sidebar at all right now.
- **No settings button in the left sidebar** — the bottom of the sidebar rail should hold a settings button.
- **Leader hint gets stranded on focus change** — press the leader key, then focus a different window: the hint moves out of the old window but the chord chain breaks, leaving the hint floating in the new pane forever with nothing to dismiss it.
- **Chat attachments are dropped** — an attached image isn't rendered in the transcript and never reaches the harness.
- **Composer toolbar squashes at narrow widths** — the row of buttons under the composer stays fully expanded when the chat pane is small; needs a fold/overflow behaviour that kicks in as the pane narrows.
- **Stop button in the composer is too bulky** — should be icon-only, no label.
- **Nvim buffer stays blank after an accepted file creation** — agent creates a file, review mode opens, user accepts, file is written to disk, but the nvim buffer doesn't pick up the new contents. Shows a blank file until the app is restarted.
- **No overflow indicator on the buffer tab strip** — scrolling the tabs left/right gives no sign of how many buffers are open or whether more exist off-screen in either direction.
- **Terminal takes no mouse input** — clicks/scroll/selection in the terminal pane don't reach the shell.
- **Auto-shrunk pane is closed on the first resize drag** — a pane the layout already squeezed very small is instantly removed as soon as you grab its divider, presumably because it's already under the close threshold before the drag moves.
- **Nvim input goes laggy over a session** — typing latency builds up after cycling through a bunch of buffers.
- **Remove the setup/workspace plugin** — `kernel/plugins/setup/` should go away entirely, not be reworked.
- **Extensions view needs a rework** — wrong background colour, no clear separation between entries in the list, and no information shown about an extension. Clicking one should open a detail page like VS Code does.
- **Worktrees view: plus button covered, background wrong, behaviour unverified** — its plus icon is under the pane's `...` button (same overlay bug as above), the background colour is wrong and the view looks ugly. Also needs investigation into whether worktrees actually work and how.
- **Back/forward icons in the top left aren't useful** — replace them with a proper menu bar (File, Edit, …) in that spot. The menu already exists as the `...` button in the top right, so move that to the left rather than building a second one.
- **App menu dropdown doesn't feel right** — needs an open/close animation.
- **Folder icons are ugly** — swap the explorer's icon set for a better one.
- **Bash input in the composer is bare** — needs nicer syntax highlighting (maybe a heavier font weight) and completion/intellisense.
- **Minimap is missing colours** — the file-overview strip on the right of the editor renders a lot of the text uncoloured instead of picking up the syntax highlighting.
- **Swap the default code theme for Catppuccin Mocha** — current one isn't liked.
- **Add smooth scrolling to nvim** — editor scroll currently jumps line by line.
- **Cursor is barely visible** — it takes the colour of the token underneath it instead of a fixed contrasting colour.
- **No same-token highlighting** — the user's own nvim setup highlights and underlines every other occurrence of the token under the cursor; the bundled config should do the same.
- **No indent / bracket-pair guides** — the vertical lines marking each indentation level and the enclosing scope (indent-blankline style) are missing from the editor.
- **Cmdline should look like noice.nvim** — the user's own nvim uses noice for the command line; the bundled config should get the same treatment.
- **Diagnostics only underline** — no inline virtual text. Should render the message at the end of the line in the severity colour with a leading dot, like the user's own nvim.
- **Diagnostics panel font is wrong** — should be the nerd font. More generally, every monospaced surface in the app should use exactly the same font as nvim so the UI matches stylistically.
- **Nvim right-click menu is drawn inside the grid** — the context menu renders as nvim cells rather than a real HTML popup, so its entries can't be clicked.
