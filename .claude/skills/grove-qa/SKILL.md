---
name: grove-qa
description: Use Grove the way a person does — launch a session on a virtual display, click, drag, type, look at screenshots, and file what you find as GitHub issues. Use when exploring the app for bugs and rough edges rather than diagnosing a known one, and whenever driving the built app through `bun run qa`.
---

# Using Grove, and reporting what that was like

This is the harness for the job an end-to-end spec cannot do: sitting down with
the app and finding out what is wrong with it. Not "does the button dispatch the
action" — whether the thing is any good to use.

It is not the debugger. When a bug is already known and the question is *why*,
that is the `grove-debug` skill, which attaches to an instance over the `debug.*`
routes. This one launches an instance of its own and uses it.

Everything is `bun run qa <command>`. `bun run qa help` lists it.

## A session

```bash
bun run qa start            # display, built app, isolated profile, CDP port
bun run qa status           # is it up, and what does the renderer think is on screen
bun run qa stop             # the app, everything it spawned, and the display
```

`start` reuses the last build. `--build` rebuilds first, `--fresh` throws the
profile and the demo repo away and makes new ones. Start-up takes about half a
minute: the app builds an nvim runtime on a cold profile.

The session runs on a virtual X display (`:90`–`:99`), not the desktop. To watch
it happen: `vncviewer :90`, with whatever display `start` printed.

The profile is `.grove-test/`, the same isolated one the e2e suite and
`scripts/test-env.ts` use — the user's own `~/.config/grove` is never opened, so
an instance they are running keeps its sessions while this one runs beside it.

One exception, worth knowing: `gh` is pointed at the real `~/.config/gh`,
because the GitHub surfaces are untestable logged out. The demo repo's remote is
`neoworks-dev/grove-qa-sandbox`, a scratch repository — issues, branches and
pull requests you make in **there** are expected and disposable. Never push
anything to `neoworks-dev/grove` itself except an issue.

## Seeing

Two ways, and you need both.

```bash
bun run qa shot opened-explorer     # a PNG in .grove-qa/shots; read it
bun run qa probe                    # every element, with a ref and a position
bun run qa probe separator          # filtered by name or role
```

`shot` prints a path. **Read the file.** Every screenshot you take is also drawn
into the transcript the person watching this run is reading, so the path you
print is the picture they see. A screenshot you did not look at tells
you nothing, and most of what is worth finding — a misaligned row, a label that
runs under an icon, a panel that went blank — is only visible in the picture.

`probe` is how you act precisely. It hands back a list like:

```
{ "ref": "e14", "role": "treeitem", "name": "README.md", "at": "120,310", "size": "245x18" }
```

Refs stay valid until the screen changes under them. A stale one is an error
telling you to probe again, never a click somewhere unintended.

### Anything transient needs `--shot`

Every action takes `--shot <label>`, which photographs the result inside the same
connection the action ran in:

```bash
bun run qa click "Open a pane here" --shot pane-picker
```

This is not a convenience. The driver connects per command, and a menu, picker
or popover **closes when it disconnects** — a separate `qa shot` afterwards
photographs a screen your click never produced. If what you are looking at only
exists while something is open, capture it with `--shot`.

## Acting

```bash
bun run qa click "New session"            # also dblclick, rightclick
bun run qa drag e24 at=520,300            # press, move, release
bun run qa type "some text"               # into whatever has focus
bun run qa key Escape                     # chords: Control+s, Shift+Tab
bun run qa key g g                        # several presses in order
bun run qa scroll -400 --at e8
bun run qa wait "Commit" [--gone]
```

A target is one of:

| form | means |
| --- | --- |
| `New session` | the accessible name, in the roles a person clicks |
| `e14` | a ref from the last `probe` |
| `at=820,460` | a point in the window, for what has no element |
| `role=button:Save` | a name, in one role, when the bare name is ambiguous |
| `text=Skip` / `testid=agent-mode-trigger` / `css=.thing` | when nothing else fits |

Two things about dragging. A divider is grabbed a quarter of the way along it,
not in the middle — the middle is where the `+` that opens a pane lives, and
pressing there opens the picker instead of dragging. And the move is stepped, so
a handler that accumulates `pointermove` deltas sees the whole drag.

