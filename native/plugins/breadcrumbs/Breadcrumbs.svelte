<!--
  The bar above an editor: the file's path inside the worktree, then the functions, classes and
  modules around the cursor, outermost first. Pressing a scope puts the cursor at its start;
  pressing a step of the path shows it in the explorer.
-->
<script lang="ts">
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import caretRight from "@phosphor-icons/core/regular/caret-right.svg";
  import brackets from "@phosphor-icons/core/regular/brackets-curly.svg";
  import cube from "@phosphor-icons/core/regular/cube.svg";
  import fn from "@phosphor-icons/core/regular/function.svg";
  import listNumbers from "@phosphor-icons/core/regular/list-numbers.svg";
  import pack from "@phosphor-icons/core/regular/package.svg";
  import puzzle from "@phosphor-icons/core/regular/puzzle-piece.svg";
  import type { CommandsService } from "../../kernel/commands/service";
  import type { EditorService } from "../editor/service";
  import { colors, fontSize } from "../theme/tokens";
  import type { WorkspaceService } from "../workspace/service";
  import { iconNameOf, pathSteps, type Scope } from "./model";
  import type { BreadcrumbsService } from "./service";

  interface Props {
    breadcrumbs: BreadcrumbsService;
    editor: EditorService;
    workspace: WorkspaceService;
    commands: CommandsService;
    /** The pane this bar is drawn in, and the document its editor shows. */
    leafId: string;
    documentId: number;
    /** Puts the pane's cursor at a line and UTF-16 column and scrolls to it. */
    goto: (line: number, character: number) => void;
  }

  let { breadcrumbs, editor, workspace, commands, leafId, documentId, goto }: Props = $props();

  const icons: Record<string, string> = {
    cube,
    "puzzle-piece": puzzle,
    "list-numbers": listNumbers,
    package: pack,
    "brackets-curly": brackets,
    function: fn,
  };

  const buffer = $derived(editor.tabsIn(leafId).find((tab) => tab.id === documentId));
  const worktree = $derived(workspace.selectedWorktree());
  const steps = $derived(pathSteps(buffer === undefined ? "" : buffer.path, worktree === null ? null : worktree.path));
  const scopes = $derived(breadcrumbs.scopesOf(documentId));

  /** Puts the cursor at the start of a scope. */
  function jumpTo(scope: Scope): void {
    editor.focusPane(leafId);
    goto(scope.start.row, scope.startCharacter);
  }

  /** Shows a step of the path in the explorer. */
  function reveal(relativePath: string): void {
    void commands.run("explorer.reveal", relativePath);
  }
</script>

{#if steps.length > 0}
  <View
    style={{
      direction: "row",
      align: "center",
      height: 24,
      shrink: 0,
      paddingX: 8,
      gap: 2,
      overflow: "hidden",
      fontSize: fontSize.xs,
      color: colors.dim,
      borderBottomWidth: 1,
      borderColor: colors.line,
    }}
  >
    {#each steps as step, index (step.relativePath)}
      {#if index > 0}
        <Icon svg={caretRight} size={10} color={colors.faint} />
      {/if}
      <Button
        style={{ shrink: 0, paddingX: 3, paddingY: 2, radius: 3, color: step.isFile ? colors.text : colors.dim }}
        hover={{ color: colors.text, background: colors.hover }}
        onpress={() => reveal(step.relativePath)}
      >
        <Text style={{ nowrap: true }}>{step.name}</Text>
      </Button>
    {/each}
    {#each scopes as scope, index (`${index}:${scope.kind}:${scope.name}`)}
      <Icon svg={caretRight} size={10} color={colors.faint} />
      <Button
        style={{ shrink: 0, direction: "row", align: "center", gap: 4, paddingX: 3, paddingY: 2, radius: 3, color: colors.dim }}
        hover={{ color: colors.text, background: colors.hover }}
        onpress={() => jumpTo(scope)}
      >
        <Icon svg={icons[iconNameOf(scope.kind)]} size={11} />
        <Text style={{ nowrap: true }}>{scope.name}</Text>
      </Button>
    {/each}
  </View>
{/if}
