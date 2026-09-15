// What a terminal printed while nobody was watching.
//
// The daemon keeps each session's recent output so a grove that starts up long
// after the shell did can replay it into xterm, which is what makes a restored
// tab look like the one that was there before rather than an empty prompt.

/** Roughly a screenful of history for a wide terminal, and cheap to hold. */
export const SCROLLBACK_LIMIT = 256 * 1024

export class Scrollback {
  private chunks: string[] = []
  private length = 0

  constructor(private limit = SCROLLBACK_LIMIT) {}

  append(chunk: string): void {
    this.chunks.push(chunk)
    this.length += chunk.length
    this.trim()
  }

  text(): string {
    return this.chunks.join('')
  }

  /**
   * Drop whole chunks from the front, then split the one that straddles the
   * limit. Cutting mid-escape-sequence is possible and harmless: xterm ignores
   * a sequence it cannot parse, and the shell redraws over it.
   */
  private trim(): void {
    while (this.length > this.limit && this.chunks.length > 0) {
      const oldest = this.chunks[0]
      const excess = this.length - this.limit
      if (oldest.length > excess) {
        this.chunks[0] = oldest.slice(excess)
        this.length -= excess
        return
      }
      this.chunks.shift()
      this.length -= oldest.length
    }
  }
}
