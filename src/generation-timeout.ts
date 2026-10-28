export const UPSTREAM_TIMEOUT_HINT = '上游可能已扣费或仍在生成，请到服务商后台确认'

export class GenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`生图超时（${String(timeoutMs / 1000)} 秒未返回），请检查网络或代理后重试；${UPSTREAM_TIMEOUT_HINT}`)
    this.name = 'GenerationTimeoutError'
  }
}

export async function withGenerationTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const watchdog = new AbortController()
  const combinedSignal = AbortSignal.any([signal, watchdog.signal])
  const timeout = setTimeout(() => { watchdog.abort() }, timeoutMs)
  timeout.unref?.()
  try {
    return await operation(combinedSignal)
  } catch (error) {
    if (watchdog.signal.aborted && !signal.aborted) throw new GenerationTimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
