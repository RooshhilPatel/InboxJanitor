/**
 * One-time local OAuth consent. Starts a loopback listener, prints the consent URL, exchanges the
 * returned code (PKCE) for a refresh token, and writes it into .env.
 *
 * Run: npm run auth
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { REQUESTED_SCOPES, assertNoDestructiveScope } from './scopes.ts';
import { requireEnv } from './oauth.ts';

const ENV_PATH = new URL('../../.env', import.meta.url);

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Waits for Google's redirect and returns the authorization code. */
async function awaitCode(expectedState: string): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      const finish = (message: string): void => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
        server.close();
      };

      if (error !== null) {
        finish(`Consent failed: ${error}. You can close this tab.`);
        reject(new Error(`Consent denied: ${error}`));
      } else if (state !== expectedState || code === null) {
        // A mismatched state means the response did not originate from the request we just made.
        finish('State mismatch. You can close this tab.');
        reject(new Error('OAuth state mismatch — aborting.'));
      } else {
        finish('InboxJanitor is authorized. You can close this tab.');
        resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` });
      }
    });

    let port = 0;
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', requireEnv('GMAIL_CLIENT_ID'));
      authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
      authUrl.searchParams.set('state', expectedState);
      authUrl.searchParams.set('code_challenge', pkce.challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      // Required to receive a refresh token rather than an access token alone.
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      console.log('\nOpen this URL and grant access:\n');
      console.log(authUrl.toString());
      console.log('\nWaiting for the redirect...');
    });
  });
}

const verifier = base64url(randomBytes(32));
const pkce = {
  verifier,
  challenge: base64url(createHash('sha256').update(verifier).digest()),
};

/** Writes or replaces a single key in .env, leaving every other line untouched. */
async function persistRefreshToken(token: string): Promise<void> {
  let contents = '';
  try {
    contents = await readFile(ENV_PATH, 'utf8');
  } catch {
    contents = '';
  }

  const line = `GMAIL_REFRESH_TOKEN=${token}`;
  const next = /^GMAIL_REFRESH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, line)
    : `${contents.trimEnd()}\n${line}\n`;

  await writeFile(ENV_PATH, next.startsWith('\n') ? next.trimStart() : next, 'utf8');
}

async function main(): Promise<void> {
  const state = base64url(randomBytes(16));
  const { code, redirectUri } = await awaitCode(state);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GMAIL_CLIENT_ID'),
      client_secret: requireEnv('GMAIL_CLIENT_SECRET'),
      code,
      code_verifier: pkce.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Code exchange failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const token = body as { refresh_token?: string; scope?: string };
  if (token.scope !== undefined) assertNoDestructiveScope(token.scope);
  if (token.refresh_token === undefined) {
    throw new Error(
      'Google returned no refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and re-run so consent is shown again.',
    );
  }

  await persistRefreshToken(token.refresh_token);
  console.log('\nRefresh token written to .env');
  console.log(`Granted scopes: ${token.scope ?? '(not reported)'}`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
