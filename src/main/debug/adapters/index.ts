// Grove's own debug adapters, one plugin each, registered into the adapter
// registry the way agent harnesses are. Adding an adapter means adding a
// descriptor here; one Mason installs that nobody describes still works
// through the registry's generic stdio fallback.

import type { Context } from '@neoworks/extension-system'
import type { DebugAdapterDescriptor } from '../registry'
import { debugpy } from './python'
import { jsDebug } from './javascript'
import { codelldb, delve, gdb, lldbDap } from './native'

/** A kernel plugin that registers one adapter for as long as it is loaded. */
function adapterPlugin(descriptor: DebugAdapterDescriptor): {
  name: string
  inject: string[]
  apply(ctx: Context): void
} {
  return {
    name: `main/debug/adapters/${descriptor.id}`,
    inject: ['debugAdapters'],
    apply(ctx: Context): void {
      ctx.effect(() => ctx.debugAdapters.register(descriptor), `debug-adapter:${descriptor.id}`)
    }
  }
}

export const debugAdapterPlugins = [debugpy, jsDebug, codelldb, delve, gdb, lldbDap].map(
  (descriptor) => adapterPlugin(descriptor)
)