That quarter-way rule applies to an element — a ref, a name, a selector — and
**not** to `at=x,y`, which presses exactly where you said. So a drag from a
divider's midpoint read off a screenshot does nothing, while the same divider as
a ref resizes. It is the app's behaviour, not a flaky harness: prefer the ref,
and keep `at=` for the destination and for surfaces that have no element at all.

## The editor

The editor is a canvas. Its text is not in the DOM, so `probe` shows you one
element and nothing about the buffer. Drive it as a person does, with the
keyboard, and read it back through nvim itself:

```bash
bun run qa click "README.md"
bun run qa key G o                                       # open a line below
bun run qa type "something"
bun run qa key Escape
bun run qa nvim 'return vim.api.nvim_buf_get_lines(0, 0, -1, false)'
bun run qa nvim 'return vim.api.nvim_buf_get_name(0)'
```

Wait for the status bar between opening a file and typing into it. The tab
appears before nvim owns the buffer, and keys that arrive early are motions
rather than text.

## Agent sessions

Grove runs Claude agents inside itself, and they are worth exercising — the
composer, the transcript, the review flow. They also cost real tokens on the
user's account. Keep prompts tiny ("add a comment to README.md"), start one
session rather than five, and read `bun run qa console` and the transcript
rather than re-running to see the same thing twice.

## When something goes wrong

```bash
bun run qa console          # what the renderer logged, errors included
bun run qa log 60           # the main process's own output
bun run qa status           # panes, worktree, agent sessions, store errors
bun run qa eval '<one expression in the renderer>'
```

`eval` takes an **expression**, not statements. Wrap locals in an IIFE. It
reaches `window.__grove_debug` (`store`, `layout`, `review`, `keymap`,
`agentSessions`) and `window.workbench.*`, which is the same IPC surface the UI
calls.

If the app stops responding, `qa status` says whether it is still running at all;
`qa stop` and `qa start` is always safe — the profile survives it.

## What to report

Everything that made the app worse to use, not just what crashed:

- It broke, threw, hung, or lost your work.
- It did something other than what its label promised.
- You had to guess: no affordance, no feedback, a control you found by accident.
- It looked wrong: overlapping text, a cut-off label, misalignment, a panel that
  is empty when it should say why.
- It was slow enough to notice.
- Two parts of the app disagree — different wording, different shortcut,
  different behaviour for the same idea.

"I did not understand this" is a finding. Write it down rather than working it
out and moving on; the next person will not work it out either.

Not findings: anything you caused by driving the harness wrong, a stale ref, or
something the demo repo simply does not have.

## Filing it

One issue per finding, each with the screenshot that shows it:

```bash
bun run qa finding \
  --title "The tab strip loses the active tab when a pane is split" \
  --body findings/tab-strip.md \
  --label bug --label area:panes \
  --shot .grove-qa/shots/012-after-split.png
```

`--body` takes a file or the text itself. `--label` repeats. The `ai-found`
label is added for you, so every issue from a run is identifiable as one; pick
the type (`bug` or `enhancement`) and exactly one `area:` label, which are listed
in `CLAUDE.md`.

The screenshot is committed to the `qa-screenshots` branch and embedded in the
body. GitHub has no API for attaching a file to an issue, and the only URLs its
image proxy will render are ones served as an image — which a committed PNG is
and a release asset is not.

### Read the open issues first, not last

```bash
gh issue list --repo neoworks-dev/grove --state open --limit 100
gh issue view 67 --repo neoworks-dev/grove
gh issue list --search "tab strip" --state all
```

Do this before you start driving, and read the ones in the area you were given.
They tell you two things. What is already filed is not a finding — a duplicate
costs someone a triage, so skip it and note in your report that you saw it again;
if you learned something the issue does not say, comment on it instead.

And they are the best leads you have. An open issue is somebody's report of one
symptom: go and reproduce it, see whether it is still true and whether it is
worse than it says, and look at what sits next to it. That is usually where the
unfiled bug is.

A good issue says what you did, what happened, and what you expected — in that
order, in a few lines. The screenshot carries the rest. No severity theatre, no
restating the obvious, no speculation about the fix unless you read the code and
know.
