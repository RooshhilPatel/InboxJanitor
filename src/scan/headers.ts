/** Pure RFC 5322 address-header helpers. No I/O, so they are cheap to test in isolation. */

/** Parses `Display Name <user@host>` and bare-address forms. Returns null for unparseable input. */
export function parseAddress(raw: string): { email: string; name: string | null } | null {
  const angled = /<([^>]+)>/.exec(raw);
  const email = (angled?.[1] ?? raw).trim().toLowerCase();
  if (!email.includes('@')) return null;

  const name = angled ? raw.slice(0, angled.index).trim().replace(/^"|"$/g, '') : '';
  return { email, name: name === '' ? null : name };
}

/** Splits a To/Cc header into addresses, tolerating commas inside quoted display names. */
export function parseAddressList(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => parseAddress(part)?.email)
    .filter((email): email is string => email !== undefined && email !== null);
}
