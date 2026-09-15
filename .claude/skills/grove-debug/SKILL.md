---
name: grove-debug
description: Attach to the running Grove app and inspect or drive it — renderer state, nvim windows, agent sessions, reviews, and the on-disk event log. Use whenever a UI or agent bug is reported, before proposing a fix, and instead of guessing behaviour from source or reading the UI through tmux.
---

# Driving a running Grove

Grove is not launched from here. The user runs it themselves, with `GROVE_DEBUG=1`
— that flag is what registers the `debug.*` routes; without it nothing below
connects. Everything here talks to that running instance.

- **Renderer changes hot-reload.** Edit and re-check immediately.
- **Main-process changes do not.** After touching `src/main`, ask the user to
  restart before you trust anything the harness reports.
- On the first connection Grove shows a pairing dialog; the user approves it once
  and the token is reused from `~/.config/grove/tokens/grove-debug`.

The rule this exists for: **reproduce a reported bug through the harness and
confirm the mechanism before proposing a fix.** Guessing from source has been
wrong more often than right. Do not read the UI through tmux — attach and look.

## Is it reachable

```
bun scripts/grove-debug.ts scenario ping
```

`ping` is a scenario, not a top-level command. It checks both halves: nvim and
the renderer.

## Reading state

```
bun scripts/grove-debug.ts state                 # review + editor state in one call
bun scripts/grove-debug.ts windows [session]     # nvim tabs/windows/buffers/diff flags
bun scripts/grove-debug.ts sessions              # live nvim sessions
bun scripts/grove-debug.ts eval '<js>'           # anything in the renderer
bun scripts/grove-debug.ts lua '<lua>'           # anything in the editor; must return a value
bun scripts/grove-debug.ts rpc <method> [json]   # raw nvim msgpack-rpc
```

### eval takes one expression

`debug.renderer.eval` evaluates an **expression**, not a program. A statement —
anything starting with `const`, `let`, or a `;`-separated sequence — comes back
as:

```
Script failed to execute, this normally means an error was thrown.
```

which looks like the app threw, but is a syntax problem in what you sent. Write
an expression, or wrap the whole thing in an IIFE:

```bash
# wrong: statements
bun scripts/grove-debug.ts eval 'const s = window.__grove_debug.agentSessions; JSON.stringify(s.list)'

# right: one expression
bun scripts/grove-debug.ts eval 'JSON.stringify(window.__grove_debug.agentSessions.list)'

# right: an IIFE when you need locals
bun scripts/grove-debug.ts eval '(() => { const s = window.__grove_debug.agentSessions; return JSON.stringify(s.list.map((x) => x.status)) })()'
```

`JSON.stringify` what you want back — the result is printed as a JSON string, so
objects that do not serialise come back empty.

### What eval can reach

`window.__grove_debug` holds `ctx`, `store`, `review`, `keymap`, `layout`,
`inlineEdit`, `nvimRegistry`, `agentSessions` and `agentTranscript`.
`window.workbench.*` is the same IPC surface the UI itself calls, so anything a
button does can be done from here.

`ctx` is the renderer's kernel context:

- `ctx.fiber.getEffects()` — everything currently installed
- `ctx.registry.values()` — the mounted plugins
- `ctx.panes` / `ctx.commands` / `ctx.sidebar` / `ctx.editor` / `ctx.panel` —
  the services they contribute into

Useful shapes, worth knowing before you go hunting:

- `agentSessions.list` — every session, with `status` (`idle` / `running` / `terminated`)
- `agentSessions.live[sessionId].transcript` — the folded transcript: `items`,
  `status`, `stopReason`, `lastSeq`
- `agentSessions.live[sessionId].snapshot` — what the main process reports
- `review.active`, `review.queue` — the review batch on screen and what is waiting

A status that disagrees between `transcript` and `snapshot`, or between either
and what the screen shows, is the bug — not a display artefact.

## Driving agents

