<script lang="ts">
  // Asking for a provider's key.
  //
  // Deliberately not the overlay: that is a search field, and a key typed into
  // one is echoed, filtered on and held in a query store. This takes it in a
  // password field, hands it straight to main, and keeps nothing. Grove never
  // reads a stored key back — the renderer only ever learns that one exists.

  let {
    provider,
    variables,
    onClose
  }: {
    /** Whose key this is — the keys differ per provider, so the name matters. */
    provider: string
    /** The environment variable names the route will accept, in order. */
    variables: string[]
    /** Told whether anything was stored, so the catalog can be re-read. */
    onClose: (stored: boolean) => void
  } = $props()

  let value = $state('')
  let error = $state('')
  let storable = $state(true)
  let saving = $state(false)

  const name = $derived(variables[0] ?? '')

  // Whether the platform can encrypt at all decides what this dialog can offer:
  // with no keychain there is nowhere safe to put a key, and saying so beats
  // writing one out in the clear.
  $effect(() => {
    void window.workbench.secrets.status(variables).then((status) => {
      storable = status.storable
    })
  })

  async function save(): Promise<void> {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    saving = true
    try {
      await window.workbench.secrets.set(name, trimmed)
      value = ''
      onClose(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="w-96 rounded-md border border-line bg-elevated p-3 shadow-lg">
    <div class="text-xs font-medium text-default">{provider} needs a key</div>
    <p class="mt-1 text-2xs leading-snug text-dim">
      Sessions on this provider sign in with
      <span class="font-mono text-default">{name}</span>, which is that provider's own key and no
      other's. Grove stores it encrypted with the OS keychain, and never reads it back into the
      interface.
    </p>

    {#if storable}
      <input
        class="mt-2 w-full rounded border border-line bg-surface px-1.5 py-1 font-mono text-2xs text-default"
        type="password"
        placeholder={name}
        autocomplete="off"
        bind:value
        onkeydown={(event) => {
          if (event.key === 'Enter') void save()
          if (event.key === 'Escape') onClose(false)
        }}
      />
    {:else}
      <p class="mt-2 rounded border border-amber/30 bg-amber-soft px-1.5 py-1 text-2xs text-amber">
        No OS keychain is available here, so grove will not store a key. Export
        <span class="font-mono">{name}</span> in the environment grove is started from instead.
      </p>
    {/if}

    {#if error}
      <p class="mt-2 text-2xs text-red">{error}</p>
    {/if}

    <div class="mt-3 flex justify-end gap-2 text-2xs">
      <button
        class="rounded border border-line px-2 py-1 hover:bg-hover"
        onclick={() => onClose(false)}
      >
        Cancel
      </button>
      {#if storable}
        <button
          class="rounded border border-accent px-2 py-1 text-accent hover:bg-hover disabled:opacity-50"
          disabled={saving || value.trim().length === 0}
          onclick={() => void save()}
        >
          Save
        </button>
      {/if}
    </div>
  </div>
</div>
