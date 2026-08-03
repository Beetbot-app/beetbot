import { useEffect, useState } from 'react';
import { setLiveStreamCapable, setTokenReissuer } from '@shared/api';

const HTTP_PORT = 47823;

// Shared desktop session token. The loopback hub issues a token per
// /api/session call (a NEW streaming_sessions row each time) and the token has
// no expiry — it's valid while its row exists and isn't revoked. So we fetch
// ONCE per app launch and reuse it across every page, instead of re-fetching on
// each page mount (which also spammed the session table on every navigation).
//
// A token CAN be revoked mid-launch though: any loopback `/api/session` (a
// second launch, a local probe) prunes stale loopback session rows, and if this
// app was idle past the staleness window its row is among them. So we also
// re-mint on demand when a request comes back 401 (see `reissueDesktopSession`,
// wired into the shared fetch layer via `setTokenReissuer`) instead of dying
// until the user relaunches.
let cachedToken: string | null = null;
let inflight: Promise<string> | null = null;

// Components read the token through `useSession`; when it's re-minted after a
// 401 they must re-render with the new one, so writes to `cachedToken` go
// through here and notify subscribers.
const listeners = new Set<(t: string) => void>();
function publishToken(t: string): void {
  cachedToken = t;
  for (const fn of listeners) fn(t);
}

async function fetchSessionToken(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/session`);
  if (!res.ok) throw new Error(`/api/session → ${res.status}`);
  const body = (await res.json()) as {
    session_token: string;
    live_stream?: boolean;
  };
  // Record the build's live-stream capability. Dropping this (the pre-fix
  // behavior) left canLiveStream() false in the desktop webview forever, so
  // every non-downloaded track was preview-gated — and catalog tracks with no
  // Deezer preview (e.g. kids' content) rendered as dead rows.
  setLiveStreamCapable(body.live_stream ?? false);
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
        publishToken(t);
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
 *  needed if the session row is pruned or the user revokes this device. */
export function invalidateDesktopSession(): void {
  cachedToken = null;
}

/**
 * Re-mint after a request was rejected with 401. Given the token that failed:
 * if another request already re-minted in the meantime (`cachedToken` no longer
 * equals the failed one), hand that back rather than minting again; otherwise
 * drop the dead token and fetch a fresh one. Returns null on failure so the
 * caller can fall through to its normal error path. Registered with the shared
 * fetch layer at module load, so any desktop API call self-heals once.
 */
export async function reissueDesktopSession(
  failedToken: string,
): Promise<string | null> {
  if (cachedToken && cachedToken !== failedToken) return cachedToken;
  invalidateDesktopSession();
  try {
    return await ensureDesktopSession();
  } catch {
    return null;
  }
}

// Desktop-only: teach the shared fetch layer how to re-mint. The phone never
// imports this module, so its 401s still fall through to the re-pair path.
setTokenReissuer(reissueDesktopSession);

/**
 * Shared session-token hook for desktop pages. Returns the cached token
 * immediately when present (no fetch, no "Connecting…" flash on tab switches),
 * otherwise fetches once. A failed fetch surfaces `error` and isn't cached, so
 * navigating away and back retries — and `retry()` forces a re-issue. Also
 * subscribes to token changes so a mid-session re-mint (after a 401) re-renders
 * the page with the fresh token instead of leaving a dead one in the props.
 */
export function useSession(): {
  token: string | null;
  error: string | null;
  retry: () => void;
} {
  const [token, setToken] = useState<string | null>(cachedToken);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Re-render when the token is re-minted out from under us (post-401 recovery).
  useEffect(() => {
    const fn = (t: string) => setToken(t);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

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
