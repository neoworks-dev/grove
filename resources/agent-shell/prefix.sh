#!/bin/sh
# Grove's CLAUDE_CODE_SHELL_PREFIX. Claude Code hands every command it runs to
# this as one string: its Bash tool's commands, and also hooks and MCP servers.
#
# A Bash command is copied to grove as it runs (tee.cjs), so the user can watch
# it; everything else runs exactly as it would have. Nothing here may change
# what a command does or prints.

command_line="$1"

# The shell Claude meant the command for: it sources a snapshot of that shell's
# setup first. Not $SHELL, which can be one Claude does not run (fish).
shell_for_bash() {
  case "$command_line" in
    *snapshot-zsh-*) command -v zsh && return ;;
    *snapshot-bash-*) command -v bash && return ;;
  esac
  command -v zsh || command -v bash || echo /bin/sh
}

case "$command_line" in
  *"eval '"*"pwd -P >| "*)
    shell="$(shell_for_bash)"
    if [ -n "$GROVE_SHELL_SOCKET" ] && [ -S "$GROVE_SHELL_SOCKET" ] && [ -n "$GROVE_NODE" ]; then
      ELECTRON_RUN_AS_NODE=1 exec "$GROVE_NODE" "$(dirname "$0")/tee.cjs" "$shell" "$command_line"
    fi
    exec "$shell" -c "$command_line"
    ;;
esac

exec /bin/sh -c "$command_line"
