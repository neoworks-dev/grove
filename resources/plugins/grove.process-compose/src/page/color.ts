// Theme colours in the one format xterm's search highlights accept. Grove's
// tokens can be any CSS colour (oklch, color-mix, …); painting one pixel and
// reading it back turns whatever the browser understands into #RRGGBB.

let canvas: HTMLCanvasElement | null = null

/** A CSS colour as #RRGGBB, or the fallback when the browser can't paint it. */
export function toHexColor(color: string, fallback: string): string {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
  }
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return fallback
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = fallback
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** `color` laid over `base` at `weight` (0–1), as #RRGGBB. Both must be #RRGGBB. */
export function mixHexColors(color: string, base: string, weight: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const top = parseInt(color.slice(offset, offset + 2), 16)
    const bottom = parseInt(base.slice(offset, offset + 2), 16)
    return Math.round(top * weight + bottom * (1 - weight))
  })
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}
