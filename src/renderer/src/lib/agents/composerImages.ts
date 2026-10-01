// Images waiting in the composer to go out with the next message.
//
// Each holds on to the file it was attached as, beside the block that points
// at its upload: the markup editor draws on the original, never on a picture
// already marked up, and taking the marks off sends the original again. The
// thumbnails are object URLs of those files, released once the image leaves
// the draft.

import type { BlobDescriptor, ImageBlock } from './types'
import type { Mark } from './imageMarkup'

export interface ComposerImage {
  /** Stable across markup, which replaces the upload but not the attachment. */
  id: string
  original: AttachedPicture
  /** The marked-up version that is sent instead, while there is one. */
  marked: (AttachedPicture & { marks: Mark[] }) | null
}

/** One picture: its upload, the file it was, and a URL to show it by. */
export interface AttachedPicture {
  block: ImageBlock
  file: Blob
  url: string
}

let nextId = 0

/** The block a message carries for an uploaded image. */
export function imageBlockOf(blob: BlobDescriptor): ImageBlock {
  return { type: 'image', ref: blob.ref, mediaType: blob.mediaType }
}

/** A freshly attached image, not marked up. */
export function attachedImage(block: ImageBlock, file: Blob): ComposerImage {
  nextId += 1
  return { id: `image-${nextId}`, original: pictureOf(block, file), marked: null }
}

/** The image with a marked-up version to send in place of the original. */
export function withMarkup(image: ComposerImage, block: ImageBlock, file: Blob, marks: Mark[]): ComposerImage {
  releaseMarked(image)
  return { ...image, marked: { ...pictureOf(block, file), marks } }
}

/** The image back as it was attached. */
export function withoutMarkup(image: ComposerImage): ComposerImage {
  releaseMarked(image)
  return { ...image, marked: null }
}

/** What is sent for the image: the marked-up version when there is one. */
export function sentImage(image: ComposerImage): ImageBlock {
  if (image.marked) return image.marked.block
  return image.original.block
}

/** What the thumbnail shows: the version that will be sent. */
export function shownUrl(image: ComposerImage): string {
  if (image.marked) return image.marked.url
  return image.original.url
}

/** The marks on the image, to carry on from when it is opened again. */
export function marksOf(image: ComposerImage): Mark[] {
  if (image.marked) return image.marked.marks
  return []
}

/** Releases the thumbnails of images that have left the draft. */
export function forgetAttachments(images: readonly ComposerImage[]): void {
  for (const image of images) {
    releaseMarked(image)
    URL.revokeObjectURL(image.original.url)
  }
}

/** A picture with a URL to show it by. */
function pictureOf(block: ImageBlock, file: Blob): AttachedPicture {
  return { block, file, url: URL.createObjectURL(file) }
}

/** Releases the marked-up version's thumbnail, when there is one. */
function releaseMarked(image: ComposerImage): void {
  if (image.marked) URL.revokeObjectURL(image.marked.url)
}
