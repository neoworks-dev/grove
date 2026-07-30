// Decides whether an editor pane has anything worth showing. Kept apart from
// NvimPane so the rule is testable and stated in one place.

export interface EditorContent {
  // Grove editor tabs for the selected worktree.
  tabCount: number
  // Windows in this pane's nvim that show a named buffer.
  visibleBufferCount: number
  // A review is driving this pane's nvim windows directly, without grove tabs.
  reviewOwnsPane: boolean
}

/**
 * True when the pane should render nvim, false when it should render its empty
 * state instead. Tabs are consulted alongside the live buffer count so the pane
 * doesn't blink through the empty state between opening a tab and nvim editing
 * the file.
 */
export function editorHasContent(content: EditorContent): boolean {
  if (content.reviewOwnsPane) return true
  if (content.visibleBufferCount > 0) return true
  return content.tabCount > 0
}
