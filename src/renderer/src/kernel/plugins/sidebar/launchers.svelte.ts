// Launcher-rail items that are NOT pane types: plugin-contributed icons that
// run an action instead of surfacing a pane. Rendered by ActivityBar below the
// pane-type launchers.

export interface RailLauncher {
  id: string
  label: string
  // Iconify icon name (plugins can't ship components).
  icon: string
  order: number
  run: () => void | Promise<void>
}

class SidebarRegistry {
  launchers = $state<RailLauncher[]>([])

  register(launcher: RailLauncher): () => void {
    const others = this.launchers.filter((entry) => entry.id !== launcher.id)
    this.launchers = [...others, launcher].sort((a, b) => a.order - b.order)
    return () => {
      this.launchers = this.launchers.filter((entry) => entry.id !== launcher.id)
    }
  }
}

export const sidebar = new SidebarRegistry()
