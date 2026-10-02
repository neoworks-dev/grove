// Whether a command has stopped to wait for someone to type: a `y/N`, a
// password, git asking who you are.
//
// On Linux the kernel says so. Every process a command started shares its
// session, and /proc/<pid>/syscall shows what each one is blocked in, with its
// arguments. A process blocked reading the command's own input — the pty, or
// /dev/tty, which is the same device — is waiting for someone to type. So is
// one waiting in poll, select or epoll on a set of descriptors that includes
// the input: that is how line editors (fish's, Node's readline) wait for a key.
// A set that also holds a socket is a server that happens to read its input
// too, not a prompt, and does not count. Anywhere else this answers false, and
// a waiting command is only found by its timeout.

import { open, readdir, readFile, readlink } from 'node:fs/promises'

/** What a blocked process is waiting on, as far as telling input waits apart needs. */
export type BlockedOn =
  | { kind: 'read'; descriptor: number }
  | { kind: 'poll'; address: number; count: number }
  | { kind: 'select'; count: number; address: number }
  | { kind: 'epoll'; descriptor: number }

type SyscallKind = BlockedOn['kind']

// Syscall numbers by architecture. read, pread64, readv, splice and
// copy_file_range block on the descriptor in their first argument; GNU cat
// uses splice on pipes.
const SYSCALLS: Record<string, Record<number, SyscallKind>> = {
  x64: {
    0: 'read',
    17: 'read',
    19: 'read',
    275: 'read',
    326: 'read',
    7: 'poll',
    271: 'poll',
    23: 'select',
    270: 'select',
    232: 'epoll',
    281: 'epoll',
    441: 'epoll'
  },
  arm64: {
    63: 'read',
    65: 'read',
    67: 'read',
    76: 'read',
    285: 'read',
    73: 'poll',
    72: 'select',
    22: 'epoll',
    441: 'epoll'
  }
}

// A select set this large is not a prompt, and reading it would be a waste.
const MAX_WATCHED = 4096

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
 * What a process is blocked in, from /proc/<pid>/syscall, or null when it is
 * in nothing that waits on input. `running` there means it is not blocked.
 */
export function blockedOn(syscallText: string, arch: string = process.arch): BlockedOn | null {
  const table = SYSCALLS[arch]
  if (!table) return null
  const [number, ...hexArguments] = syscallText.trim().split(' ')
  const kind = table[Number.parseInt(number, 10)]
  if (!kind) return null
  const args = hexArguments.map((argument) => Number.parseInt(argument, 16))
  if (args.length < 2 || args.some((argument) => !Number.isFinite(argument))) return null
  if (kind === 'read') return { kind, descriptor: args[0] }
  if (kind === 'epoll') return { kind, descriptor: args[0] }
  if (kind === 'poll') return { kind, address: args[0], count: args[1] }
  return { kind, count: args[0], address: args[1] }
}

/** The descriptors in a `struct pollfd` array: an int, then two shorts, per entry. */
export function pollDescriptors(memory: Buffer): number[] {
  const descriptors: number[] = []
  for (let offset = 0; offset + 8 <= memory.length; offset += 8) {
    const descriptor = memory.readInt32LE(offset)
    if (descriptor >= 0) descriptors.push(descriptor)
  }
  return descriptors
}

/** The descriptors set in an `fd_set` bitmap of `count` bits. */
export function selectDescriptors(memory: Buffer, count: number): number[] {
  const descriptors: number[] = []
  for (let descriptor = 0; descriptor < count && descriptor / 8 < memory.length; descriptor++) {
    const byte = memory[Math.floor(descriptor / 8)]
    if (byte & (1 << descriptor % 8)) descriptors.push(descriptor)
  }
  return descriptors
}

/** The descriptors an epoll instance watches, from its /proc/<pid>/fdinfo entry. */
export function epollDescriptors(fdinfo: string): number[] {
  const descriptors: number[] = []
  for (const match of fdinfo.matchAll(/^tfd:\s+(\d+)/gm)) {
    descriptors.push(Number.parseInt(match[1], 10))
  }
  return descriptors
}

/**
 * Whether a set of watched descriptors, as what each points at, is a wait for
 * `input`: it includes the input, and no socket besides it.
 */
export function isInputWait(targets: string[], input: string): boolean {
  if (!targets.includes(input)) return false
  return !targets.some((target) => target !== input && target.startsWith('socket:'))
}

/**
 * Whether a process in the session `leader` leads is blocked waiting on the
 * same place the leader's standard input comes from.
 */
export async function isWaitingForInput(leader: number, procRoot = '/proc'): Promise<boolean> {
  if (process.platform !== 'linux') return false
  const input = await readlink(`${procRoot}/${leader}/fd/0`).catch(() => null)
  if (input === null) return false
  const members = await sessionMembers(leader, procRoot)
  for (const pid of members) {
    if (await waitsOn(pid, input, procRoot)) return true
  }
  return false
}

/** Every process in the session `leader` leads, the leader included. */
async function sessionMembers(leader: number, procRoot: string): Promise<number[]> {
  const entries = await readdir(procRoot).catch(() => [] as string[])
  const pids = entries.filter((entry) => /^\d+$/.test(entry))
  const stats = await Promise.all(pids.map((pid) => readStat(pid, procRoot)))
  const members: number[] = []
  for (const stat of stats) {
    if (stat && stat.session === leader) members.push(stat.pid)
  }
  return members
}

async function readStat(pid: string, procRoot: string): Promise<ProcessStat | null> {
  const text = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(() => null)
  if (text === null) return null
  return parseStat(text)
}

/** Whether `pid` is blocked waiting on a set of descriptors that makes it an input wait. */
async function waitsOn(pid: number, input: string, procRoot: string): Promise<boolean> {
  const syscall = await readFile(`${procRoot}/${pid}/syscall`, 'utf8').catch(() => null)
  if (syscall === null) return false
  const blocked = blockedOn(syscall)
  if (!blocked) return false
  const descriptors = await watchedDescriptors(pid, blocked, procRoot)
  const targets = await Promise.all(
    descriptors.map((descriptor) => readlink(`${procRoot}/${pid}/fd/${descriptor}`).catch(() => ''))
  )
  return isInputWait(targets, input)
}

/** The descriptors a blocked process is waiting on. */
async function watchedDescriptors(pid: number, blocked: BlockedOn, procRoot: string): Promise<number[]> {
  if (blocked.kind === 'read') return [blocked.descriptor]
  if (blocked.kind === 'epoll') {
    const fdinfo = await readFile(`${procRoot}/${pid}/fdinfo/${blocked.descriptor}`, 'utf8').catch(() => '')
    return epollDescriptors(fdinfo)
  }
  if (blocked.count <= 0 || blocked.count > MAX_WATCHED || blocked.address === 0) return []
  if (blocked.kind === 'poll') {
    return pollDescriptors(await readMemory(pid, blocked.address, blocked.count * 8, procRoot))
  }
  const bytes = Math.ceil(blocked.count / 8)
  return selectDescriptors(await readMemory(pid, blocked.address, bytes, procRoot), blocked.count)
}

/** Reads a span of a process's memory, or nothing when it cannot be read. */
async function readMemory(pid: number, address: number, length: number, procRoot: string): Promise<Buffer> {
  const handle = await open(`${procRoot}/${pid}/mem`, 'r').catch(() => null)
  if (!handle) return Buffer.alloc(0)
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, address)
    return buffer.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await handle.close()
  }
}
