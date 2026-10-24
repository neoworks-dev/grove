<!--
  A GitHub pane: the issues or pull requests of a repository as a list, or one of them as a page.
  Everything is read through the person's own `gh` login, and nothing is written to GitHub. The
  pane's place is in the layout's pane state, so a restored layout comes back to the same list or item.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { FileIconSource } from "../explorer/fileIcons";
  import { colors } from "../theme/tokens";
  import ItemList from "./ItemList.svelte";
  import ItemPage from "./ItemPage.svelte";
  import { parseReference, type ItemKind, type ItemSummary, type ListFilter, type PullFile } from "./model";
  import type { GithubService } from "./service";
  import Toolbar from "./Toolbar.svelte";
  import Unavailable from "./Unavailable.svelte";

  interface Props {
    github: GithubService;
    /** Where the changed files take their icons from. */
    icons: FileIconSource;
    /** The pane this is drawn in. */
    leafId?: string;
  }

  let { github, icons, leafId = "main" }: Props = $props();

  const view = $derived(github.view(leafId));
  const focusRequest = $derived(github.focusRequest());

  // A pane restored with the layout, or just split off another, reads what it shows.
  $effect(() => {
    void github.ensureLoaded(leafId);
  });

  /** What was typed in the box: an item to go to, or text to search the list for. */
  function submit(text: string): void {
    const reference = parseReference(text);
    if (reference === null) {
      void github.setSearch(leafId, text.trim());
      return;
    }
    let repo = reference.repo;
    if (repo === null) {
      repo = view.place.repo;
    }
    void github.showReference(leafId, { repo, number: reference.number, kind: reference.kind });
  }
</script>

<View style={{ flex: 1, minHeight: 0, background: colors.surface }}>
  <Toolbar
    {view}
    {focusRequest}
    onkind={(kind: ItemKind) => void github.setListKind(leafId, kind)}
    onfilter={(filter: ListFilter) => void github.setFilter(leafId, filter)}
    onsubmit={submit}
    onback={() => void github.back(leafId)}
    onreload={() => void github.reload(leafId)}
    onbrowser={() => github.openInBrowser(leafId)}
  />
  {#if view.failure !== null}
    <Unavailable failure={view.failure} onretry={() => void github.reload(leafId)} />
  {:else if view.place.view === "item"}
    <ItemPage
      item={view.item}
      {icons}
      onbrowser={() => github.openInBrowser(leafId)}
      onfile={(file: PullFile) => void github.openFile(leafId, file)}
    />
  {:else}
    <ItemList list={view.list} kind={view.place.listKind} onopen={(item: ItemSummary) => void github.showItem(leafId, item)} />
  {/if}
</View>
