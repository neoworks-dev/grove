<script lang="ts">
  import { onDestroy } from 'svelte'

  let now = $state(new Date())
  const timer = setInterval(() => {
    now = new Date()
  }, 1000)
  onDestroy(() => clearInterval(timer))

  const label = $derived(
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  )
</script>

<span class="font-mono tabular-nums">{label}</span>
