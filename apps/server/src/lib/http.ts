/** Application error with an HTTP status and a stable code for the UI. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterMs: number, service: string) {
    super(429, 'rate_limited', `${service} rate-limited the requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs);
  }
}

/** Reads Retry-After (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, fallbackMs = 5000): number {
  if (!value) return fallbackMs;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BackoffOptions {
  service: string;
  /** Extra attempts after the first one. */
  retries?: number;
  baseDelayMs?: number;
  /** If Retry-After exceeds this, give up and throw RateLimitedError (does not hold the request). */
  maxWaitMs?: number;
  timeoutMs?: number;
}

/**
 * fetch with 429 handling (Retry-After) and exponential backoff for 5xx/network errors.
 * Returns the final Response (including 4xx) — the caller decides what to do.
 */
export async function fetchWithBackoff(url: string | URL, init: RequestInit, opts: BackoffOptions): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const maxWait = opts.maxWaitMs ?? 8000;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (err) {
      if (attempt >= retries) throw new AppError(502, 'upstream_unreachable', `Could not reach ${opts.service}.`);
      await sleep(base * 2 ** attempt);
      attempt++;
      continue;
    }
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const wait = Math.max(retryAfter, base * 2 ** attempt);
      if (attempt >= retries || wait > maxWait) throw new RateLimitedError(wait, opts.service);
      await res.body?.cancel();
      await sleep(wait);
      attempt++;
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      await res.body?.cancel();
      await sleep(base * 2 ** attempt);
      attempt++;
      continue;
    }
    return res;
  }
}
