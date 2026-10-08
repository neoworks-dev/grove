import { describe, it, expect } from 'bun:test'
import { createTerminalNoticeGrouper } from '../src/renderer/src/plugins/terminalNotices'

describe('terminal notices', () => {
  it('turns a burst of terminals into one notice per client', async () => {
    const notices: string[] = []
    const notice = createTerminalNoticeGrouper((message) => notices.push(message), 20)
    for (let index = 0; index < 13; index += 1) notice('Process Compose')
    notice('Some App')
    expect(notices).toEqual([])
    await Bun.sleep(40)
    expect(notices.sort()).toEqual(['Process Compose opened 13 terminals', 'Some App opened a terminal'])
  })

  it('starts a new notice once a burst is over', async () => {
    const notices: string[] = []
    const notice = createTerminalNoticeGrouper((message) => notices.push(message), 20)
    notice('Process Compose')
    await Bun.sleep(40)
    notice('Process Compose')
    notice('Process Compose')
    await Bun.sleep(40)
    expect(notices).toEqual(['Process Compose opened a terminal', 'Process Compose opened 2 terminals'])
  })
})
