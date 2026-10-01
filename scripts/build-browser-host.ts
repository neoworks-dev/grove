// Bundles the browser extension's native-messaging host (src/browserHost/) into
// one CommonJS file that Grove's Electron binary runs as plain Node:
// resources/browser-host/dist/host.cjs, which ships beside the app.
// Run with: bun scripts/build-browser-host.ts

import { join } from 'path'

const root = join(import.meta.dir, '..')

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'browserHost', 'host.ts')],
  outdir: join(root, 'resources', 'browser-host', 'dist'),
  target: 'node',
  format: 'cjs',
  naming: 'host.cjs'
})
if (!result.success) {
  console.error('build failed for the browser host:')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log('built resources/browser-host/dist/host.cjs')
