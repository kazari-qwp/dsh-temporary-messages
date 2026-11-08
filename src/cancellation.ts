export async function withCancellation<T>(run: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return run()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([Promise.resolve().then(run), cancelled])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
