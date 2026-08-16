/**
 * Web Worker entry point for the Make-sense pipeline.
 *
 * This file has two roles that the bundler selects between based on
 * execution context:
 *
 *  1. **Worker context** — the `self.addEventListener` block below runs
 *     inside a Web Worker spawned by `MakeSenseWorker`. It listens for
 *     `{ type: 'run', payload: MakeSenseInput }` messages, drives
 *     `makeSenseInline`, and posts progress / complete / error frames
 *     back to the main thread.
 *
 *  2. **Main-thread context** — the `MakeSenseWorker` class wraps a real
 *     `Worker` and exposes a promise-based API to the conductor. It is
 *     safe to import from a UI module: bundlers will tree-shake out the
 *     worker-context code when they detect it isn't being reached from
 *     the main bundle.
 *
 * The two halves share nothing mutable. There is no global state, only
 * module-scope listeners that the worker side installs once.
 */

import type { MakeSenseInput, MakeSenseResult, StepResult } from './types'
import { makeSenseInline } from './makeSense_inline'

// ---------------------------------------------------------------------------
// Worker context
// ---------------------------------------------------------------------------

interface RunMessage {
  type: 'run'
  payload: MakeSenseInput
}

interface ProgressMessage {
  type: 'progress'
  step: StepResult
}

interface CompleteMessage {
  type: 'complete'
  result: MakeSenseResult
}

interface ErrorMessage {
  type: 'error'
  message: string
}

type OutboundMessage = ProgressMessage | CompleteMessage | ErrorMessage

/**
 * Type guard for the inbound `run` frame. Anything else is ignored so
 * the worker stays robust against malformed posts.
 */
function isRunMessage(data: unknown): data is RunMessage {
  if (typeof data !== 'object' || data === null) return false
  const m = data as { type?: unknown; payload?: unknown }
  if (m.type !== 'run') return false
  if (typeof m.payload !== 'object' || m.payload === null) return false
  const p = m.payload as { mask?: unknown; meta?: unknown }
  if (!(p.mask instanceof Float32Array)) return false
  if (typeof p.meta !== 'object' || p.meta === null) return false
  return true
}

declare const self: {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
  postMessage(message: OutboundMessage): void
  onmessage: ((event: { data: unknown }) => void) | null
}

self.addEventListener('message', async (event: { data: unknown }) => {
  if (!isRunMessage(event.data)) return
  const payload = event.data.payload
  try {
    const result = await makeSenseInline(payload, (step) => {
      self.postMessage({ type: 'progress', step })
    })
    self.postMessage({ type: 'complete', result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    self.postMessage({ type: 'error', message })
  }
})

// ---------------------------------------------------------------------------
// Main-thread wrapper
// ---------------------------------------------------------------------------

/** Inbound frame types the wrapper recognises. */
type Frame =
  | { type: 'progress'; step: StepResult }
  | { type: 'complete'; result: MakeSenseResult }
  | { type: 'error'; message: string }

/** Progress handler signature; receives each step as it lands. */
export type ProgressHandler = (step: StepResult) => void

/** Result handler signature; receives the final `MakeSenseResult`. */
export type CompleteHandler = (result: MakeSenseResult) => void

/** Error handler signature; receives the stringified error. */
export type ErrorHandler = (message: string) => void

/**
 * Promise-based wrapper around the Make-sense Web Worker.
 *
 * Single-shot: one `run()` call drives one pipeline execution. Call
 * `terminate()` to kill the underlying worker. Progress handlers may be
 * registered before or after `run()` returns; they fire for every step
 * the worker emits.
 *
 * Falls back gracefully: if `Worker` is not defined (older runtimes,
 * SSR, tests), `MakeSenseWorker` is constructed but every `run()` call
 * rejects with a clear message instead of silently failing.
 */
export class MakeSenseWorker {
  private readonly worker: Worker | null
  private readonly progressHandlers: Set<ProgressHandler> = new Set()
  private activeRun:
    | {
        resolve: (result: MakeSenseResult) => void
        reject: (err: Error) => void
      }
    | null = null

  constructor() {
    this.worker = createWorker()
    if (this.worker) {
      this.worker.addEventListener('message', this.handleMessage as EventListener)
      this.worker.addEventListener('error', this.handleWorkerError as EventListener)
    }
  }

  /**
   * Whether the wrapper actually has a live worker underneath.
   * `false` in environments without `Worker` (e.g. happy-dom tests).
   */
  get available(): boolean {
    return this.worker !== null
  }

  /**
   * Subscribe to progress frames. Returns an unsubscribe function.
   * Multiple handlers may be registered concurrently.
   */
  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.add(handler)
    return () => {
      this.progressHandlers.delete(handler)
    }
  }

  /**
   * Drive the pipeline. Resolves with the final `MakeSenseResult`,
   * rejects if the worker errors or the mask lock trips.
   */
  run(input: MakeSenseInput): Promise<MakeSenseResult> {
    return new Promise<MakeSenseResult>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('MakeSenseWorker: Web Worker unavailable in this environment'))
        return
      }
      if (this.activeRun !== null) {
        reject(new Error('MakeSenseWorker: a run is already in progress'))
        return
      }
      this.activeRun = { resolve, reject }
      this.worker.postMessage({ type: 'run', payload: input })
    })
  }

  /** Kill the underlying worker. Subsequent `run()` calls will reject. */
  terminate(): void {
    if (!this.worker) return
    this.worker.terminate()
    if (this.activeRun !== null) {
      this.activeRun.reject(new Error('MakeSenseWorker: terminated'))
      this.activeRun = null
    }
  }

  // -- Internal message handling ------------------------------------------

  private readonly handleMessage = (event: MessageEvent<Frame>): void => {
    const frame = event.data
    switch (frame.type) {
      case 'progress':
        for (const handler of this.progressHandlers) handler(frame.step)
        break
      case 'complete':
        if (this.activeRun !== null) {
          this.activeRun.resolve(frame.result)
          this.activeRun = null
        }
        break
      case 'error':
        if (this.activeRun !== null) {
          this.activeRun.reject(new Error(frame.message))
          this.activeRun = null
        }
        break
    }
  }

  private readonly handleWorkerError = (event: Event): void => {
    if (this.activeRun === null) return
    const message =
      'message' in event && typeof (event as { message?: unknown }).message === 'string'
        ? ((event as { message: string }).message)
        : 'MakeSenseWorker: worker error'
    this.activeRun.reject(new Error(message))
    this.activeRun = null
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Build the underlying `Worker`. Reads its own source via the
 * `new URL(..., import.meta.url)` pattern so Vite ships the worker as a
 * separate ES-module chunk. Returns `null` when `Worker` is undefined
 * (SSR, older runtimes, tests).
 */
function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./makeSense.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    return null
  }
}