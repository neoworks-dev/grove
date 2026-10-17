// Sizes for pictures in the chat.

export interface Size {
  width: number;
  height: number;
}

/** The size that fits `natural` into `max` keeping its proportions, never larger than it is. */
export function fitImage(natural: Size, max: Size): Size {
  const scale = Math.min(1, max.width / natural.width, max.height / natural.height);
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}
