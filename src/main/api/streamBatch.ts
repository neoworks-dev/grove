// Batches high-frequency stream items into chunks so per-item pushes don't
// flood the transport: flushes when a batch fills or after a short delay.

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_DELAY_MS = 60

export interface StreamBatcher<T> {
  push: (item: T) => void
  flush: () => void
}

export function createStreamBatcher<T>(
  emit: (items: T[]) => void,
  options: { batchSize?: number; delayMs?: number } = {}
): StreamBatcher<T> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  let batch: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (batch.length === 0) return
    emit(batch)
    batch = []
  }

  const push = (item: T): void => {
    batch.push(item)
    if (batch.length >= batchSize) {
      flush()
      return
    }
    if (!timer) timer = setTimeout(flush, delayMs)
  }

  return { push, flush }
}
