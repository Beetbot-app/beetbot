/**
 * The sharing client.
 *
 * Two things worth pinning, and they pull in opposite directions:
 *
 * 1. **A refusal must keep its words.** The server's message is the useful part —
 *    "that does not look like an email address" says what to do next in a way
 *    "request failed" never will — so it has to survive the trip to the screen.
 *
 * 2. **An ordinary "no" must not be an error.** A guest, or a build with no
 *    provider, gets `canManage: false`. If that threw, every phone belonging to
 *    somebody who was shared this library would light up an error about a feature
 *    they cannot see.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  getSharedPeople,
  getSharingStatus,
  invitePerson,
  revokePerson,
} from './sharing';

const TOKEN = 'tok-123';

/** Record every call, and reply with whatever the test asked for. */
function stubFetch(reply: { ok?: boolean; status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const status = reply.status ?? 200;
    return {
      ok: reply.ok ?? status < 400,
      status,
      json: async () => reply.body ?? {},
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSharingStatus', () => {
  test('passes the session token and returns what the server said', async () => {
    const calls = stubFetch({ body: { canManage: true, providerName: 'Sharemate' } });
    const status = await getSharingStatus(TOKEN);

    expect(status).toEqual({ canManage: true, providerName: 'Sharemate' });
    expect(calls[0].url).toContain('/api/sharing/status');
    expect(calls[0].url).toContain(`t=${TOKEN}`);
  });

  test('a refusal is a quiet no, not an error', async () => {
    // 403 is what a guest gets. Their client must hide the section, not show a
    // failure for something that was never offered to them.
    stubFetch({ status: 403, body: { error: 'not_owner' } });
    await expect(getSharingStatus(TOKEN)).resolves.toEqual({
      canManage: false,
      providerName: '',
    });
  });

  test('so is a build with no provider at all', async () => {
    stubFetch({ status: 503, body: { error: 'sharing is not available' } });
    await expect(getSharingStatus(TOKEN)).resolves.toEqual({
      canManage: false,
      providerName: '',
    });
  });
});

describe('getSharedPeople', () => {
  test('returns the list', async () => {
    stubFetch({
      body: {
        providerName: 'Sharemate',
        people: [
          { email: 'me@example.com', accountId: 'a1', isOwner: true, accepted: true },
          { email: 'sam@example.com', accountId: 'a2', isOwner: false, accepted: false },
        ],
      },
    });
    const listed = await getSharedPeople(TOKEN);
    expect(listed.people).toHaveLength(2);
    expect(listed.people[1].accepted).toBe(false);
  });

  test('a failure throws, because an empty list would be a lie', async () => {
    // "Nobody has access" and "we could not find out" look identical on screen
    // and mean very different things.
    stubFetch({ status: 503, body: { error: 'sharing is not available' } });
    await expect(getSharedPeople(TOKEN)).rejects.toThrow('sharing is not available');
  });
});

describe('invitePerson', () => {
  test('posts the address as JSON', async () => {
    const calls = stubFetch({ status: 201 });
    await invitePerson('sam@example.com', TOKEN);

    expect(calls[0].url).toContain('/api/sharing/invite');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ email: 'sam@example.com' });
  });

  test("the server's own wording reaches the caller", async () => {
    stubFetch({ status: 400, body: { error: 'that does not look like an email address' } });
    await expect(invitePerson('nope', TOKEN)).rejects.toThrow(
      'that does not look like an email address',
    );
  });

  test('a rate limit is not flattened into something generic', async () => {
    stubFetch({ status: 429, body: { error: 'too many requests, try again shortly' } });
    await expect(invitePerson('sam@example.com', TOKEN)).rejects.toThrow(
      'too many requests, try again shortly',
    );
  });

  test('a failure with no message still says something useful', async () => {
    stubFetch({ status: 500, body: {} });
    await expect(invitePerson('sam@example.com', TOKEN)).rejects.toThrow(
      'Could not send that invitation.',
    );
  });
});

describe('revokePerson', () => {
  test('posts the opaque account id, never the address', async () => {
    const calls = stubFetch({ status: 200 });
    await revokePerson('acct-42', TOKEN);

    expect(calls[0].url).toContain('/api/sharing/revoke');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ accountId: 'acct-42' });
  });

  test('a refusal reaches the caller', async () => {
    stubFetch({ status: 400, body: { error: 'no such member' } });
    await expect(revokePerson('acct-42', TOKEN)).rejects.toThrow('no such member');
  });
});
