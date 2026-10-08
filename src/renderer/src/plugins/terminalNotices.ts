// The notice that an API client opened a terminal (the visibility mitigation
// for terminal.exec), grouped by burst. A plugin like Process Compose opens a
// terminal per process, a dozen at once on "Start all"; one toast per client
// and burst still tells the user who is running commands without burying them.

// How long a client's terminals keep adding to the same notice.
const BURST_MS = 600

/**
 * Returns the function to call each time a client opens a terminal. Calls for
 * one client within BURST_MS of each other become a single `notify`, sent once
 * the burst is over, with how many terminals it opened.
 */
export function createTerminalNoticeGrouper(
  notify: (message: string) => void,
  burstMs: number = BURST_MS
): (clientName: string) => void {
  const bursts = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>()
  return (clientName) => {
    const burst = bursts.get(clientName)
    if (burst) clearTimeout(burst.timer)
    const count = (burst?.count ?? 0) + 1
    const timer = setTimeout(() => {
      bursts.delete(clientName)
      notify(noticeFor(clientName, count))
    }, burstMs)
    bursts.set(clientName, { count, timer })
  }
}

/** "Process Compose opened a terminal", or "… opened 13 terminals". */
function noticeFor(clientName: string, count: number): string {
  if (count === 1) return `${clientName} opened a terminal`
  return `${clientName} opened ${count} terminals`
}
