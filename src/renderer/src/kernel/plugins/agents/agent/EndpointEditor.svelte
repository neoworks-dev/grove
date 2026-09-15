<script lang="ts">
  // Adding an endpoint of your own.
  //
  // Anything that speaks the Anthropic Messages API can host a session: a
  // gateway such as OpenRouter, a LiteLLM container, a local model behind a
  // translating proxy. All grove needs is the base URL and, where the thing
  // charges money, which variable its key lives under — the key itself goes to
  // the secrets store and never comes back.
  //
  // The endpoint is asked what it serves before it is saved, so a typo in the
  // URL is caught here rather than at the first turn.

  import type { CustomEndpoint } from '../../../../lib/agents/types'

  let {
    onClose
  }: {
    /** Told whether anything was saved, so the catalog can be re-read. */
    onClose: (saved: boolean) => void
  } = $props()

  let label = $state('')
  let baseUrl = $state('')
  let key = $state('')
  let models = $state('')
  let probing = $state(false)
  let probed = $state<string[] | null>(null)
  let error = $state('')

  const id = $derived(slugOf(label))
  const keyVariable = $derived(id ? `GROVE_ENDPOINT_${id.toUpperCase().replace(/-/g, '_')}` : '')

  /** A name a provider id can be made of, since the id keys every route. */
  function slugOf(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  }

  function listedModels(): string[] {
    return models
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  /** Ask the endpoint what it serves, so the dialog can say whether it answers. */
  async function probe(): Promise<void> {
    if (!baseUrl.trim()) return
    probing = true
    error = ''
    try {
      if (key.trim()) await window.workbench.secrets.set(keyVariable, key.trim())
      const result = await window.workbench.endpoints.probe(
        baseUrl.trim(),
        key.trim() ? keyVariable : undefined
      )
      probed = result.models
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      probing = false
    }
  }

  async function save(): Promise<void> {
    if (!id || !baseUrl.trim()) return
    error = ''
    try {
      if (key.trim()) await window.workbench.secrets.set(keyVariable, key.trim())
      const endpoint: CustomEndpoint = {
        id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        keyVariable: key.trim() ? keyVariable : undefined,
        models: listedModels()
      }
      await window.workbench.endpoints.save(endpoint)
      onClose(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="w-[28rem] rounded-md border border-line bg-elevated p-3 shadow-lg">
    <div class="text-xs font-medium text-default">Add an endpoint</div>
    <p class="mt-1 text-2xs leading-snug text-dim">
      Any base URL that speaks the Anthropic Messages API — OpenRouter, a LiteLLM or
      claude-code-router instance, a local model behind one of those. Sessions on it are billed to
      that account, not yours.
    </p>

    <label class="mt-3 block text-2xs text-dim">
      Name
      <input
        class="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-2xs text-default"
        placeholder="OpenRouter"
        bind:value={label}
      />
    </label>

    <label class="mt-2 block text-2xs text-dim">
      Base URL
      <input
        class="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 font-mono text-2xs text-default"
        placeholder="https://openrouter.ai/api/v1"
        bind:value={baseUrl}
      />
    </label>

    <label class="mt-2 block text-2xs text-dim">
      Key <span class="opacity-70">— leave empty for an endpoint that needs none</span>
      <input
        class="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 font-mono text-2xs text-default"
        type="password"
        autocomplete="off"
        placeholder="sk-or-…"
        bind:value={key}
      />
    </label>

    <label class="mt-2 block text-2xs text-dim">
      Models <span class="opacity-70">— optional; the endpoint is asked as well</span>
      <input
        class="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 font-mono text-2xs text-default"
        placeholder="moonshotai/kimi-k2, qwen/qwen3-coder"
        bind:value={models}
      />
    </label>

    {#if probed !== null}
      <p class="mt-2 text-2xs text-dim">
        {#if probed.length > 0}
          Answers, and serves {probed.length} models.
        {:else}
          Answers, but lists no models — name the ones you want above.
        {/if}
      </p>
    {/if}

    {#if error}
      <p class="mt-2 text-2xs text-red">{error}</p>
    {/if}

    <div class="mt-3 flex items-center justify-end gap-2 text-2xs">
      <button
        class="mr-auto rounded border border-line px-2 py-1 hover:bg-hover disabled:opacity-50"
        disabled={probing || baseUrl.trim().length === 0}
        onclick={() => void probe()}
      >
        {probing ? 'Asking…' : 'Test'}
      </button>
      <button
        class="rounded border border-line px-2 py-1 hover:bg-hover"
        onclick={() => onClose(false)}
      >
        Cancel
      </button>
      <button
        class="rounded border border-accent px-2 py-1 text-accent hover:bg-hover disabled:opacity-50"
        disabled={id.length === 0 || baseUrl.trim().length === 0}
        onclick={() => void save()}
      >
        Save
      </button>
    </div>
  </div>
</div>
