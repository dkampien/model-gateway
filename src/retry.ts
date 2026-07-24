/**
 * Exponential backoff with jitter, gated on error classification.
 * Only rate_limit and transient errors are retried; everything else is
 * rethrown immediately. Jitter (plus/minus 25 percent) prevents synchronized
 * retry storms when a batch fails in parallel.
 *
 * Note on layering: both provider SDKs retry some errors internally
 * (fal: 429/502/503/504; replicate: GETs on 429/5xx, POSTs on 429 only).
 * This layer sits above those and retries the whole operation, so attempts
 * here are deliberately few and slow (a failed video job is expensive to
 * hammer).
 */
import { classifyError, isRetryable, formatError, type ErrorKind } from './errors.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  provider?: string;
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; kind: ErrorKind; message: string }) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 5000;
  const maxDelayMs = opts.maxDelayMs ?? 60000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const kind = classifyError(error, opts.provider);
      if (!isRetryable(kind) || attempt === maxAttempts) throw error;

      const jitter = 0.75 + Math.random() * 0.5;
      const delayMs = Math.round(Math.min(baseDelayMs * 2 ** (attempt - 1) * jitter, maxDelayMs));
      opts.onRetry?.({ attempt, maxAttempts, delayMs, kind, message: formatError(error) });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
