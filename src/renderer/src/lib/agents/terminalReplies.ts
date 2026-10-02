// What xterm sends that nobody typed.
//
// A terminal answers the questions programs ask it: what it is (device
// attributes), where the cursor is, what colour its background has. A
// command's own terminal in main already answers them, so the agent terminal
// in the renderer, drawing the same output, would answer every one a second
// time, into the command's input. Those are dropped; everything else xterm
// hands over is the user typing.

// Device attributes (primary, secondary), cursor position and status reports,
// mode reports, and OSC and DCS replies.
const REPLY_PATTERNS = [
  /^\u001b\[[?>=]?[\d;]*c$/,
  /^\u001b\[\??\d+;\d+R$/,
  /^\u001b\[\??\d*n$/,
  /^\u001b\[\??[\d;]*\$y$/,
  /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)$/,
  /^\u001bP[^\u001b]*\u001b\\$/
]

/** Whether data from xterm is its answer to a program's question rather than a keystroke. */
export function isTerminalReply(data: string): boolean {
  return REPLY_PATTERNS.some((pattern) => pattern.test(data))
}
