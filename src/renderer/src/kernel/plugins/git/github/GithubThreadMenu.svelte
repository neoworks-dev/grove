<script lang="ts">
  // The thread header's … menu: what is done to an item rather than said about
  // it. Following the thread, locking it, and for an issue pinning, cloning,
  // transferring and deleting it. Locking, transferring and deleting each name
  // what is about to happen before they run.
  import BellIcon from 'phosphor-svelte/lib/BellIcon'
  import BellSlashIcon from 'phosphor-svelte/lib/BellSlashIcon'
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon'
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon'
  import LockIcon from 'phosphor-svelte/lib/LockIcon'
  import LockOpenIcon from 'phosphor-svelte/lib/LockOpenIcon'
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon'
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import ArrowsLeftRightIcon from 'phosphor-svelte/lib/ArrowsLeftRightIcon'
  import type { Component } from 'svelte'
  import GithubMenu from './GithubMenu.svelte'
  import {
    github,
    cloneIssue,
    isSubscribed,
    runCommand,
    toggleSubscription,
    transferIssue
  } from './store.svelte'
  import type { GithubItemDetail } from '../../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  let transferring = $state(false)
  let transferTo = $state('')

  // Says why following is off rather than leaving a dead entry to guess at.
  const subscriptionTitle = $derived.by<string | undefined>(() => {
    if (github.capabilities.notifications) return undefined
    return 'Changing it needs the notifications scope: gh auth refresh -s notifications'
  })

  /** Runs an entry and puts the menu away. */
  function run(close: () => void, action: () => unknown): void {
    close()
    void action()
  }

  /** Transfers the issue, then closes the menu if it went through. */
  async function transfer(close: () => void): Promise<void> {
    const destination = transferTo.trim()
    if (destination.length === 0) return
    const moved = await transferIssue(destination)
    if (!moved) return
    transferTo = ''
    transferring = false
    close()
  }
</script>

{#snippet entry(
  label: string,
  icon: Component<{ size?: number }>,
  action: () => void,
  options: { danger?: boolean; disabled?: boolean; title?: string } = {}
)}
  {@const Icon = icon}
  <button
    class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-hover disabled:opacity-50"
    class:text-red={options.danger === true}
    class:text-default={options.danger !== true}
    disabled={github.busy || options.disabled === true}
    title={options.title}
    onclick={action}
  >
    <Icon size={12} />
    {label}
  </button>
{/snippet}

<GithubMenu label="More actions" align="right" disabled={github.busy}>
  {#snippet trigger()}
    <DotsThreeIcon size={14} class="text-dim" />
  {/snippet}
  {#snippet children(close)}
    <div class="flex flex-col">
      {#if isSubscribed(detail)}
        {@render entry('Unsubscribe', BellSlashIcon, () => run(close, toggleSubscription), {
          disabled: !github.capabilities.notifications,
          title: subscriptionTitle
        })}
      {:else}
        {@render entry('Subscribe', BellIcon, () => run(close, toggleSubscription), {
          disabled: !github.capabilities.notifications,
          title: subscriptionTitle
        })}
      {/if}

      {#if detail.locked}
        {@render entry('Unlock conversation', LockOpenIcon, () =>
          run(close, () => runCommand('unlock'))
        )}
      {:else}
        {@render entry('Lock conversation', LockIcon, () => run(close, () => runCommand('lock')))}
      {/if}

      {#if detail.kind === 'issue'}
        {#if detail.isPinned}
          {@render entry('Unpin issue', PushPinSlashIcon, () =>
            run(close, () => runCommand('unpin'))
          )}
        {:else}
          {@render entry('Pin issue', PushPinIcon, () => run(close, () => runCommand('pin')))}
        {/if}
        {@render entry('Clone issue', CopyIcon, () => run(close, cloneIssue))}

        {#if transferring}
          <div class="flex flex-col gap-1 px-1.5 py-1">
            <input
              class="w-full rounded-md border border-line bg-input px-2 py-1 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
              placeholder="owner/repo"
              bind:value={transferTo}
              onkeydown={(event) => event.key === 'Enter' && transfer(close)}
            />
            <button
              class="w-full rounded-md bg-action px-2 py-1 text-xs text-action-fg hover:opacity-90 disabled:opacity-50"
              disabled={github.busy || transferTo.trim().length === 0}
              onclick={() => transfer(close)}
            >
              Transfer
            </button>
          </div>
        {:else}
          {@render entry('Transfer issue…', ArrowsLeftRightIcon, () => (transferring = true))}
        {/if}

        <div class="my-1 border-t border-line"></div>
        {@render entry('Delete issue', TrashIcon, () => run(close, () => runCommand('delete')), {
          danger: true
        })}
      {/if}
    </div>
  {/snippet}
</GithubMenu>
