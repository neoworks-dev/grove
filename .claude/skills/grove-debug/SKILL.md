---
name: grove-debug
description: Use Grove native the way a person does — launch it on a headless display, click, drag, type, look at screenshots, read its logs, and file what you find as GitHub issues. Use when the cause of a UI or agent bug isn't clear from the code, or a fix didn't work; when exploring the app for bugs and rough edges; to show a change working before and after; and whenever driving the app through `bun run qa`.
---

# Using Grove, and finding out what is wrong with it

This is the harness for the job an end-to-end spec cannot do: sitting down with
the app and finding out what is wrong with it. Not "does the button dispatch the
action" — whether the thing is any good to use.

It is also the debugger, for when a bug is known and the question is _why_, and
the way a change is shown to work: once before, with the bug, and once after.
It launches an instance of its own; never launch or restart the user's.

The app is Grove native: `native/target/release/grove_native` running the
bundle in `native/dist/`. Everything is `bun run qa <command>`, and
`bun run qa help` lists it.

## A session

```bash
bun run qa start            # headless display, the app, its own profile and daemon
bun run qa screenshot       # what is on screen; read the PNG with the Read tool
bun run qa stop             # the app, everything it spawned, the daemon, the display
```

`start` rebuilds the bundle every time (a second), so the session runs the
checkout's UI as it is. The Rust host is only rebuilt with `--build`, which takes
minutes; a worktree without `native/target` gets the main checkout's copied in
first, so GPUI is not compiled again. Run `bun install` in `native/` once per
worktree. `--fresh` throws the profile and the demo repo away. `restart` is
`stop` then `start`, with the same flags.

The display is a headless gamescope: its own Xwayland on the GPU, which nobody
sees and which never touches the user's desktop or compositor. Xvfb and Xvnc do
not work for native, because GPUI's Vulkan surface cannot present without DRI3
and the window stays black. There is no viewer to watch a run.

Everything the session writes is under `.grove-qa/` in the checkout: the profile
(`profile/`, with config, data, state, cache and temp), the demo repo
(`profile/demo`), screenshots (`shots/`), and the logs. Sockets go in a short
directory under `$XDG_RUNTIME_DIR/grove-qa-<hash>`. The session starts its own
suite daemon on that socket and stops it with `stop`, so agents run there and
never in the user's daemon. `--no-daemon` skips it.

One exception, worth knowing: `gh` is pointed at the real `~/.config/gh`, because
the GitHub surfaces are untestable logged out. The demo repo's remote is
`neoworks-dev/grove-qa-sandbox`, a scratch repository — issues, branches and
pull requests you make in **there** are expected and disposable. Never push
anything to `neoworks-dev/grove` itself except an issue.

## Seeing

```bash
bun run qa screenshot opened-explorer                 # the window, 1440x900
bun run qa screenshot tab-strip --crop 300,40,560,30  # one part of it
bun run qa probe                                      # up or not, and its errors
bun run qa probe "New chat"                           # where that text is on screen
bun run qa wait "Problems" [--gone]                   # until it shows, or goes
```

A screenshot is how you see the app: there is no element tree to print. Read
the file with the Read tool, in the session. Never open it in a viewer or a
browser. Its pixels are window coordinates, so a position you read off it is a
position you can click.

`--crop x,y,w,h` is how you look closer. A crop of the row you doubt beats a whole
window you hunt through.

Taking one when nothing has happened since the last is refused: two photographs
of the same screen cannot differ. When the app changed by itself (it finished
loading, an agent answered), add `--again`. Every action also takes
`--screenshot <label>`, which photographs the result once it has settled.

`probe <text>` finds text by reading a screenshot with tesseract, and prints its
box and centre. That is also how text targets work (below), so when a click
misses, `probe` the same text to see where the harness thought it was.

## Acting

```bash
bun run qa click "Problems"                # also dblclick, rightclick
bun run qa click at=550,300                # a point in the window
bun run qa drag at=864,200 at=640,200      # press, move in steps, release
bun run qa type "some text"                # into whatever has the keyboard
bun run qa press Escape                    # chords: Control+s, Shift+Tab
bun run qa press G o                       # several presses in order
bun run qa scroll -400 --at at=600,300
```

A target is one of:

| form            | means                                                        |
| --------------- | ------------------------------------------------------------ |
| `Problems`      | the text on screen that reads that, one word or a phrase      |
| `text=at=1,2`   | the same, spelled out when the text looks like something else |
| `at=820,460`    | a point in the window, for what shows no text                 |

Text that is on screen more than once is an error listing every match; pick one
with `--nth <n>`, counted top to bottom. Text is matched exactly first, and then
ignoring case and punctuation. Small or low-contrast text can be misread; when
it is not found, take a screenshot and use the point instead.

Points are for everything without words: icons, the editor's text area, and
split dividers. To resize a split, drag from a point on the divider a quarter of
the way along it, not the middle: the middle is where its `+` lives, and pressing
there opens a pane picker instead of dragging. The drag moves in steps, so a
handler that sums pointer movement sees the whole of it.

Keys go to whatever has the keyboard, as they would for a person: click into the
editor before typing into it, and into the composer before typing a prompt.

## The editor

The editor is drawn by GPUI, and its text is only on screen. Drive it with the
keyboard and look at it:

```bash
bun run qa dblclick README.md        # open it from the explorer
bun run qa click at=550,300          # put the keyboard in the editor
bun run qa press G o                 # open a line below the last
bun run qa type "something"
bun run qa press Escape --screenshot edited
```

## Agent sessions

Grove runs agents through the session's own suite daemon, and they are worth
exercising — the composer, the transcript, the review flow. They also cost real
tokens on the user's account. Keep prompts tiny ("add a comment to README.md"),
start one session rather than five, and read `qa logs` rather than re-running to
see the same thing twice. The daemon's own log is
`.grove-qa/profile/data/neo/daemon.log`.

## When something goes wrong

```bash
bun run qa logs                 # the end of the app's log
bun run qa logs 300 --errors    # only the lines that report a failure
```

The app's log is `.grove-qa/app.log`: the host, the UI's console and the
sidecar's stderr, in the order they happened. `probe` counts the errors in it.

If the app stops responding, `qa probe` says whether it is still running at all;
`qa restart` is always safe, and the profile survives it.

## Showing a change works

Every change is shown twice, with a screenshot each time: before it, showing the
bug or the missing feature, and after it, showing it work. Run the same steps on
both builds and keep the shots, then put them on the issue:

```bash
bun run qa evidence --issue 23 --body evidence.md \
  --screenshot .grove-qa/shots/004-before.png \
  --screenshot .grove-qa/shots/009-after.png
```

The comment is for someone who was not in the session: say what changed, what
each screenshot shows, and how it was produced.

## Handing it to a model

```bash
bun run qa explore                 # the whole app
bun run qa explore panes           # a charter from charters/
bun run qa explore "the GitHub pane" --dry-run
bun run qa charters
```

`explore` starts a Claude Code instance on the running session, which drives it
with the harness and files what it finds. `--dry-run` writes the report without
filing anything.

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

Not findings: anything you caused by driving the harness wrong, a click that
missed because the text was read wrong, or something the demo repo simply does
not have.

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
