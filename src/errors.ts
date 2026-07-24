/**
 * Error taxonomy for the gateway. Classification logic ported from the
 * production-tested cloops-ads adapters/utils/errors.ts, including provider
 * error codes learned from real failures.
 *
 * Kinds:
 *   auth            missing/invalid API key. Never retried.
 *   validation      the provider rejected the input against the model's schema.
 *                   Never retried; surfaced with field detail when available.
 *   content_policy  prompt/input flagged by a safety system. Never retried;
 *                   the fix is rewriting the prompt.
 *   rate_limit      429 and friends. Retried with backoff.
 *   transient       provider-side hiccups (5xx, capacity, network). Retried.
 *   timeout         our own per-job ceiling expired. Not retried (the job was
 *                   already cancelled best-effort).
 *   permanent       everything else. Not retried.
 */

export type ErrorKind =
  | 'auth'
  | 'validation'
  | 'content_policy'
  | 'rate_limit'
  | 'transient'
  | 'timeout'
  | 'permanent';

export class GatewayError extends Error {
  kind: ErrorKind;
  provider?: string;
  status?: number;
  requestId?: string;
  /** Field-level validation details when the provider supplies them. */
  fieldErrors?: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    opts: {
      kind: ErrorKind;
      provider?: string;
      status?: number;
      requestId?: string;
      fieldErrors?: Array<{ field: string; message: string }>;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'GatewayError';
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.fieldErrors = opts.fieldErrors;
  }
}

function extractStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as Record<string, unknown>;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response === 'object') {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === 'number') return response.status;
    if (typeof response.statusCode === 'number') return response.statusCode;
  }
  if (typeof err.message === 'string') {
    const match = err.message.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

const CONTENT_POLICY_MARKERS = [
  'e005', // Replicate: flagged as sensitive
  'flagged as sensitive',
  'safety system',
  'blocked by safety',
  'nsfw',
  'content filter',
  'content moderation',
  'safety filter',
  'policy violation',
  'content_policy',
  'inappropriate',
];

// Replicate transient codes observed in production. E1001 (OOM) and E4875
// (config) are deliberately absent: they are permanent.
const TRANSIENT_MARKERS = [
  '(code: pa)', // worker interrupted, Replicate says retry
  'prediction interrupted',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'network error',
  'fetch failed',
  'e9243', // error starting prediction (capacity)
  'e1000', // uncategorized transient
  'e6716', // timeout starting prediction
  'e8367', // prediction stopped non-terminal
  'e8765', // model health check failed
  'e9825', // file upload failed
  'e003', // service unavailable (high demand)
];

export function classifyError(error: unknown, provider?: string): ErrorKind {
  if (error instanceof GatewayError) return error.kind;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = extractStatusCode(error);

  // Content policy first: these often arrive as 400/422 and must not be
  // mistaken for schema validation.
  if (CONTENT_POLICY_MARKERS.some((m) => message.includes(m))) return 'content_policy';
  if (message.includes('violates') && message.includes('policy')) return 'content_policy';

  if (status === 401 || status === 403) return 'auth';
  if (message.includes('api key') || message.includes('api token')) return 'auth';

  if (status === 429) return 'rate_limit';
  if (message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
  if (message.includes('quota exceeded')) return 'rate_limit';

  if (status === 500 || status === 502 || status === 503 || status === 504) return 'transient';
  if (TRANSIENT_MARKERS.some((m) => message.includes(m))) return 'transient';
  if (message.includes('timeout') && !message.includes('nsfw')) return 'transient';

  // 422 on fal: documented as validation, but production history shows 422s
  // under burst load that clear on retry. The retry layer gives them a
  // limited number of attempts; if they persist they surface as validation.
  if (provider === 'fal' && status === 422) return 'transient';
  if (status === 422 || status === 400) return 'validation';

  return 'permanent';
}

export function isRetryable(kind: ErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'transient';
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
