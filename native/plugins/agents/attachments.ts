// Images attached to the next message: the clipboard's image (Ctrl+V), or image files pasted or
// dropped as paths. The daemon takes attached images by path. Plain functions, so they are tested
// without a window. Ported from neo term (apps/term attach.rs).

/** One image attached to the draft. */
export interface Attachment {
  /** Stable while the draft lives, so removing one names it. */
  id: number;
  /** Absolute path of the image file. */
  path: string;
  /** Where the preview loads from: the daemon's URL for a copy of the file; absent until it has one. */
  source?: string;
}

/** The extensions taken as images. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

/** Whether the path names an image file by its extension. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** The last part of a path. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The image files a pasted text names, when it names nothing else: one absolute path per line,
 * perhaps quoted or as a `file://` address, as a file manager copies them. Undefined for any other text.
 */
export function pastedImagePaths(text: string): string[] | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) {
    return undefined;
  }
  const paths: string[] = [];
  for (const line of lines) {
    const path = cleanedPath(line);
    if (!path.startsWith("/") || !isImagePath(path)) {
      return undefined;
    }
    paths.push(path);
  }
  return paths;
}

/** A pasted path without its quotes, its `file://` start and its percent escapes. */
function cleanedPath(line: string): string {
  let path = line.replace(/^(['"])(.*)\1$/, "$2");
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
    try {
      path = decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  return path;
}

/** The attachments with one more, numbered after the highest. */
export function withAttachment(attachments: readonly Attachment[], path: string): Attachment[] {
  if (attachments.some((attachment) => attachment.path === path)) {
    return [...attachments];
  }
  const highest = attachments.reduce((most, attachment) => Math.max(most, attachment.id), 0);
  return [...attachments, { id: highest + 1, path }];
}
