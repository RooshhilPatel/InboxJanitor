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
 * Gmail rate-limits per-user at 250 quota units/second and answers overruns with 429 or a 403
 * carrying rateLimitExceeded. Both are transient, so they get exponential backoff with jitter;
 * a 403 for any other reason (usually insufficient scope) is a real failure and throws immediately.
 */
async function gmailFetch<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const token = await getAccessToken();
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.ok) return (await response.json()) as T;

    const body: unknown = await response.json().catch(() => ({}));
    const reason =
      (body as { error?: { errors?: Array<{ reason?: string }> } }).error?.errors?.[0]?.reason ?? '';
    const transient =
      RETRYABLE.has(response.status) &&
      (response.status !== 403 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded');

    if (!transient || attempt === maxAttempts) {
      throw new Error(
        `Gmail ${path} failed (${response.status}${reason ? ` ${reason}` : ''}): ${JSON.stringify(body)}`,
      );
    }
    await sleep(2 ** attempt * 250 + Math.random() * 250);
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
      q: query,
      maxResults: '500',
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    yield (page.messages ?? []).map((m) => m.id);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
}

export async function getMessageMetadata(id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(`/messages/${id}`, {
    format: 'metadata',
    metadataHeaders: [...METADATA_HEADERS],
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
