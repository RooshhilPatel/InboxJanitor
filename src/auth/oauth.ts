import 'dotenv/config';
import { assertNoDestructiveScope } from './scopes.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing ${name}. Copy .env.example to .env and run \`npm run auth\`.`);
  }
  return value.trim();
}

/**
 * Exchanges the stored refresh token for an access token, cached until shortly before expiry.
 * Verifies on every exchange that the grant still carries no permanent-deletion scope — a grant
 * can be widened out of band in the Google console, so this is checked continuously, not once.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GMAIL_CLIENT_ID'),
      client_secret: requireEnv('GMAIL_CLIENT_SECRET'),
      refresh_token: requireEnv('GMAIL_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null ? JSON.stringify(body) : '';
    throw new Error(
      `Token refresh failed (${response.status}). ${detail}\n` +
        `If this says invalid_grant, the OAuth consent screen is probably still in "Testing" — ` +
        `refresh tokens expire after 7 days there. Publish the app, then re-run \`npm run auth\`.`,
    );
  }

  const token = body as { access_token: string; expires_in: number; scope?: string };
  if (token.scope !== undefined) assertNoDestructiveScope(token.scope);

  cached = {
    accessToken: token.access_token,
    // Refresh a minute early so a long-running scan never fails mid-page on an expired token.
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
  };
  return cached.accessToken;
}
