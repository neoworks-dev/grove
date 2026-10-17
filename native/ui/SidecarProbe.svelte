<!--
  Proof that the sidecar works end to end, until the shell's own views replace it: it
  opens a repository through Grove's main process, shows the current branch and the
  files in the root, and refreshes both when the file watcher or git push an event.
-->
<script lang="ts">
  import { invoke } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { connectSidecar } from "../sidecar-client";

  interface FileNode {
    name: string;
    isDir: boolean;
  }

  interface FsChange {
    type: string;
    relPath: string;
  }

  const { client, workbench } = connectSidecar();

  let status = $state("connecting to the sidecar");
  let branch = $state("");
  let files = $state<FileNode[]>([]);
  let changedCount = $state(0);
  let lastChange = $state("");
  let pushedEvents = $state(0);
  let worktreeId = "";

  /** Reads the files in the repository root and the number of changed files from the sidecar. */
  async function refresh(): Promise<void> {
    files = (await workbench.files.listDir(worktreeId, "")) as FileNode[];
    changedCount = ((await workbench.git.changedFiles(worktreeId)) as unknown[]).length;
  }

  /** Remembers what the watcher reported, and reads the repository again. */
  function onFsChange(change: unknown): void {
    const { type, relPath } = change as FsChange;
    pushedEvents += 1;
    lastChange = `${type} ${relPath}`;
    void refresh();
  }

  /** Opens the repository, starts watching it, and shows what is in it. */
  async function start(): Promise<void> {
    const info = await client.info();
    status = `sidecar pid ${info.pid}, ${info.channels.length} routes`;
    const repoPath = await invoke<string>("initial_repo");
    const opened = (await workbench.repo.open(repoPath)) as {
      info: { currentBranch: string };
      worktrees: { id: string; path: string }[];
    };
    branch = opened.info.currentBranch;
    worktreeId = opened.worktrees.find((worktree) => worktree.path === repoPath)?.id ?? repoPath;
    workbench.on("event:fs-change", onFsChange);
    await workbench.fs.watch([worktreeId]);
    await refresh();
  }

  /** Says why the sidecar is unusable: the host's account of how it ended, else the call's own error. */
  async function explain(error: Error): Promise<void> {
    const hostStatus = await client.status();
    status = hostStatus.message ?? `sidecar failed: ${error.message}`;
  }

  start().catch(explain);
  client.onExit((exit) => {
    status = exit.message;
  });
</script>

<View style={{ width: 300, padding: 12, gap: 6, background: "#111113" }}>
  <Text style={{ color: "#a1a1aa", fontSize: 11 }}>{status}</Text>
  <Text style={{ color: "#f4f4f5", fontSize: 14, fontWeight: "bold" }}>branch: {branch}</Text>
  <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{changedCount} changed files</Text>
  <Text style={{ color: "#a1a1aa", fontSize: 12 }}>
    {pushedEvents} watcher events{lastChange ? `, last: ${lastChange}` : ""}
  </Text>
  {#each files as file (file.name)}
    <Text style={{ color: file.isDir ? "#93c5fd" : "#e4e4e7", fontSize: 12 }}>
      {file.isDir ? "▸ " : "  "}{file.name}
    </Text>
  {/each}
</View>
