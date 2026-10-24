// The GitHub plugin: the `github` service, the `github` pane type in the `main` slot, and the
// commands that open the lists of issues and pull requests or an item by number. The pane reads
// GitHub through the person's `gh` login (see `client.ts` and `src/gh.rs`) and writes nothing.

import type { Context } from "@neoworks/extension-system";
import githubLogo from "@phosphor-icons/core/regular/github-logo.svg";
import { gpuiDiffHost } from "../diff/diffHost";
import { GithubClient } from "./client";
import { openUrlOnHost, runOnHost } from "./host";
import GithubPane from "./GithubPane.svelte";
import { GITHUB_PANE_TYPE, GithubService } from "./service";

export const github = {
  name: "github",
  inject: ["slots", "commands", "workspace", "layout", "diff", "explorer"],
  apply(ctx: Context) {
    const diffHost = gpuiDiffHost();
    const service = new GithubService(ctx, {
      client: new GithubClient(runOnHost),
      workspace: ctx.workspace,
      layout: ctx.layout,
      diffs: {
        showInEditor: (path, base) => ctx.diff.showInEditor(path, base),
        openTexts: (name, oldText, newText, label) => ctx.diff.openTexts(name, oldText, newText, label),
        headText: (path) => diffHost.baseText(path, "head"),
      },
      openUrl: openUrlOnHost,
    });
    ctx.slots.register("main", {
      id: "github",
      key: GITHUB_PANE_TYPE,
      component: GithubPane,
      props: {
        title: (leafId: string) => service.paneTitle(leafId),
        icon: githubLogo,
        github: service,
        icons: ctx.explorer,
      },
    });
    registerCommands(ctx, service);
  },
};

/** Registers the commands that open the lists and an item by number. */
function registerCommands(ctx: Context, service: GithubService): void {
  ctx.commands.register({
    id: "github.issues",
    title: "GitHub: Issues",
    group: "GitHub",
    keywords: "issue tracker bugs open list",
    run: async () => {
      await service.openList("issue");
    },
  });
  ctx.commands.register({
    id: "github.pulls",
    title: "GitHub: Pull requests",
    group: "GitHub",
    keywords: "pr pulls merge review list",
    run: async () => {
      await service.openList("pull");
    },
  });
  ctx.commands.register({
    id: "github.openByNumber",
    title: "GitHub: Open issue or PR by number",
    group: "GitHub",
    keywords: "go to jump find issue pull request number",
    run: () => service.focusSearch(),
  });
}
