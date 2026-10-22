// Where an OpenUI picture comes from. A source is an `asset://` handle, a local path, a `file://`
// URL, a `data:` URL or an `http(s)://` URL, which the daemon downloads into its asset store (the
// window never fetches a URL itself).

export type Source =
  | { kind: "asset"; handle: string }
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "data"; url: string };

/** What a source is, with paths made absolute against the session's directory. */
export function sourceOf(src: string, cwd: string): Source {
  const text = src.trim();
  if (/^asset:\/\//i.test(text)) return { kind: "asset", handle: text };
  if (/^https?:\/\//i.test(text)) return { kind: "web", url: text };
  if (/^data:/i.test(text)) return { kind: "data", url: text };
  const path = text.replace(/^file:\/\//i, "");
  if (path.startsWith("/") || path.startsWith("~")) return { kind: "file", path };
  return { kind: "file", path: `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}` };
}

/** The last part of a path or URL, for the name under a picture. */
export function pictureName(src: string, alt: string | undefined): string {
  const named = alt?.replace(/\s+/g, " ").trim();
  if (named) return named;
  const clean = src.split(/[?#]/)[0] ?? src;
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}

/** The large picture and up to three small ones of a gallery, and how many are left out. */
export function galleryParts<T>(images: readonly T[]): {
  large: T | undefined;
  small: T[];
  more: number;
} {
  return { large: images[0], small: images.slice(1, 4), more: Math.max(0, images.length - 4) };
}

const fetched = new Map<string, Promise<string>>();

/** The asset handle of a downloaded web image: each URL is asked for once, a failure may be retried. */
export function downloaded(url: string, fetch: (url: string) => Promise<string>): Promise<string> {
  const known = fetched.get(url);
  if (known !== undefined) return known;
  const started = fetch(url);
  fetched.set(url, started);
  started.catch(() => fetched.delete(url));
  return started;
}
