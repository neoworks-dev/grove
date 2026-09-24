// Grove's own file viewers: images, video, audio, PDFs and 3D models, shown in
// the editor pane in place of nvim. Each is fetched with the first file that
// opens in it — pdf.js and three.js are most of this feature's weight.

import type { Context } from '@neoworks/extension-system'
import type { FileViewer } from '../../../lib/fileViewers.svelte'

const VIEWERS: FileViewer[] = [
  {
    id: 'core.image',
    label: 'Image',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
    load: () => import('./ImageViewer.svelte')
  },
  {
    id: 'core.video',
    label: 'Video',
    extensions: ['mp4', 'm4v', 'webm', 'mov', 'ogv'],
    load: () => import('./PlayerViewer.svelte'),
    options: 'video'
  },
  {
    id: 'core.audio',
    label: 'Audio',
    extensions: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'],
    load: () => import('./PlayerViewer.svelte'),
    options: 'audio'
  },
  {
    id: 'core.pdf',
    label: 'PDF',
    extensions: ['pdf'],
    load: () => import('./PdfViewer.svelte')
  },
  {
    id: 'core.model',
    label: '3D model',
    extensions: ['glb', 'gltf', 'stl', 'obj', 'ply', 'fbx', '3mf'],
    load: () => import('./ModelViewer.svelte')
  }
]

export const mediaViewers = {
  name: 'core/media-viewers',
  inject: ['editor'],

  apply(ctx: Context): void {
    for (const viewer of VIEWERS) {
      ctx.effect(() => ctx.editor.registerFileViewer(viewer), `viewer:${viewer.id}`)
    }
  }
}
