// Whether a command has stopped to wait for someone to type: a `y/N`, a
// password, git asking who you are.
//
// On Linux the kernel says so exactly. Every process a command started shares
// its session, and one blocked reading the command's own input — the pty, or
// /dev/tty, which is the same device — shows the read in /proc/<pid>/syscall
// with the descriptor it reads from. No guessing from what the output looks
// like. Anywhere else this answers false, and a waiting command is only found
// by its timeout.

import { readdir, readFile, readlink } from 'node:fs/promises'

// The syscalls that block reading a descriptor given as their first argument,
// by architecture: read, pread64, readv, and splice and copy_file_range, which
// GNU cat uses on pipes.
const READ_SYSCALLS: Record<string, number[]> = {
  x64: [0, 17, 19, 275, 326],
  arm64: [63, 65, 67, 76, 285]
}

/** The fields of /proc/<pid>/stat this needs. */
export interface ProcessStat {
  pid: number
  session: number
}

/** Parses /proc/<pid>/stat. The command name is in parentheses and may hold spaces or parentheses itself. */
export function parseStat(text: string): ProcessStat | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const pid = Number.parseInt(text, 10)
  // After the name: state, ppid, pgrp, session, …
  const fields = text.slice(close + 2).split(' ')
  const session = Number.parseInt(fields[3], 10)
  if (!Number.isFinite(pid) || !Number.isFinite(session)) return null
  return { pid, session }
}

/**
 * The descriptor a process is blocked reading, from /proc/<pid>/syscall, or
 * null when it is not in a read. `running` there means it is not blocked at all.
 */
export function readingDescriptor(syscallText: string, arch: string = process.arch): number | null {
  const reads = READ_SYSCALLS[arch]
  if (!reads) return null
  const [number, firstArgument] = syscallText.trim().split(' ')
  if (!reads.includes(Number.parseInt(number, 10))) return null
  const descriptor = Number.parseInt(firstArgument, 16)
  if (!Number.isFinite(descriptor)) return null
  return descriptor
}

/**
 * Whether a process in the session `leader` leads is blocked reading from the
 * same place the leader's standard input comes from.
 */
export async function isWaitingForInput(leader: number, procRoot = '/proc'): Promise<boolean> {
  if (process.platform !== 'linux') return false
  const input = await readlink(`${procRoot}/${leader}/fd/0`).catch(() => null)
  if (input === null) return false
  const members = await sessionMembers(leader, procRoot)
  for (const pid of members) {
    if (await readsFrom(pid, input, procRoot)) return true
  }
  return false
}

/** Every process in the session `leader` leads, the leader included. */
async function sessionMembers(leader: number, procRoot: string): Promise<number[]> {
  const entries = await readdir(procRoot).catch(() => [] as string[])
  const pids = entries.filter((entry) => /^\d+$/.test(entry))
  const stats = await Promise.all(pids.map((pid) => readStat(pid, procRoot)))
  return stats.filter((stat) => stat !== null && stat.session === leader).map((stat) => stat!.pid)
}

async function readStat(pid: string, procRoot: string): Promise<ProcessStat | null> {
  const text = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(() => null)
  if (text === null) return null
  return parseStat(text)
}

/** Whether `pid` is blocked in a read on a descriptor that points at `input`. */
async function readsFrom(pid: number, input: string, procRoot: string): Promise<boolean> {
  const syscall = await readFile(`${procRoot}/${pid}/syscall`, 'utf8').catch(() => null)
  if (syscall === null) return false
  const descriptor = readingDescriptor(syscall)
  if (descriptor === null) return false
  const target = await readlink(`${procRoot}/${pid}/fd/${descriptor}`).catch(() => null)
  return target === input
}
