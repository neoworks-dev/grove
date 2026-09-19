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
bun run qa probe            # is it up, and what is on screen
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

`probe` is the loop. It prints the app as the tree of panes it is:

```bash
bun run qa probe                    # everything
bun run qa probe separator          # only elements matching a name, role or ref
```

```
grove  1512x982  view=code  worktree=…/demo/repo
focus=leaf-2 (nvim)  tab=README.md  errors=0

split-1  row  20% 60% 20%
├─ leaf-1  explorer  248x946  fixed=248px
│       treeitem "README.md" e1 · treeitem "src" e2
│  split-1:0  ↔ gutter
├─ leaf-2  nvim  "Editor"  912x946  ★focus
│       canvas e3
│  split-1:1  ↔ gutter
└─ leaf-3  agent  "Agent"  352x946
        textbox "Ask anything" e4 · button "Send" e5 (disabled)

overlays (menus, modals, the top bar — outside the pane tree)
  button "Code" e9 · button "Review" e10
```

Everything in it is a target. `e3` is an element, `leaf-2` is a pane, and
`split-1:0` is the gutter between two of them. Refs stay valid until the screen
changes under them; a stale one is an error telling you to probe again, never a
click somewhere unintended.

The header is the session: which view, which worktree, which pane has focus,
which file the editor is on, how many agent sessions and how many errors. Errors
are listed under the tree when there are any, boot failures included.

### The screenshot is for what only a picture shows

```bash
bun run qa screenshot opened-explorer    # a PNG in .grove-qa/shots; read it
```

Alignment, overlap, a label running under an icon, a panel that went blank, a
colour that is wrong. **Not** for finding out what is open or what to click —
`probe` says that exactly, and a picture costs you a thousand times as much to be
told it approximately.

When you do take one, **read the file**. Every screenshot is also drawn into the
transcript the person watching this run is reading, so the path you print is the
picture they see, and one you did not look at tells you nothing.

Anything transient has to be photographed in the same connection that produced
it, which is what `--screenshot <label>` on an action is for:

```bash
bun run qa click "Open a pane here" --screenshot pane-picker
```

The driver connects per command, and a menu, picker or popover **closes when it
disconnects** — a separate `qa screenshot` afterwards photographs a screen your
click never produced.

## Acting

```bash
bun run qa click "New session"            # also dblclick, rightclick
bun run qa drag split-1:0 at=520,300      # press, move, release
bun run qa type "some text"               # into whatever has focus
bun run qa press Escape                   # chords: Control+s, Shift+Tab
bun run qa press g g                      # several presses in order
bun run qa scroll -400 --at e8
bun run qa wait "Commit" [--gone]
```

A target is one of:

| form | means |
| --- | --- |
| `New session` | the accessible name, in the roles a person clicks |
| `e14` | an element from the last `probe` |
| `leaf-3` | a pane — clicking one focuses it |
| `split-1:0` | the gutter between two panes, for a resize |
| `at=820,460` | a point in the window, for what has no element |
| `role=button:Save` | a name, in one role, when the bare name is ambiguous |
| `text=Skip` / `testid=agent-mode-trigger` / `css=.thing` | when nothing else fits |

Two things about dragging. A gutter is grabbed a quarter of the way along it, not
in the middle — the middle is where the `+` that opens a pane lives, and pressing
there opens the picker instead of dragging. And the move is stepped, so a handler
that accumulates `pointermove` deltas sees the whole drag.

That quarter-way rule applies to an element — a gutter id, a ref, a selector —
and **not** to `at=x,y`, which presses exactly where you said. So a drag from a
gutter's midpoint read off a screenshot does nothing, while `split-1:0` resizes.
It is the app's behaviour, not a flaky harness: name the gutter, and keep `at=`
for the destination and for surfaces that have no element at all.

### Opening a pane

Finding the affordance that opens a pane costs a dozen actions and is almost
never what you were sent to test. Ask for the pane instead:

```bash
bun run qa panes                    # every pane type, and whether one is open
bun run qa pane github              # reveal it, wherever it belongs
bun run qa pane terminal --split column   # in a new window below the focused one
bun run qa pane diff --in leaf-2    # swap it into that pane
bun run qa pane github --close
```

Each of these prints the tree it produced, so you can see where the pane landed.

This is a shortcut past the UI, not a replacement for it: the rail, the `+` on a
gutter and the per-pane `…` menu are themselves worth testing, and testing them
means clicking them.

## The editor

The editor is a canvas. Its text is not in the DOM, so `probe` shows you one
element and nothing about the buffer. Drive it as a person does, with the
keyboard, and read it back through nvim itself:

```bash
bun run qa click "README.md"
bun run qa press G o                                     # open a line below
bun run qa type "something"
bun run qa press Escape
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
session rather than five, and read `bun run qa logs` and the transcript rather
than re-running to see the same thing twice.

## When something goes wrong

```bash
bun run qa logs                 # both halves of the app: renderer, then main
bun run qa logs --renderer 100  # what the page logged, plus what CDP saw it do
bun run qa logs --main 100      # git, nvim, the agents, the plugin host
bun run qa eval '<one expression in the renderer>'
```

Two halves, and a fault usually needs both. The renderer's log is a ring buffer
kept inside the page, so it survives between commands and carries what Chromium
reports as well as what the app printed — failed requests and uncaught throws
included. Everything the main process does is only ever in its own output.

`eval` takes an **expression**, not statements. Wrap locals in an IIFE. It
reaches `window.__grove_debug` (`store`, `layout`, `panes`, `views`, `review`,
`keymap`, `agentSessions`) and `window.workbench.*`, which is the same IPC
surface the UI calls.

If the app stops responding, `qa probe` says whether it is still running at all;
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
  --screenshot .grove-qa/shots/012-after-split.png
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
