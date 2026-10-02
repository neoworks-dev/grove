// Shell integration: teaching zsh and bash to mark their prompts the way fish
// already does, with the semantic-prompt sequences (OSC 133) — A where a prompt
// starts, B where the typed command starts, C when it runs, D;<status> when it
// has finished. With them, a terminal knows each command the user ran, what it
// printed and how it exited: the terminal pane flags a failed one, and the
// agent terminal hands each to the agent.
//
// Neither shell is changed for good. zsh is pointed at a directory of grove's
// whose startup files load the user's own first, then add the hooks and point
// it back; bash is started with an init file that loads the user's profile
// and bashrc, then adds them. bash does not name the command line in C; the
// terminal reads it off the screen between B and C instead.

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** How to start a shell: its environment, and arguments when it needs particular ones. */
export interface ShellLaunch {
  env: Record<string, string>
  args?: string[]
}

// Each zsh startup file grove's ZDOTDIR holds loads the user's file of the
// same name from where ZDOTDIR pointed before, keeping whatever that file
// moves ZDOTDIR to.
const ZSH_FORWARD = (file: string): string => `__grove_zdotdir=$ZDOTDIR
ZDOTDIR=$GROVE_USER_ZDOTDIR
[[ -f $ZDOTDIR/${file} ]] && . $ZDOTDIR/${file}
GROVE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__grove_zdotdir
`

// After the user's .zshrc: ZDOTDIR goes back to theirs, so .zlogin and
// everything later is their own. B is sent when the line editor starts, not
// from the prompt string: prompt themes such as powerlevel10k rebuild PS1 on
// every prompt, after any hook that could have marked it. C names the command
// line, as fish's does: a theme with a transient prompt redraws the line it was
// typed on, so reading it back off the screen finds the wrong row.
const ZSH_RC = `${ZSH_FORWARD('.zshrc')}ZDOTDIR=$GROVE_USER_ZDOTDIR
unset GROVE_USER_ZDOTDIR __grove_zdotdir
__grove_precmd() {
  local grove_status=$?
  printf '\\e]133;D;%s\\a\\e]133;A\\a' "$grove_status"
}
__grove_preexec() {
  printf '\\e]133;C;cmdline_url=%s\\a' "$(__grove_url_encode "$1")"
}
__grove_url_encode() {
  local text=$1 encoded= char
  local -i index
  for (( index = 1; index <= \${#text}; index++ )); do
    char=\${text[index]}
    if [[ $char == [A-Za-z0-9._~/-] || $(( #char )) -gt 127 ]]; then encoded+=$char
    else encoded+=$(printf '%%%02X' "'$char"); fi
  done
  print -rn -- $encoded
}
__grove_line_init() {
  printf '\\e]133;B\\a' >$TTY
}
autoload -Uz add-zsh-hook add-zle-hook-widget
add-zsh-hook precmd __grove_precmd
add-zsh-hook preexec __grove_preexec
add-zle-hook-widget line-init __grove_line_init
`

// bash as a login shell would start: the system profile, then the first of the
// user's profiles, which usually loads .bashrc; .bashrc directly when there is
// no profile to do it. The status is read first thing, before anything the
// user put in PROMPT_COMMAND changes it.
const BASH_INIT = `[ -f /etc/profile ] && . /etc/profile
if [ -f ~/.bash_profile ]; then . ~/.bash_profile
elif [ -f ~/.bash_login ]; then . ~/.bash_login
elif [ -f ~/.profile ]; then . ~/.profile; [ -f ~/.bashrc ] && . ~/.bashrc
elif [ -f ~/.bashrc ]; then . ~/.bashrc
fi
__grove_status() {
  printf '\\e]133;D;%s\\a\\e]133;A\\a' "$?"
}
__grove_mark_prompt() {
  case "$PS1" in *'133;B'*) ;; *) PS1="$PS1"'\\[\\e]133;B\\a\\]' ;; esac
}
PROMPT_COMMAND="__grove_status;\${PROMPT_COMMAND:+$PROMPT_COMMAND;}__grove_mark_prompt"
PS0='\\e]133;C\\a'"$PS0"
`

/** Writes grove's startup files for zsh and bash under `directory`. */
export function writeShellIntegration(directory: string): void {
  const zsh = join(directory, 'zsh')
  mkdirSync(zsh, { recursive: true })
  writeFileSync(join(zsh, '.zshenv'), ZSH_FORWARD('.zshenv'))
  writeFileSync(join(zsh, '.zprofile'), ZSH_FORWARD('.zprofile'))
  writeFileSync(join(zsh, '.zshrc'), ZSH_RC)
  const bash = join(directory, 'bash')
  mkdirSync(bash, { recursive: true })
  writeFileSync(join(bash, 'grove.bash'), BASH_INIT)
}

/**
 * How to start the shell `env.SHELL` names with grove's integration: zsh
 * through grove's ZDOTDIR, bash through its init file. Any other shell — fish,
 * which marks its prompts itself, included — starts as it is.
 */
export function withShellIntegration(env: Record<string, string>, directory: string): ShellLaunch {
  const shell = basename(env.SHELL || '')
  if (shell === 'zsh') {
    let userZdotdir = env.HOME || ''
    if (env.ZDOTDIR) userZdotdir = env.ZDOTDIR
    return { env: { ...env, ZDOTDIR: join(directory, 'zsh'), GROVE_USER_ZDOTDIR: userZdotdir } }
  }
  if (shell === 'bash') {
    return { env, args: ['--init-file', join(directory, 'bash', 'grove.bash'), '-i'] }
  }
  return { env }
}
