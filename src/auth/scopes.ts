/**
 * Scope policy.
 *
 * Structural invariant: we never request `https://mail.google.com/`. That scope is the only one
 * that unlocks `users.messages.batchDelete` (permanent, unrecoverable deletion). By never holding
 * it, permanent deletion is impossible at the API level rather than merely forbidden by convention.
 * Everything this project does bottoms out in Trash, which Gmail retains for 30 days.
 */

export const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const SCOPE_SETTINGS = 'https://www.googleapis.com/auth/gmail.settings.basic';
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/**
 * Scopes requested. `gmail.modify` covers creating labels, applying them, archiving, and moving to
 * Trash — every mutation this project performs. It is deliberately the widest scope we ever hold.
 */
export const REQUESTED_SCOPES = [SCOPE_READ, SCOPE_SETTINGS, SCOPE_MODIFY] as const;

/** Any scope granting permanent deletion. Holding one of these is a hard failure. */
const FORBIDDEN_SCOPES = ['https://mail.google.com/'];

export function assertNoDestructiveScope(granted: string): void {
  const held = granted.split(/\s+/).filter((s) => FORBIDDEN_SCOPES.includes(s));
  if (held.length > 0) {
    throw new Error(
      `Refusing to run: the token holds ${held.join(', ')}, which permits permanent deletion. ` +
        `Revoke this grant and re-run \`npm run auth\`. See src/auth/scopes.ts.`,
    );
  }
}
