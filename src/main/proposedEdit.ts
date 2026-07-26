// What a pending file-write tool call would produce, applied the way the agent's
// own tools apply it. Lets a gated (not-yet-executed) Write/Edit be diffed and
// reviewed before anything touches disk.

/** Tools whose input describes a file rewrite we can reconstruct. */
export const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/** Apply an Edit-style string replacement the way the agent tools do. */
function applyStringEdit(
  text: string,
  oldString: unknown,
  newString: unknown,
  replaceAll: boolean
): string {
  if (typeof oldString !== 'string' || oldString.length === 0) return text
  const replacement = typeof newString === 'string' ? newString : ''
  if (replaceAll) return text.split(oldString).join(replacement)
  return text.replace(oldString, replacement)
}

/**
 * Content the tool call would leave on disk, or null when the tool is not a
 * file write we can model.
 */
export function proposedContent(
  toolName: string,
  input: Record<string, unknown>,
  original: string
): string | null {
  if (toolName === 'Write') {
    return typeof input.content === 'string' ? input.content : null
  }
  if (toolName === 'Edit') {
    return applyStringEdit(original, input.old_string, input.new_string, input.replace_all === true)
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).reduce(
      (accumulated, edit) =>
        applyStringEdit(accumulated, edit.old_string, edit.new_string, edit.replace_all === true),
      original
    )
  }
  return null
}
