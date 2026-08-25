/**
 * What `ensureSession()` does when the hub will not issue a token.
 *
 * THE INCIDENT (24 Aug 2026). A phone that had simply been signed out of the
 * remote-access provider showed "Couldn't connect — Something went wrong. Please
 * try again." with a Retry button, in Safari and in the home-screen app, and no
 * amount of retrying could ever fix it.
 *
 * The hub answers an unauthenticated caller with a 401 that carries the exact
 * URL to send the visitor to:
 *
 *   401 {"error":"not signed in","signIn":"https://…/portal/start?host=…"}
 *   WWW-Authenticate: Bearer realm="…"
 *
 * `ensureSession()` handled only 402 (pairing required) and turned everything
 * else into `new Error('/api/session failed: 401')`. friendlyError() matched the
 * "(401)"-shaped text and produced the generic "something went wrong", so the one
 * actionable fact in the response — where to go to fix it — was discarded, and
 * the screen offered Retry, which repeats the same unauthenticated request.
 *
 * Retry could not have worked anyway: the service worker is cache-first for
 * navigations, so reloading re-serves the cached shell instead of following the
 * hub's redirect to sign-in. The ONLY escape was typing a different origin's URL
 * by hand.
 *
 * The rule: an answer that says exactly how to fix it must not be flattened into
 * "something went wrong". A signed-out visitor is not an error, it is a state
 * with an action attached — the same distinction sharing.test.ts draws between a
 * refusal that keeps its words and an ordinary "no".
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearStoredToken, ensureSession } from './api';

/** Reply once with whatever the test asked for. */
function stubFetch(reply: { ok?: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async () => {
    const status = reply.status ?? (reply.ok === false ? 500 : 200);
    return {
      ok: reply.ok ?? status < 400,
      status,
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const SIGN_IN = 'https://account.example.com/portal/start?host=music.someone.example.com';

beforeEach(() => {
  localStorage.clear();
  clearStoredToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('THE BUG: a signed-out 401 carries the way back in, and must not be flattened', async () => {
  stubFetch({ status: 401, body: { error: 'not signed in', signIn: SIGN_IN } });
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err?.name).toBe('SignInRequiredError');
  // The URL is the entire point — without it the screen can only say "try again".
  expect((err as Error & { signIn?: string }).signIn).toBe(SIGN_IN);
});

test('pairing still takes precedence — 402 is its own answer, not a sign-in', async () => {
  stubFetch({ status: 402, body: {} });
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err?.name).toBe('PairingRequiredError');
});

test('a 401 with no sign-in URL stays a plain error', async () => {
  // Nothing to act on, so inventing a destination would be worse than the
  // generic message. This is the older hub, or a proxy that ate the body.
  stubFetch({ status: 401, body: { error: 'nope' } });
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err?.name).not.toBe('SignInRequiredError');
  expect(err?.message).toContain('401');
});

test('an unparseable body does not turn a 401 into a crash', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 401,
    json: async () => {
      throw new Error('not json');
    },
  }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err?.message).toContain('401');
});

test('a 500 is still just a failure — the hub is broken, not the visitor', async () => {
  stubFetch({ status: 500, body: {} });
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err?.name).not.toBe('SignInRequiredError');
  expect(err?.message).toContain('500');
});

test('the happy path still stores the token', async () => {
  stubFetch({
    status: 200,
    body: { session_token: 'tok-abc', device_label: 'test', pairing_required: false },
  });
  await expect(ensureSession()).resolves.toBe('tok-abc');
});

test('a signed-out 401 is never mistaken for an offline network failure', async () => {
  // friendlyError() routes TypeError/AbortError to "Can't reach Beetbot on your
  // computer". A 401 is the opposite situation — the hub answered, clearly.
  stubFetch({ status: 401, body: { error: 'not signed in', signIn: SIGN_IN } });
  const err = await ensureSession().then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err?.name).not.toBe('OfflineError');
  expect(err?.name).not.toBe('TypeError');
});
