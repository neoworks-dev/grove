// Deterministic per-worktree port allocation.
//
// Each worktree gets a slot. Its port block is:
//   base = start + slot * countPerWorktree
//   PORT_0 = base, PORT_1 = base + 1, ...
// Slots are stable and persisted so a worktree keeps its ports across restarts.

export interface PortConfig {
  start: number
  countPerWorktree: number
}

// Compute the port list for a given slot.
export function portsForSlot(config: PortConfig, slot: number): number[] {
  const base = config.start + slot * config.countPerWorktree
  const ports: number[] = []
  for (let index = 0; index < config.countPerWorktree; index += 1) {
    ports.push(base + index)
  }
  return ports
}

// Given the slots already in use, return the lowest free slot.
export function nextFreeSlot(usedSlots: number[]): number {
  const used = new Set(usedSlots)
  let slot = 0
  while (used.has(slot)) {
    slot += 1
  }
  return slot
}

// Assign slots to worktrees, honoring existing assignments and filling gaps
// deterministically for any worktree that lacks one.
export function assignSlots(
  existing: Record<string, number>,
  worktreeIds: string[]
): Record<string, number> {
  const result: Record<string, number> = {}
  const usedSlots: number[] = []

  for (const id of worktreeIds) {
    if (existing[id] !== undefined) {
      result[id] = existing[id]
      usedSlots.push(existing[id])
    }
  }

  for (const id of worktreeIds) {
    if (result[id] === undefined) {
      const slot = nextFreeSlot(usedSlots)
      result[id] = slot
      usedSlots.push(slot)
    }
  }

  return result
}