```
bun scripts/grove-debug.ts harnesses list           # mounted runtimes, and which can run
bun scripts/grove-debug.ts harnesses catalog <id>   # its models, commands and skills

bun scripts/grove-debug.ts agent sessions           # sessions in the selected worktree
bun scripts/grove-debug.ts agent start '<prompt>'   # new session, manual review
bun scripts/grove-debug.ts agent send '<text>'      # into the worktree's active session
bun scripts/grove-debug.ts agent stop [sessionId]   # interrupt the turn in flight
bun scripts/grove-debug.ts agent permissions        # pending tool-permission requests
bun scripts/grove-debug.ts agent allow [id]
bun scripts/grove-debug.ts agent deny '<why>' [id]
```

Every `agent` command targets **the worktree the UI has selected**, not the
repo this shell is in. Check it first when the answers look unrelated:

```
bun scripts/grove-debug.ts eval 'window.__grove_debug.store.selectedWorktree.path'
```

`agent start` spends the user's tokens and runs a real model in their app. Use a
small prompt, and prefer reading the existing session's log (below) when the bug
has already happened once.

## Reviews

```
bun scripts/grove-debug.ts review list
bun scripts/grove-debug.ts review open [batchId]              # opens it and dumps nvim's windows
bun scripts/grove-debug.ts review decide <path> <hunk> <accepted|rejected>
bun scripts/grove-debug.ts review comment <path> <hunk> <text>
bun scripts/grove-debug.ts review finish                      # apply verdicts, report to the agent
```

## Replayable scenarios

```
bun scripts/grove-debug.ts scenarios
bun scripts/grove-debug.ts scenario <name> [args]
```

| scenario | what it drives |
| --- | --- |
| `ping` | the harness reaches nvim and the renderer |
| `review-state` | the app's review state against nvim's actual windows |
| `review-open` | opens the first queued review, checks the diff survives |
| `diff-probe` | renders a synthetic review diff through the app's own session method |
| `tab-follow` | whether an active-tab change destroys an open review diff |
| `review-e2e` | a whole gated review: run an agent, review its edit, reject a hunk |

## The agent event log

Every agent session is an append-only log on disk:

```
~/.config/grove/agents/<sessionId>/events.jsonl
```

This is the source of truth a transcript is folded from, and it is the fastest
way to answer "what did the harness actually emit, and in what order?" — a
question the rendered UI cannot answer, because the fold is exactly what is
usually wrong.

```bash
# every event type in order — the shape of a turn
jq -r '[.seq, .type] | @tsv' events.jsonl

# just the turn boundaries: one status_running per turn, one status_idle per result
jq -r 'select(.type | test("status_|interrupt|user\\.|app\\."))|[.seq,.type,.stopReason]|@tsv' events.jsonl

# what a message_end actually carried, when messages arrive split or interleaved
jq -c 'select(.seq >= 280 and .seq <= 300)' events.jsonl | cut -c1-300
```

What to look for:

- **A `status_idle` with no matching `status_running` after it** while events keep
  arriving: the session reads as idle while the model streams, so the pane offers
  no way to stop it.
- **A `message_end` between deltas of one answer**: something else — a subagent,
  another lane — is closing the block, and the text on screen splits mid-word
  across two bubbles.
- **`seq` gaps or out-of-order events**: the fold in
  `src/renderer/src/lib/agents/transcript.ts` is idempotent by `seq`, so anything
  arriving late is dropped rather than applied.

## A worked diagnosis

Reported: "the model is running and I can't stop it", plus "the last message is
not fully displayed".

1. `agent sessions` → every session reports `idle`, which already contradicts the
   screen.
2. `eval` on `agentSessions.live[id].transcript.items.slice(-4)` → the last two
   items are one answer cut mid-word: one ends `...beyond liter`, the next starts
   `al prefix.`.
3. The log, `jq -r '[.seq,.type]|@tsv'` → one `status_running` at the start and
   three `status_idle`, with hundreds of events after the first one. Turns two and
   three never raised the status, so `running` in `AgentPane.svelte` stayed false
   and the Stop button was never rendered.
4. `jq -c 'select(.seq==283)'` → the `message_end` that split the answer carried a
   *subagent's* text.

Both mechanisms were in `src/main/agents/harnesses/claude.ts`, which folded
subagent messages (`parent_tool_use_id` set) into the main conversation and only
raised the status from prompts grove itself sent. Neither was visible from the
screen alone, and neither would have been guessed from the component.
