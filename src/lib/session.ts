import { useEffect, useState } from 'react';

const HTTP_PORT = 47823;

// Shared desktop session token. The loopback hub issues a token per
// /api/session call (a NEW streaming_sessions row each time) and the token has
// no expiry — it's valid while its row exists and isn't revoked. So we fetch
// ONCE per app launch and reuse it across every page, instead of re-fetching on
// each page mount (which also spammed the session table on every navigation).
let cachedToken: string | null = null;
let inflight: Promise<string> | null = null;

async function fetchSessionToken(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/session`);
  if (!res.ok) throw new Error(`/api/session → ${res.status}`);
  const body = (await res.json()) as { session_token: string };
  return body.session_token;
}

/** Resolve the shared token, fetching once (concurrent callers share the same
 *  in-flight request). Throws on failure; the failure is NOT cached so the next
 *  call retries (e.g. a page mounted before the server finished starting). */
export function ensureDesktopSession(): Promise<string> {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (!inflight) {
    inflight = fetchSessionToken()
      .then((t) => {
        cachedToken = t;
        inflight = null;
        return t;
      })
      .catch((e) => {
        inflight = null;
        throw e;
      });
  }
  return inflight;
}

/** Drop the cached token so the next ensure re-issues — for a revoked token
 *  (a request came back 401). Tokens don't expire on their own, so this is only
 *  needed if the user revokes this device's session in Settings. */
export function invalidateDesktopSession(): void {
  cachedToken = null;
}

/**
 * Shared session-token hook for desktop pages. Returns the cached token
 * immediately when present (no fetch, no "Connecting…" flash on tab switches),
 * otherwise fetches once. A failed fetch surfaces `error` and isn't cached, so
 * navigating away and back retries — and `retry()` forces a re-issue.
 */
export function useSession(): {
  token: string | null;
  error: string | null;
  retry: () => void;
} {
  const [token, setToken] = useState<string | null>(cachedToken);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (cachedToken) {
      setToken(cachedToken);
      setError(null);
      return;
    }
    let cancelled = false;
    ensureDesktopSession()
      .then((t) => {
        if (!cancelled) {
          setToken(t);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    token,
    error,
    retry: () => {
      invalidateDesktopSession();
      setAttempt((a) => a + 1);
    },
  };
}
