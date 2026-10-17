// The workspace plugin: the open repository as a service, the command that opens another,
// the repository's name on the header's pill and its branch in the status bar. At start it reopens
// the repository the host names with `GROVE_REPO`, or else the last one.

import type { Context } from "@neoworks/extension-system";
import { files, invoke } from "@neoworks/svelte-gpui";
import BranchStatus from "./BranchStatus.svelte";
import RepoCommandCenter from "./RepoCommandCenter.svelte";
import { WorkspaceService } from "./service";

/** Asks for a folder with the system's dialog; resolves to null when cancelled. */
async function pickFolder(): Promise<string | null> {
  const picked = await files.pickFiles({ directories: true, prompt: "Open folder" });
  if (picked === null || picked.length === 0) {
    return null;
  }
  return picked[0];
}

/** The repository the host was started on, or an empty string. */
async function startingRepository(): Promise<string> {
  try {
    return await invoke<string>("initial_repo");
  } catch {
    return "";
  }
}

export const workspace = {
  name: "workspace",
  inject: ["sidecar", "profile", "slots", "commands"],
  apply(ctx: Context) {
    const service = new WorkspaceService(ctx);
    // Wins over the header's own pill by priority, so the pill carries the repository's name.
    ctx.slots.register("header.center", {
      id: "command-center",
      order: 0,
      priority: 50,
      component: RepoCommandCenter,
      props: { workspace: service, fallbackLabel: "grove" },
    });
    ctx.slots.register("statusbar", { id: "workspace.branch", order: 0, component: BranchStatus, props: { workspace: service } });
    ctx.commands.register({
      id: "workspace.openFolder",
      title: "Open Folder…",
      group: "File",
      run: async () => {
        const folder = await pickFolder();
        if (folder !== null) {
          await service.open(folder);
        }
      },
    });
    void startingRepository().then((path) => service.restore(path));
  },
};
