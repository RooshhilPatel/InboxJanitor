import { getAccessToken } from '../auth/oauth.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Headers the scan needs. Bodies are never fetched — classification runs on metadata alone. */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
  'List-Id',
  'Precedence',
] as const;

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gmail enforces two per-user quotas at once: 250 units/second and 15,000 units/minute. Reacting to
 * 403s is not enough — once the minute bucket is spent, every in-flight worker fails for up to a
 * full minute, which is far longer than any sane per-request backoff. So we pace proactively.
 *
 * Sustaining `unitsPerSecond` with a one-second burst ceiling satisfies the per-second limit
 * directly, and 60x it stays under the per-minute limit with headroom. `penalize()` exists because
 * a rate-limit response means *every* worker is over budget, not just the one that got the 403 —
 * the cooldown has to be global or the other workers keep the bucket pinned at empty.
 */
export class QuotaBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private cooldownUntil = 0;

  constructor(private readonly unitsPerSecond: number) {
    this.tokens = unitsPerSecond;
  }

  async take(cost: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.cooldownUntil) {
        await sleep(this.cooldownUntil - now);
        continue;
      }

      this.tokens = Math.min(
        this.unitsPerSecond,
        this.tokens + ((now - this.lastRefill) / 1000) * this.unitsPerSecond,
      );
      this.lastRefill = now;

      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      await sleep(Math.ceil(((cost - this.tokens) / this.unitsPerSecond) * 1000));
    }
  }

  /** Stops every worker for `ms` and empties the bucket, so the quota window can actually drain. */
  penalize(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.tokens = 0;
  }
}

// 200 units/sec sustained = 40 metadata fetches/sec, and 12,000 units/min against a 15,000 ceiling.
const bucket = new QuotaBucket(Number(process.env.SCAN_UNITS_PER_SEC ?? '200'));

/** Quota cost per call. 5 covers messages.list/get and label writes; batchModify costs 50. */
const UNIT_COST = 5;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | string[]>;
  body?: unknown;
  /** Gmail quota units this call consumes. Defaults to 5. */
  cost?: number;
}

/**
 * A 403 carrying rateLimitExceeded and a 429 are both transient. Any other 403 — almost always
 * insufficient scope — is a real failure and throws immediately rather than retrying pointlessly.
 */
export async function gmailFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', params = {}, body, cost = UNIT_COST } = options;
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await bucket.take(cost);
    const token = await getAccessToken();
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // 204 No Content is how label deletion succeeds.
    if (response.status === 204) return undefined as T;
    if (response.ok) return (await response.json()) as T;

    const errorBody: unknown = await response.json().catch(() => ({}));
    const reason =
      (errorBody as { error?: { errors?: Array<{ reason?: string }> } }).error?.errors?.[0]?.reason ?? '';
    const rateLimited =
      response.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
    const transient = rateLimited || (RETRYABLE.has(response.status) && response.status !== 403);

    if (!transient || attempt === maxAttempts) {
      throw new Error(
        `Gmail ${path} failed (${response.status}${reason ? ` ${reason}` : ''}): ${JSON.stringify(errorBody)}`,
      );
    }

    // Backoff has to be able to outlast the minute-long quota window, not just a momentary spike.
    const backoff = Math.min(75_000, 2 ** attempt * 1000) + Math.random() * 1000;
    if (rateLimited) bucket.penalize(backoff);
    else await sleep(backoff);
  }
  throw new Error('unreachable');
}

/** Yields every message id matching a Gmail search query, one page at a time. */
export async function* listMessageIds(query: string): AsyncGenerator<string[]> {
  let pageToken: string | undefined;
  do {
    const page = await gmailFetch<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>('/messages', {
      params: { q: query, maxResults: '500', ...(pageToken !== undefined ? { pageToken } : {}) },
    });
    yield (page.messages ?? []).map((m) => m.id);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
}

export async function getMessageMetadata(id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(`/messages/${id}`, {
    params: { format: 'metadata', metadataHeaders: [...METADATA_HEADERS] },
  });
}

export async function getProfile(): Promise<{ emailAddress: string; messagesTotal: number }> {
  return gmailFetch('/profile');
}

/** Runs `worker` over `items` with bounded concurrency, reporting progress as results land. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
      done += 1;
      onProgress?.(done, items.length);
    }
  });

  await Promise.all(runners);
  return results;
}
