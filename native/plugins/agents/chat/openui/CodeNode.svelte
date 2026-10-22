<script lang="ts">
  import CodeBlock from "../CodeBlock.svelte";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
</script>

<CodeBlock code={str(node, "code") ?? ""} language={str(node, "language")} fenced />
