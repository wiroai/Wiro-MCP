import { WiroApiError } from '../client.js';
import { ApiResultError } from './api.js';

// Bounded polling for the endpoints that finish asynchronously (agent
// messages, workflow runs, agent start-up). A tool waits for a limited time and
// then hands back a nextAction, because most MCP clients time out a tool call
// after about a minute.

export const DEFAULT_WAIT_SECONDS = 45;
export const MAX_WAIT_SECONDS = 600;

export interface ToolCallContext {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

export interface PollOptions<T> {
  read: (signal: AbortSignal) => Promise<T>;
  isDone: (value: T) => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Delay before the next read; defaults to 2 s, then 5 s after 15 s, then 10 s after 60 s. */
  interval?: (elapsedMs: number) => number;
  /** Errors that only mean "not visible yet" and should be read again. */
  isRetryable?: (error: unknown, elapsedMs: number) => boolean;
  onPoll?: (value: T, elapsedMs: number) => void | Promise<void>;
  maxConsecutiveErrors?: number;
}

export interface PollResult<T> {
  value?: T;
  done: boolean;
  elapsedMs: number;
}

export function defaultInterval(elapsedMs: number): number {
  if (elapsedMs < 15_000) return 2_000;
  if (elapsedMs < 60_000) return 5_000;
  return 10_000;
}

/** 3 s, growing by half each time, capped at 15 s. Used for workflow runs. */
export function slowInterval(elapsedMs: number): number {
  let delay = 3_000;
  let total = 0;
  while (total + delay < elapsedMs && delay < 15_000) {
    total += delay;
    delay = Math.min(15_000, Math.round(delay * 1.5));
  }
  return delay;
}

function isTransientHttpError(error: unknown): boolean {
  // A result:false body is an answer, not a transport failure.
  if (error instanceof ApiResultError) return false;
  if (!(error instanceof WiroApiError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<PollResult<T>> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
  let consecutiveErrors = 0;
  let value: T | undefined;

  for (;;) {
    throwIfAborted(options.signal);
    try {
      value = await options.read(options.signal ?? new AbortController().signal);
      consecutiveErrors = 0;
      const elapsedMs = Date.now() - startedAt;
      await options.onPoll?.(value, elapsedMs);
      if (options.isDone(value)) return { value, done: true, elapsedMs };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const elapsedMs = Date.now() - startedAt;
      const retryable = options.isRetryable?.(error, elapsedMs) ?? false;
      if (!retryable) {
        consecutiveErrors += 1;
        if (!isTransientHttpError(error) || consecutiveErrors >= maxConsecutiveErrors) {
          throw error;
        }
      }
    }

    const now = Date.now();
    if (now >= deadline) return { value, done: false, elapsedMs: now - startedAt };
    const delay = (options.interval ?? defaultInterval)(now - startedAt);
    await sleep(Math.min(delay, deadline - now), options.signal);
  }
}

export async function reportProgress(
  extra: ToolCallContext | undefined,
  elapsedMs: number,
  message: string,
): Promise<void> {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await extra!.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: elapsedMs / 1000, message },
    });
  } catch {
    // Progress is best-effort and must never interrupt polling.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('The wait was cancelled by the client');
    error.name = 'AbortError';
    throw error;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const error = new Error('The wait was cancelled by the client');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
