/**
 * Sharing this server with other people.
 *
 * One client for both surfaces. The desktop and the phone ask the same server
 * the same questions, and the server decides who is allowed to ask — so there is
 * no reason for two implementations, and a good reason not to have them: a rule
 * enforced in two places is a rule that eventually differs.
 *
 * Everything here is generic on purpose. No provider is named; the display name
 * arrives in the status response and the copy is written around it. In a build
 * with no provider `canManage` is false and both interfaces render nothing.
 */

import { apiUrl } from './api';

/** Somebody who can open this server. */
export interface SharedPerson {
  email: string;
  /** Opaque id used to remove them. Meaningful only to the provider. */
  accountId: string;
  /** True for whoever owns the server. They cannot be removed. */
  isOwner: boolean;
  /** True once they have accepted; false while the invitation is outstanding. */
  accepted: boolean;
}

export interface SharingStatus {
  /** Whether to show the sharing interface to this caller at all. */
  canManage: boolean;
  /** What to call the service in the copy. Empty when there is nothing to show. */
  providerName: string;
}

export interface SharedPeople {
  providerName: string;
  people: SharedPerson[];
}

/**
 * The server's own message when it refuses, because that message is the useful
 * part — "that does not look like an email address" tells somebody what to do
 * next in a way that "request failed" never will.
 */
async function refusal(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const message =
    body && typeof body.error === 'string' && body.error ? body.error : fallback;
  return new Error(message);
}

const authed = (path: string, token: string) =>
  apiUrl(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`);

/**
 * Whether this caller may manage sharing, and what the service is called.
 *
 * Never throws for an ordinary "no": a guest, or a build with no provider, gets
 * `canManage: false` so the interface simply is not there. Only a genuinely
 * broken request rejects.
 */
export async function getSharingStatus(token: string): Promise<SharingStatus> {
  const res = await fetch(authed('/api/sharing/status', token));
  if (!res.ok) return { canManage: false, providerName: '' };
  return (await res.json()) as SharingStatus;
}

/** Everyone who can open this server. */
export async function getSharedPeople(token: string): Promise<SharedPeople> {
  const res = await fetch(authed('/api/sharing/people', token));
  if (!res.ok) throw await refusal(res, 'Could not read who has access.');
  return (await res.json()) as SharedPeople;
}

/** Share this server with somebody by email. */
export async function invitePerson(email: string, token: string): Promise<void> {
  const res = await fetch(authed('/api/sharing/invite', token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw await refusal(res, 'Could not send that invitation.');
}

/** Take somebody's access away. Always confirm with the owner before calling. */
export async function revokePerson(accountId: string, token: string): Promise<void> {
  const res = await fetch(authed('/api/sharing/revoke', token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) throw await refusal(res, 'Could not remove that person.');
}
