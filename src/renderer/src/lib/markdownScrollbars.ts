// Floating scrollbars for the code fences inside rendered markdown.

import { mount, unmount } from 'svelte'
// Imported from the package root, not the `/FloatingScrollbar` subpath: that
// subpath resolves only through the svelte export condition, which TypeScript
// does not follow from a plain .ts module.
import { FloatingScrollbar } from '@neoworks-dev/ui'

type Decoration = {
  wrapper: HTMLElement
  scrollbar: Record<string, unknown>
}

/**
 * Svelte action giving every code fence inside `container` the NeoWorks floating
 * scrollbar instead of the native one, which otherwise appears as a grey bar
 * eating a row of the block's height whenever a line overflows the pane.
 *
 * The markdown reaches the DOM through {@html}, so the fences cannot be wrapped
 * in a component at authoring time: `renderMarkdown` emits a `.code-fence`
 * wrapper per fence and this action mounts one scrollbar overlay into each.
 * Streaming replaces the rendered HTML constantly, hence the MutationObserver.
 */
export function floatingCodeScrollbars(container: HTMLElement) {
  const decorations: Decoration[] = []

  /** Release scrollbars whose wrapper a re-render has thrown away. */
  function dropDetached(): void {
    for (let index = decorations.length - 1; index >= 0; index--) {
      if (decorations[index].wrapper.isConnected) continue
      unmount(decorations[index].scrollbar)
      decorations.splice(index, 1)
    }
  }

  function decorate(): void {
    dropDetached()
    for (const wrapper of container.querySelectorAll<HTMLElement>('.code-fence')) {
      if (wrapper.dataset.floatingScrollbar === 'on') continue
      const pre = wrapper.querySelector('pre')
      if (!pre) continue
      wrapper.dataset.floatingScrollbar = 'on'
      const scrollbar = mount(FloatingScrollbar, {
        target: wrapper,
        props: { attachTo: pre, axis: 'horizontal', class: 'absolute inset-0' }
      })
      decorations.push({ wrapper, scrollbar })
    }
  }

  decorate()
  const observer = new MutationObserver(decorate)
  observer.observe(container, { childList: true, subtree: true })

  return {
    destroy(): void {
      observer.disconnect()
      for (const decoration of decorations) unmount(decoration.scrollbar)
      decorations.length = 0
    }
  }
}
