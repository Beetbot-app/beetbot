/**
 * Minimal REST client for the web player. Talks to the same origin's axum
 * server (so no CORS preflights from the browser). All authenticated calls
 * pass the session token as `?t=<token>` -- that's what `<audio src>` needs
 * anyway, and using the same param everywhere keeps things uniform.
 */

const TOKEN_STORAGE_KEY = 'beetbot.session_token';

/**
 * Base URL for /api/* + /stream/* requests.
 *
 * Phone bundle keeps the default empty string so fetches stay
 * relative — the SPA is served by the same axum process at the same
 * origin, so `/api/search` resolves correctly against the page URL.
 *
 * Desktop bundle calls `setApiBase('http://127.0.0.1:47823')` once
 * at startup. The Tauri webview's origin is `tauri://localhost`,
 * which would otherwise resolve `/api/search` to that custom scheme
 * and WebKit rejects the fetch with "The string did not match the
 * expected pattern."
 */
let API_BASE = '';

export function setApiBase(base: string): void {
  // Strip trailing slash so concatenation stays predictable.
  API_BASE = base.endsWith('/') ? base.slice(0, -1) : base;
}

/** Prefix a path with the configured base. Returns the input unchanged when no base is set. */
export function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

/**
 * Resolve a cover URL for an `<img src>` / hero wash. Server-scrubbed Deezer
 * playlist covers (the "DEEZER" wordmark painted out) come back as a relative
 * `/api/cover-scrub/...` path. On the phone that resolves same-origin, but the
 * desktop's `tauri://localhost` origin would reject a bare `/api/...` — so
 * relative cover paths get the same base prefix as every other API call.
 * Absolute CDN URLs (album/artist art) pass through untouched.
 */
export function coverSrc(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') ? apiUrl(url) : url;
}

/**
 * Active profile, set by the host (desktop/phone) whenever the selected profile
 * changes. Catalog GETs append `&profile_id=...` so the hub scopes the ✓
 * ("in your library") marks to playlists THIS profile owns — without it the hub
 * falls back to the default profile and shows another account's playlist
 * membership. Module-level (like API_BASE) so it doesn't have to thread through
 * every catalog call site / sub-component.
 */
let ACTIVE_PROFILE_ID: number | null = null;
export function setActiveProfileId(id: number | null | undefined): void {
  const next = id ?? null;
  const changed = next !== ACTIVE_PROFILE_ID;
  ACTIVE_PROFILE_ID = next;
  // Pull this profile's shared "recently played playlists" from the hub so the
  // Library / Home order reflects what was played on the user's other device.
  // Fire-and-forget; guarded on a real change so re-renders don't spam the hub.
  if (changed && next != null) void syncRecentlyPlayedPlaylists();
}
/** Suffix a localStorage base key with a profile, so per-user UI state (search
 *  recents, recently-played order, offline flags, pinned playlists, the
 *  Discover cache's per-profile ✓ marks) stays isolated between profiles that
 *  share one device. Defaults to the active profile; pass an explicit id from a
 *  component that already holds the prop. */
export function profileScopedKey(
  base: string,
  profileId: number | null = ACTIVE_PROFILE_ID,
): string {
  return `${base}.p${profileId ?? 'none'}`;
}
/** `&profile_id=N` for appending to a hub URL that already has a query string. */
function profileParam(): string {
  return ACTIVE_PROFILE_ID != null ? `&profile_id=${ACTIVE_PROFILE_ID}` : '';
}

export interface PlaylistRow {
  id: number;
  name: string;
  track_count: number;
  cover_url: string | null;
  source: 'csv' | 'spotify' | 'liked' | 'local' | 'album' | 'soundcloud' | 'apple';
  /**
   * For album imports, the album artist (rendered "Album · Artist"); for
   * upstream playlists, the owner. Optional so older cached responses parse.
   */
  owner?: string | null;
  /**
   * Up to 4 track ids with distinct album art (playlist order), for the
   * 2×2 mosaic tile in the phone library. Their art loads via
   * `trackArtUrl`. Fewer than 4 ⇒ fall back to the single `cover_url`.
   * Optional so older cached `/api/playlists` responses still parse.
   */
  cover_track_ids?: number[];
}

export interface StreamTrack {
  id: number;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
  position: number;
  has_audio: boolean;
  status: string;
}

export interface PlaylistDetail {
  id: number;
  name: string;
  /** User-editable blurb (local playlists); null for most. */
  description?: string | null;
  cover_url: string | null;
  /** Where the playlist came from (local/spotify/liked/album/csv/...). Imported
   *  playlists carry a synthetic import id, so re-importing the same archive
   *  updates them in place instead of duplicating. */
  source: string;
  tracks: StreamTrack[];
}

export interface SessionResponse {
  session_token: string;
  device_label: string;
  pairing_required: boolean;
  /** Full build can stream a not-yet-downloaded track on demand (`/stream/{id}/live`). */
  live_stream?: boolean;
}

/** Read the persisted token, if any. */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, t);
  } catch {
    // Private-mode iOS Safari throws here. We fall through and re-issue a
    // token every load; functional but not ideal.
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

// --- Session-expired handling -----------------------------------------
// When an authenticated request comes back 401, the stored token has been
// revoked or expired server-side. Rather than sit in a broken "logged in"
// state (empty screens, "audio format not supported"), we drop the dead token
// and let the app bounce back to the pairing screen. The app registers a
// handler via `setSessionExpiredHandler`; `notifyUnauthorized` is called from
// the fetch helpers + the audio error path when a 401 is seen.
let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn;
}

/** Clear the dead token and notify the app to re-pair. Idempotent. */
export function notifyUnauthorized(): void {
  clearStoredToken();
  sessionExpiredHandler?.();
}

// A background re-mint (see `reissuePhoneSession`) swaps in a fresh token with
// no user action. The app registers a handler so it can update the token it
// holds in memory -- otherwise it keeps handing the stale one to every request,
// each of which then 401s and re-mints again (still correct, just wasteful).
let sessionRefreshedHandler: ((token: string) => void) | null = null;

export function setSessionRefreshedHandler(
  fn: ((token: string) => void) | null,
): void {
  sessionRefreshedHandler = fn;
}

// How the host mints a fresh token when the current one is rejected mid-session.
// The desktop registers this — it issues tokens on demand from /api/session, so
// a revoked token (e.g. its session pruned as a stale loopback row) can be
// re-minted silently instead of leaving the app dead until relaunch. The phone
// leaves it unset: its token comes from pairing, so a 401 falls through to the
// re-pair path. The reissuer is handed the token that just failed so it can
// no-op when another in-flight request already re-minted.
let tokenReissuer: ((failedToken: string) => Promise<string | null>) | null =
  null;

export function setTokenReissuer(
  fn: ((failedToken: string) => Promise<string | null>) | null,
): void {
  tokenReissuer = fn;
}

/**
 * Turn a thrown fetch/API error into a short, human message safe to show the
 * user — never a raw exception or status string. Network / timeout / host-
 * unreachable failures and our own `"X failed (500)"` / `"path → 500"` throws
 * map to connection copy in the connection banner's language; our intentional,
 * human-written throws (pairing hints, validation) pass through unchanged;
 * anything else falls back to a generic line. Used by every catch that used to
 * render `e.message` / `String(e)` verbatim.
 *
 * Note: this is for network/API errors. Non-network failures with their own
 * meaning (e.g. an audio autoplay/codec DOMException) should be described by
 * the caller, not routed through here — several of those messages contain the
 * word "failed" and would be mis-mapped to the connection line.
 */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const name = e instanceof Error ? e.name : '';
  // Genuinely can't reach the host: a fetch network failure, our abort timeout,
  // a navigator-offline throw, or the Deezer-direct jsonp fallback timing out.
  if (
    name === 'TypeError' || // fetch() network failure
    name === 'AbortError' || // our timed-out request
    /failed to fetch|load failed|network\s?error|timed?\s?out|timeout|aborted|\boffline\b|jsonp/i.test(
      msg,
    )
  ) {
    return "Can't reach Beetbot on your computer. Try again when you're back online.";
  }
  // The host answered but errored — our "X failed (500)" / "path → 500" throws.
  // It's reachable, the action just didn't work; don't leak the raw status/body.
  if (/\bfailed\b|\(\d{3}\)|→\s*\d{3}|:\s*\d{3}\b/i.test(msg)) {
    return 'Something went wrong. Please try again.';
  }
  // An intentional, human-written message (short, single line) — show as-is.
  if (msg && msg.length <= 140 && !msg.includes('\n')) return msg;
  return 'Something went wrong. Please try again.';
}

/** How long a write mutation may run before we abort it. Longer than the read
 *  HUB_TIMEOUT (a large album import is a legit slow save) but finite, so a
 *  dead host fails fast into a clean {@link friendlyError} instead of hanging on
 *  the browser default (30-60s on iOS Safari) with a spinner. */
const WRITE_TIMEOUT_MS = 10000;

/** fetch() with an abort timeout — for write mutations that would otherwise
 *  hang indefinitely against an unreachable host. Declared as a function so the
 *  mutations defined above can call it (hoisted). */
async function timedFetch(
  input: string,
  init?: RequestInit,
  ms = WRITE_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const LIVE_STREAM_KEY = 'beetbot.live_stream';
// Persisted alongside the token so a reload knows the build's capability before
// the session round-trips (avoids a brief window where a non-downloaded track
// would fall back to preview on the first play after reload).
let liveStreamCapable = ((): boolean => {
  try {
    return localStorage.getItem(LIVE_STREAM_KEY) === '1';
  } catch {
    return false;
  }
})();

/** Record whether this build can live-stream (from a session response's
 *  `live_stream`). Exported for the desktop's own session layer (src/lib/
 *  session.ts), which mints tokens outside ensureSession/submitPairing. */
export function setLiveStreamCapable(v: boolean): void {
  liveStreamCapable = v;
  try {
    localStorage.setItem(LIVE_STREAM_KEY, v ? '1' : '0');
  } catch {
    /* private-mode storage may throw; the in-memory flag still holds this session */
  }
}

/** Whether this build can stream a not-yet-downloaded track on demand (full build only). */
export function canLiveStream(): boolean {
  return liveStreamCapable;
}

/**
 * Submit a 6-digit pairing code. Returns the new session token on
 * success. On wrong code the server responds 401; on rate limit, 429
 * with a `retry_after_seconds` body. Errors carry the status code so
 * the caller can render a sensible message.
 */
export async function submitPairing(
  code: string,
  deviceLabel: string | null,
): Promise<string> {
  const res = await fetch(apiUrl('/api/pair'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: code.trim(),
      device_label: deviceLabel,
    }),
  });
  if (res.status === 429) {
    let retry = 60;
    try {
      const body = (await res.json()) as { retry_after_seconds?: number };
      retry = body.retry_after_seconds ?? retry;
    } catch {
      /* fall through */
    }
    const err = new Error(
      `Too many attempts — wait ${retry}s before trying again.`,
    );
    err.name = 'RateLimitedError';
    throw err;
  }
  if (res.status === 401) {
    const err = new Error('That code didn’t match. Check the desktop screen.');
    err.name = 'PairingFailedError';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`/api/pair → ${res.status}`);
  }
  const body = (await res.json()) as SessionResponse;
  setStoredToken(body.session_token);
  setLiveStreamCapable(body.live_stream ?? false);
  return body.session_token;
}

/**
 * Ensure we have a working session token. If the stored one 401s, drop it
 * and request a fresh one from the server. Returns the live token or throws
 * if pairing is required (caller handles that case).
 */
export async function ensureSession(): Promise<string> {
  const existing = getStoredToken();
  if (existing) {
    // Fast offline path: if the browser knows the network is down,
    // skip the probe entirely. The probe is a network fetch that can
    // hang for 30-60s on iOS Safari when DNS still resolves but the
    // home server is offline (desktop powered off, dropped from the
    // LAN, etc). During that hang the App renders a near-black
    // "Connecting…" placeholder and the user thinks the PWA is dead.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return existing;
    }
    // Online (or unknown): cheap auth probe with a tight abort so we
    // don't get stuck on a slow-failing connection. The SW serves
    // /api/playlists from API_CACHE while online and offline-recently,
    // so the probe is normally instant — anything that takes >3s
    // means the network is sick and we should trust the stored token.
    const ctrl =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      ctrl && typeof setTimeout !== 'undefined'
        ? setTimeout(() => ctrl.abort(), 3000)
        : null;
    try {
      const probe = await fetch(
        apiUrl(`/api/playlists?t=${encodeURIComponent(existing)}`),
        ctrl ? { method: 'GET', signal: ctrl.signal } : { method: 'GET' },
      );
      if (probe.ok) return existing;
      // Otherwise the token expired / was revoked -- fall through and re-issue.
    } catch {
      // Network error / aborted timeout / offline. We have a stored
      // token; trust it and let the rest of the app boot. The SW serves
      // cached /api/playlists for the library so it's still browsable
      // offline.
      return existing;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  let res: Response;
  try {
    res = await fetch(apiUrl('/api/session'));
  } catch {
    // No stored token AND no network — first-time setup needs the
    // server to issue a token, and we can't satisfy that offline.
    const err = new Error('offline-no-token');
    err.name = 'OfflineError';
    throw err;
  }
  if (res.status === 402) {
    // Pairing required (see plan §7.2). Not implemented in step 16; the UI
    // surfaces this as a fatal error so the user can flip the toggle off.
    const err = new Error('pairing-required');
    err.name = 'PairingRequiredError';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`/api/session failed: ${res.status}`);
  }
  const body = (await res.json()) as SessionResponse;
  setStoredToken(body.session_token);
  setLiveStreamCapable(body.live_stream ?? false);
  return body.session_token;
}

/**
 * Re-mint a session token after a mid-session 401, for a client whose token is
 * issued by `/api/session` (the phone / web-player PWA). Mirrors the desktop's
 * `reissueDesktopSession`: if another in-flight request already re-minted, hand
 * that back; otherwise fetch a fresh one. Returns null when the server won't
 * issue a token without pairing (a genuine remote visitor -- the caller then
 * falls through to the pairing screen) or when offline.
 *
 * Why the phone needs a reissuer at all: through a trusted local proxy (a
 * provider-served phone) the visitor reaches the hub over loopback and is exempt
 * from pairing, so `/api/session` mints a token WITHOUT a code. But that token
 * is a loopback session row, which the desktop prunes as stale -- so a proxied
 * phone's token gets revoked mid-session. Without this, the next request 401'd
 * straight to the 6-digit pairing screen even though pairing was never required;
 * with it, the phone silently re-mints and the code never flashes.
 */
export async function reissuePhoneSession(
  failedToken: string,
): Promise<string | null> {
  const current = getStoredToken();
  if (current && current !== failedToken) return current;
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/session'));
  } catch {
    return null; // offline -- nothing to re-mint with
  }
  // 402/403 (pairing genuinely required) or any error -> fall through to the
  // caller's re-pair path. Only a real token counts as a silent recovery.
  if (!res.ok) return null;
  const body = (await res.json()) as SessionResponse;
  setStoredToken(body.session_token);
  setLiveStreamCapable(body.live_stream ?? false);
  sessionRefreshedHandler?.(body.session_token);
  return body.session_token;
}

/**
 * Background prefetch: warm the service-worker API cache for a set of
 * playlists. Used by the Library screen so that any playlist the user
 * can see is also browseable offline (the SW caches each /api/playlists/:id
 * response on first network fetch — without prefetching, the user would
 * have to manually visit each playlist online before going offline).
 *
 * Fire-and-forget: errors are swallowed (offline / 4xx / etc — the SW
 * still has whatever it had before). No-await callers are expected.
 */
export function prefetchPlaylistDetails(
  ids: number[],
  token: string,
): Promise<void> {
  return Promise.allSettled(
    ids.map((id) =>
      fetch(
        apiUrl(`/api/playlists/${id}?t=${encodeURIComponent(token)}`),
        { cache: 'no-store' },
      ).catch(() => {}),
    ),
  ).then(() => undefined);
}

async function jsonGet<T>(path: string, token: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  let res = await fetch(apiUrl(`${path}${sep}t=${encodeURIComponent(token)}`));
  if (res.status === 401 && tokenReissuer) {
    // The token was revoked out from under us. On the desktop that happens when
    // its session is pruned as a stale loopback row while it sat idle; it can
    // mint a new one on demand, so re-mint once and retry before giving up —
    // silent recovery instead of a dead app until relaunch.
    const fresh = await tokenReissuer(token).catch(() => null);
    if (fresh && fresh !== token) {
      res = await fetch(apiUrl(`${path}${sep}t=${encodeURIComponent(fresh)}`));
    }
  }
  if (res.status === 401) {
    // Still unauthorized (no reissuer, or the retry also failed) — drop the
    // token and re-pair instead of showing a broken "logged in" empty screen.
    notifyUnauthorized();
    const err = new Error('session expired');
    err.name = 'SessionExpiredError';
    throw err;
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function listPlaylists(
  token: string,
  profileId?: number | null,
): Promise<PlaylistRow[]> {
  const path =
    profileId != null ? `/api/playlists?profile_id=${profileId}` : '/api/playlists';
  return jsonGet<PlaylistRow[]>(path, token);
}

/** Every track in the profile's library as a flat, title-sorted list — powers
 *  the phone's Library › Songs tab. Same set the desktop reads over IPC. */
export function listLibrarySongs(
  token: string,
  profileId?: number | null,
): Promise<StreamTrack[]> {
  const path =
    profileId != null
      ? `/api/library/songs?profile_id=${profileId}`
      : '/api/library/songs';
  return jsonGet<StreamTrack[]>(path, token);
}

/** A Netflix-style user profile. Owns playlists; the music library is shared. */
export interface Profile {
  id: number;
  name: string;
  avatar_color: string;
  /** Non-null when the profile has a custom photo (set on desktop). The phone
   *  loads the actual image from `profileAvatarUrl`, not this path. */
  avatar_path: string | null;
  has_pin: boolean;
  created_at: number;
}

/** List profiles for the phone's "who's using Beetbot?" picker. */
export function getProfiles(token: string): Promise<Profile[]> {
  return jsonGet<Profile[]>('/api/profiles', token);
}

/** URL for a profile's custom photo (only meaningful when avatar_path is set). */
export function profileAvatarUrl(profileId: number, token: string): string {
  return apiUrl(`/api/profiles/${profileId}/avatar?t=${encodeURIComponent(token)}`);
}

/** Delete a profile. A paired device may only delete the profile its session
 *  is bound to (bindSessionProfile); the server refuses to delete the last
 *  remaining profile. Throws with the server's message on refusal. */
export async function deleteProfile(profileId: number, token: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/profiles/${profileId}?t=${encodeURIComponent(token)}`),
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `delete profile → ${res.status}`);
  }
}

/** Rename a profile. The colour is the hub's to keep — it is not sent. */
export async function renameProfile(
  profileId: number,
  name: string,
  token: string,
): Promise<Profile> {
  const res = await fetch(
    apiUrl(`/api/profiles/${profileId}?t=${encodeURIComponent(token)}`),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `rename profile → ${res.status}`);
  }
  return (await res.json()) as Profile;
}

/** Replace a profile's photo. Sends the file's bytes as-is; the hub decides the
 *  format from them and keeps the file. */
export async function setProfileAvatar(
  profileId: number,
  file: Blob,
  token: string,
): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/profiles/${profileId}/avatar?t=${encodeURIComponent(token)}`),
    { method: 'POST', body: file },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `set avatar → ${res.status}`);
  }
}

/** Drop a profile's photo, back to the coloured initial. */
export async function clearProfileAvatar(
  profileId: number,
  token: string,
): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/profiles/${profileId}/avatar?t=${encodeURIComponent(token)}`),
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `clear avatar → ${res.status}`);
  }
}

/** Verify a profile's PIN. Returns true for a correct PIN or no PIN set. */
export async function verifyProfilePin(
  profileId: number,
  pin: string,
  token: string,
): Promise<boolean> {
  const res = await fetch(
    apiUrl(`/api/profiles/${profileId}/verify?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    },
  );
  if (!res.ok) throw new Error(`verify pin → ${res.status}`);
  const out = (await res.json()) as { ok: boolean };
  return out.ok;
}

/** Bind this device's session to a profile on the SERVER (it re-verifies the
 *  PIN), so the server is authoritative about which profile this device acts as
 *  and can enforce playlist ownership instead of trusting a client-supplied id.
 *  Best-effort: returns false on any failure; callers proceed with the local
 *  selection regardless. */
export async function bindSessionProfile(
  token: string,
  profileId: number,
  pin = '',
): Promise<boolean> {
  try {
    const res = await fetch(
      apiUrl(`/api/session/profile?t=${encodeURIComponent(token)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, pin }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function getPlaylist(id: number, token: string): Promise<PlaylistDetail> {
  return jsonGet<PlaylistDetail>(`/api/playlists/${id}`, token);
}

/**
 * Delete a playlist by id. The host removes the playlist row and the
 * FK cascade clears the `playlist_tracks` join. Tracks themselves are
 * preserved (they might be in other playlists; their audio files stay
 * on disk regardless).
 *
 * Caveat: an imported playlist is keyed by a synthetic import id, so
 * re-importing the same archive re-creates it. Local-only ones (synthetic
 * `local:` ids) can't be re-imported and stay gone.
 */
export async function deletePlaylist(id: number, token: string): Promise<void> {
  const res = await timedFetch(
    apiUrl(`/api/playlists/${id}?t=${encodeURIComponent(token)}`),
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `delete playlist failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
}

/** Rename a playlist (display name only). The host updates the `name` column;
 *  re-importing an imported playlist would restore its original name. */
export async function renamePlaylist(
  id: number,
  name: string,
  token: string,
  /** Omit for a name-only edit; pass a string (blank clears) to also set the
   *  description. */
  description?: string,
): Promise<void> {
  const body: { name: string; description?: string } =
    description === undefined ? { name } : { name, description };
  const res = await timedFetch(
    apiUrl(`/api/playlists/${id}?t=${encodeURIComponent(token)}`),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `rename playlist failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
}

export function streamUrl(trackId: number, token: string): string {
  return `/stream/${trackId}?t=${encodeURIComponent(token)}`;
}

/** Instant-stream URL for a not-yet-downloaded track (full build resolves +
 *  remuxes the source on demand). Falls through to 404 on the open build. */
export function liveStreamUrl(trackId: number, token: string): string {
  return `/stream/${trackId}/live?t=${encodeURIComponent(token)}`;
}

/** The playable audio URL for a track, or null if it can't be played in full:
 *  the local stream when downloaded, else the instant live stream when the build
 *  supports it (the engine resolves — matching on the fly if needed — and
 *  remuxes the source). Null only on the open build for a non-downloaded track. */
export function playbackUrl(
  track: { id: number; has_audio?: boolean | null },
  token: string,
): string | null {
  if (track.has_audio) return streamUrl(track.id, token);
  if (canLiveStream()) return liveStreamUrl(track.id, token);
  return null;
}

/** Whether a track can be played in full — a *capability* check (local file, or
 *  the full build can live-stream any track). Static: it does NOT consider
 *  whether the hub is reachable right now. Used for queue filtering (canStream)
 *  where a transient hub blip must NOT drop a queued track. For gating a Play
 *  *control* in the UI, use {@link canPlayNow} instead. */
export function isPlayable(track: { has_audio?: boolean | null }): boolean {
  return !!track.has_audio || canLiveStream();
}

/** Whether a track can START playing *right now* — the UI-gating check. A
 *  downloaded track always can (local file); a non-downloaded track needs the
 *  live-stream build AND a currently-reachable hub, since it streams via
 *  /stream/{id}/live. Because this reads the live reachability flag, any control
 *  gated on it must re-render when reachability changes — subscribe with
 *  {@link useHubReachable} (shared/useHubReachable). */
export function canPlayNow(track: { has_audio?: boolean | null }): boolean {
  return !!track.has_audio || (canLiveStream() && isHubReachable());
}

export function trackArtUrl(trackId: number, token: string): string {
  return `/api/tracks/${trackId}/art?t=${encodeURIComponent(token)}`;
}

/**
 * Same-origin URL for a playlists cover. The endpoint resolves to
 * either the playlists own cover_url (if Spotify set one) or the
 * first track's album art, then proxies the JPEG bytes back. Used
 * everywhere the UI renders a playlist tile so the SW can cache it
 * for offline display (Spotify CDN URLs are cross-origin and can't
 * be cached cleanly without `mode: no-cors` opaque hacks).
 */
export function playlistArtUrl(playlistId: number, token: string): string {
  // Go through apiUrl() so the desktop (whose webview origin is
  // tauri://localhost, not the server) gets an absolute URL. On the phone
  // API_BASE is empty, so this stays a relative path — no change there.
  return apiUrl(
    `/api/playlists/${playlistId}/art?t=${encodeURIComponent(token)}`,
  );
}

// --- Catalog search + add-to-playlist ----------------------------------
//
// The host's /api/search proxies to Deezer's free public API. We chose
// Deezer over Spotify because Spotify's Feb 2026 dev-mode tightening
// capped /v1/search at 10 results per request and gated bigger quotas
// behind enterprise criteria. Deezer requires no auth, returns ISRC
// directly, and has comparable mainstream catalog coverage.
//
// The on-wire track shape is "source-tagged" so the host can mint a
// stable synthetic tracks.spotify_id (e.g. `deezer:12345`) and so the
// add-to-playlist call can ship the full payload back to the host
// without a second round-trip to the catalog API.

export interface SearchTrackResult {
  source: string;
  source_id: string;
  title: string;
  artists: string[];
  album: string | null;
  /** Catalog id of `album`. Match a track back to an album on THIS, not on the
   *  name: "After Hours" and "After Hours (Deluxe)" are two strings for one
   *  record. Optional — a hub older than this field, or a row the client
   *  posted back, won't carry it, so callers still need a name fallback. */
  album_id?: string | null;
  album_art_url: string | null;
  duration_ms: number;
  isrc: string | null;
  /**
   * Library state, populated by the server. Drives whether the search
   * UI shows a ✓ (already in library) or + (add to library) button on
   * each track row.
   */
  local_track_id: number | null;
  /**
   * Playlists this track is currently in. Empty when local_track_id is null.
   * Deliberately EXCLUDES saved-album playlists — see `in_saved_album_ids`.
   */
  in_playlist_ids: number[];
  /**
   * Saved-album playlists (source 'album') this track belongs to, for the
   * active profile. Kept separate from `in_playlist_ids` so the album page can
   * show a truthful "this whole album is saved" ✓ — one that `local_track_id`
   * can't give, since merely playing a track sets that. Optional so a row
   * posted back by an older client still deserializes.
   */
  in_saved_album_ids?: number[];
  /**
   * True iff `local_track_id` is set AND the local track has a
   * downloaded audio file on disk. Tap-to-play on search results
   * only fires when this is true.
   */
  has_audio: boolean;
  /**
   * Deezer's public 30-second preview clip (MP3 URL), when available.
   * Drives the inline ▶/⏸ audition button on each search/album row.
   * Null when Deezer has no preview for the track.
   */
  preview_url: string | null;
  /** Deezer's explicit-lyrics flag — drives the small "E" badge. */
  explicit: boolean;
}

export interface PatchTrackPlaylistsResult {
  track_id: number;
  in_playlist_ids: number[];
}

/**
 * Commit a multi-playlist edit for a catalog track. The host upserts
 * the track row (ISRC dedup against existing rows), links it to the
 * playlists in `add`, and unlinks it from `remove`.
 *
 * Idempotent: replays with the same diff are no-ops. Repeat-call this
 * after the user adjusts checkmarks if you ever need to.
 */
export async function patchTrackPlaylists(
  track: SearchTrackResult,
  add: number[],
  remove: number[],
  token: string,
): Promise<PatchTrackPlaylistsResult> {
  const res = await timedFetch(
    apiUrl(`/api/tracks/playlists?t=${encodeURIComponent(token)}`),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track, add, remove }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `update playlists failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  clearSearchCache();
  return (await res.json()) as PatchTrackPlaylistsResult;
}

/**
 * The set of track ids in the profile's "Favorites" playlist — drives the
 * filled-heart state. Returns an empty set on any error.
 */
export async function getLikedTrackIds(
  token: string,
  profileId?: number | null,
): Promise<Set<number>> {
  const url = apiUrl(
    `/api/tracks/liked?t=${encodeURIComponent(token)}${
      profileId != null ? `&profile_id=${profileId}` : ''
    }`,
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return new Set();
    const j = (await res.json()) as { ids?: number[] };
    return new Set<number>(Array.isArray(j.ids) ? j.ids : []);
  } catch {
    return new Set();
  }
}

/**
 * The playlist ids a LOCAL track currently belongs to (incl. Liked Songs), so the
 * "Add to playlist" picker opened from Now Playing can pre-check the right rows.
 * Returns [] on any error.
 */
export async function getTrackPlaylistIds(
  trackId: number,
  token: string,
  profileId?: number | null,
): Promise<number[]> {
  const url = apiUrl(
    `/api/tracks/${trackId}/playlists?t=${encodeURIComponent(token)}${
      profileId != null ? `&profile_id=${profileId}` : ''
    }`,
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = (await res.json()) as { in_playlist_ids?: number[] };
    return Array.isArray(j.in_playlist_ids) ? j.in_playlist_ids : [];
  } catch {
    return [];
  }
}

/** Add or remove a library track from the profile's Liked Songs playlist. */
export async function setTrackLiked(
  token: string,
  trackId: number,
  liked: boolean,
  profileId?: number | null,
): Promise<boolean> {
  const res = await timedFetch(
    apiUrl(`/api/tracks/${trackId}/like?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ liked, profile_id: profileId ?? null }),
    },
  );
  if (!res.ok) throw new Error(`like failed (${res.status})`);
  const j = (await res.json()) as { liked?: boolean };
  return !!j.liked;
}

// ---- Listening stats ("Wrapped") ----

export interface StatTrack {
  track_id: number;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
  /** Whether an imported audio file exists for this track. Optional for
   *  back-compat with old cached payloads. */
  has_audio?: boolean;
  count: number;
}
export interface StatArtist {
  name: string;
  count: number;
}
export interface ListeningStats {
  total_plays: number;
  total_minutes: number;
  unique_artists: number;
  top_tracks: StatTrack[];
  top_artists: StatArtist[];
  /** Recently played, all-time top, and "from your past" (rediscover) — drive
   *  the Home shelves. Optional so an old cached /api/stats response still
   *  parses (the shelves just don't render). */
  recent_tracks?: StatTrack[];
  top_all_time?: StatTrack[];
  rediscover?: StatTrack[];
}

/** Record one listen. Fire-and-forget; failures are swallowed. */
export async function logPlay(
  token: string,
  trackId: number,
  profileId?: number | null,
): Promise<void> {
  try {
    await fetch(apiUrl(`/api/plays?t=${encodeURIComponent(token)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track_id: trackId, profile_id: profileId ?? null }),
    });
  } catch {
    /* stats are best-effort */
  }
}

/**
 * Record how much of a play was heard once the track ends or is skipped
 * (Phase 0 / Signal 4: completion-weighted taste). Updates the row `logPlay`
 * created at the ~20s threshold; a no-op server-side when the play never crossed
 * it. Fire-and-forget.
 */
export async function logPlayFinish(
  token: string,
  trackId: number,
  msPlayed: number,
  completed: boolean,
  profileId?: number | null,
): Promise<void> {
  try {
    await fetch(apiUrl(`/api/plays/finish?t=${encodeURIComponent(token)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        track_id: trackId,
        profile_id: profileId ?? null,
        ms_played: Math.max(0, Math.round(msPlayed)),
        completed,
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** Listening totals + top tracks/artists for a profile since `sinceEpoch` (seconds; 0/undefined = all time). */
export async function getStats(
  token: string,
  profileId?: number | null,
  sinceEpoch?: number,
): Promise<ListeningStats> {
  const url = apiUrl(
    `/api/stats?t=${encodeURIComponent(token)}${
      profileId != null ? `&profile_id=${profileId}` : ''
    }${sinceEpoch ? `&since=${sinceEpoch}` : ''}`,
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stats failed (${res.status})`);
  return (await res.json()) as ListeningStats;
}

export interface SearchAlbumResult {
  source: string;
  source_id: string;
  name: string;
  artists: string[];
  cover_url: string | null;
  album_type: string | null;
  release_date: string | null;
  total_tracks: number | null;
}

export interface SearchArtistResult {
  source: string;
  source_id: string;
  name: string;
  picture_url: string | null;
  total_albums: number | null;
  /** Deezer "fans" (favorited the artist) — shown on the artist hero. */
  total_fans: number | null;
}

export interface SearchResults {
  tracks: SearchTrackResult[];
  albums: SearchAlbumResult[];
  artists: SearchArtistResult[];
  /** Catalog (Deezer) playlists matching the query — so Discover's editorial
   *  playlists are findable from the search bar. May be absent on older
   *  responses, so callers should default it to []. */
  playlists?: CatalogPlaylistSummary[];
}

/**
 * A request to open an artist or album *page* identified only by name
 * (not by a Deezer id). The now-playing bar emits these when the user
 * clicks the song title (→ album) or an artist name (→ artist); the
 * SearchScreen resolves the name to a real Deezer hit via `searchCatalog`
 * and drills into it. `artist` narrows album disambiguation.
 */
export type CatalogOpenRequest =
  | { kind: 'artist'; name: string }
  | { kind: 'album'; name: string; artist?: string | null };

// --- Phone-direct discovery (hub-independent) -------------------------
//
// Catalog reads normally route through the desktop hub (which proxies Deezer
// and annotates each row with library ✓ state). When the hub is unreachable —
// the desktop is asleep/off but the phone still has internet — we fall back to
// hitting Deezer directly so search, artist pages, album drill-ins, and
// previews keep working. Deezer sends no CORS headers, so the direct path uses
// its JSONP mode (a <script> tag). Direct results carry no library state
// (local_track_id null), so saving to a playlist still needs the hub.

/** Wait this long on the hub before giving up and going Deezer-direct, so an
 *  unreachable desktop fails fast instead of hanging on a doomed TCP connect. */
const HUB_TIMEOUT_MS = 5000;

let hubReachable = true;
let lastHubOkAt = Date.now();
type HubListener = (reachable: boolean) => void;
const hubListeners = new Set<HubListener>();

/** A hub *failure* must persist this long before we believe it. The Player
 *  beats every 2s and each beat now flips this flag, so without hysteresis a
 *  single slow/aborted beat — an iOS radio wake, a TCP retransmit, a brief LAN
 *  blip, or a sub-second loopback stall during a desktop restart — would flap
 *  the flag and momentarily surface the "can't reach your computer" states to
 *  every consumer (the connection banner, the phone's "saving needs Beetbot on
 *  your computer" notice, the desktop's "restart the app" banner). Recovery
 *  stays instant: a single good beat clears it. */
const HUB_DOWN_GRACE_MS = 5000;

/** Where to send someone whose remote-access session has expired, or null when
 *  nothing has said one is needed. Set from the gate's own 401 body, never
 *  hardcoded — the core must not know which provider is in front of it. */
let signInUrl: string | null = null;
type SignInListener = (url: string | null) => void;
const signInListeners = new Set<SignInListener>();

/** The sign-in URL a remote-access gate asked us to send the owner to, if any.
 *
 *  This is a DIFFERENT failure from the hub being unreachable, and telling them
 *  apart is the whole point: the gate answering 401 means the request got all
 *  the way to the far end and was turned back for want of a session. Reporting
 *  that as "can't reach your library" sends the owner to go and check a computer
 *  that is working perfectly — which it did, on 28 Jul 2026, and cost an evening. */
export function getSignInUrl(): string | null {
  return signInUrl;
}
/** Subscribe to sign-in-required changes. Returns an unsubscribe fn. */
export function onSignInRequired(fn: SignInListener): () => void {
  signInListeners.add(fn);
  return () => {
    signInListeners.delete(fn);
  };
}
function setSignInUrl(v: string | null): void {
  if (signInUrl === v) return;
  signInUrl = v;
  for (const fn of signInListeners) fn(v);
}

/** Read a gate's "you are not signed in" answer, if that is what this is.
 *
 *  Deliberately narrow. A 401 alone is not enough — the hub itself answers 401
 *  for an invalid *device* token, which is a pairing problem and not something a
 *  browser sign-in fixes. The signal we act on is a 401 whose JSON body carries a
 *  `signIn` URL, which is the gate explicitly telling us where to send them.
 *  Anything else returns null and the caller carries on treating it as "answered". */
async function readSignInChallenge(resp: Response): Promise<string | null> {
  if (resp.status !== 401) return null;
  try {
    const body = (await resp.clone().json()) as { signIn?: unknown };
    const url = typeof body.signIn === 'string' ? body.signIn.trim() : '';
    // Only ever follow an absolute http(s) URL the gate supplied. A relative or
    // javascript: value here would be somebody else's idea of where to send the
    // owner's credentials.
    if (/^https?:\/\//i.test(url)) return url;
  } catch {
    // Not JSON, or an empty body — an ordinary 401, nothing to offer.
  }
  return null;
}

/** Did the desktop hub answer recently? (Reachability, debounced — see
 *  HUB_DOWN_GRACE_MS.) */
export function isHubReachable(): boolean {
  return hubReachable;
}
/** Subscribe to hub-reachability changes. Returns an unsubscribe fn. */
export function onHubReachability(fn: HubListener): () => void {
  hubListeners.add(fn);
  return () => {
    hubListeners.delete(fn);
  };
}
function emitHubReachable(v: boolean): void {
  if (hubReachable === v) return;
  hubReachable = v;
  for (const fn of hubListeners) fn(v);
}
/** Record a reachability observation. `true` (any answer from the hub) is
 *  believed immediately; `false` is believed only after HUB_DOWN_GRACE_MS of
 *  uninterrupted failure, so a lone failed beat between healthy ones is
 *  ignored. Every caller — the heartbeat, pingHub, and the catalog hubFirst
 *  fallback — routes through here, so all reachability UI debounces uniformly. */
function setHubReachable(v: boolean): void {
  if (v) {
    lastHubOkAt = Date.now();
    emitHubReachable(true);
  } else if (Date.now() - lastHubOkAt >= HUB_DOWN_GRACE_MS) {
    emitHubReachable(false);
  }
}

/** fetch() against the hub with an abort timeout. */
async function fetchHub(path: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HUB_TIMEOUT_MS);
  try {
    return await fetch(apiUrl(path), { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Try the desktop hub; on any failure fall back to a Deezer-direct path, and
 *  flip the reachability flag so the UI can show its discovery-only state. */
async function hubFirst<T>(
  desktop: () => Promise<T>,
  direct: () => Promise<T>,
): Promise<T> {
  try {
    const out = await desktop();
    setHubReachable(true);
    return out;
  } catch {
    const out = await direct();
    setHubReachable(false);
    return out;
  }
}

// ---- Deezer JSONP (works around their missing CORS headers) ----
let jsonpSeq = 0;
function deezerJsonp<T = unknown>(path: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('jsonp unavailable'));
      return;
    }
    const cb = `__bbdz_${Date.now()}_${jsonpSeq++}`;
    const sep = path.includes('?') ? '&' : '?';
    const src = `https://api.deezer.com/${path}${sep}output=jsonp&callback=${cb}`;
    const script = document.createElement('script');
    let settled = false;
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      delete w[cb];
      script.remove();
    };
    const timer = setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error('deezer jsonp timeout'));
      }
    }, 12000);
    w[cb] = (data: unknown) => {
      if (settled) return;
      cleanup();
      const d = data as { error?: { message?: string } };
      if (d && d.error)
        // Shaped so friendlyError() maps it to a clean line, not raw Deezer
        // copy (e.g. "Quota limit exceeded"); the detail stays for the console.
        reject(new Error(`deezer request failed: ${d.error.message || 'error'}`));
      else resolve(data as T);
    };
    script.onerror = () => {
      if (!settled) {
        cleanup();
        reject(new Error('deezer jsonp failed'));
      }
    };
    script.src = src;
    document.head.appendChild(script);
  });
}

interface DzList {
  data?: Record<string, unknown>[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function dzTrack(t: any): SearchTrackResult {
  return {
    source: 'deezer',
    source_id: String(t.id),
    title: t.title ?? t.title_short ?? '',
    artists: t.artist?.name ? [t.artist.name] : [],
    album: t.album?.title ?? null,
    album_art_url:
      t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || null,
    duration_ms: (t.duration ?? 0) * 1000,
    isrc: t.isrc ?? null,
    local_track_id: null,
    in_playlist_ids: [],
    has_audio: false,
    preview_url: t.preview || null,
    explicit: !!t.explicit_lyrics,
  };
}
function dzAlbum(a: any): SearchAlbumResult {
  return {
    source: 'deezer',
    source_id: String(a.id),
    name: a.title ?? '',
    artists: a.artist?.name ? [a.artist.name] : [],
    cover_url: a.cover_xl || a.cover_big || a.cover_medium || null,
    album_type: a.record_type ?? null,
    release_date: a.release_date ?? null,
    total_tracks: a.nb_tracks ?? null,
  };
}
function dzArtist(a: any): SearchArtistResult {
  return {
    source: 'deezer',
    source_id: String(a.id),
    name: a.name ?? '',
    picture_url: a.picture_xl || a.picture_big || a.picture_medium || null,
    total_albums: a.nb_album ?? null,
    total_fans: a.nb_fan ?? null,
  };
}
function dzPlaylist(p: any): CatalogPlaylistSummary {
  return {
    source: 'deezer',
    source_id: String(p.id),
    title: p.title ?? '',
    cover_url: p.picture_xl || p.picture_big || p.picture_medium || null,
    track_count: p.nb_tracks ?? null,
    creator: p.user?.name ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function searchDeezerDirect(
  query: string,
  limit: number,
): Promise<SearchResults> {
  const q = encodeURIComponent(query);
  // Tracks are the primary result; if that call fails, surface the error.
  // Albums/artists are secondary — tolerate their failure.
  const [tracks, albums, artists, playlists] = await Promise.all([
    deezerJsonp<DzList>(`search?q=${q}&limit=${limit}`).then((r) =>
      (r.data ?? []).map(dzTrack),
    ),
    deezerJsonp<DzList>(`search/album?q=${q}&limit=${limit}`)
      .then((r) => (r.data ?? []).map(dzAlbum))
      .catch(() => [] as SearchAlbumResult[]),
    deezerJsonp<DzList>(`search/artist?q=${q}&limit=${limit}`)
      .then((r) => (r.data ?? []).map(dzArtist))
      .catch(() => [] as SearchArtistResult[]),
    deezerJsonp<DzList>(`search/playlist?q=${q}&limit=${limit}`)
      .then((r) => (r.data ?? []).map(dzPlaylist))
      .catch(() => [] as CatalogPlaylistSummary[]),
  ]);
  return { tracks, albums, artists, playlists };
}

/**
 * Search the catalog for tracks and/or albums. Up to `limit` of each kind.
 *
 * Hits /api/search (desktop proxy to Deezer, with library ✓ state); falls back
 * to a direct Deezer search when the hub is unreachable.
 */
/** Comma-joined subset of the catalog entities the caller wants back. */
export type SearchTypes =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'track,album'
  | 'track,album,artist'
  | 'track,album,artist,playlist';

// --- Search result cache + dedupe + alias expansion -------------------
//
// Typing fires a live search per debounced keystroke (three Deezer calls each),
// which both burns the rate budget and re-fetches identical data when you
// toggle tabs, commit, or re-run a recent query. A small TTL cache + in-flight
// dedupe makes repeat searches instant and keeps us well under Deezer's quota.
// Invalidated whenever the library changes so the ✓ (in-library) marks stay
// fresh.
interface SearchCacheEntry {
  at: number;
  value: SearchResults;
}
const SEARCH_TTL_MS = 90_000;
const SEARCH_CACHE_MAX = 60;
const searchCache = new Map<string, SearchCacheEntry>();
const searchInflight = new Map<string, Promise<SearchResults>>();

/** Drop all cached search results — call after any library mutation so the
 *  next search re-fetches fresh in-library state. */
export function clearSearchCache(): void {
  searchCache.clear();
}

// Common shorthand / nicknames → the full name we actually search for. Kept
// small and high-confidence; only an exact whole-query match expands, and only
// the request is rewritten (the search box keeps showing what you typed).
const QUERY_ALIASES: Record<string, string> = {
  mj: 'michael jackson',
  tswift: 'taylor swift',
  't swift': 'taylor swift',
  ye: 'kanye west',
  jlo: 'jennifer lopez',
  biggie: 'notorious big',
  rhcp: 'red hot chili peppers',
  gnr: 'guns n roses',
  weeknd: 'the weeknd',
};
function expandQuery(q: string): string {
  return QUERY_ALIASES[q.trim().toLowerCase()] ?? q;
}

export async function searchCatalog(
  query: string,
  token: string,
  types: SearchTypes = 'track,album,artist',
  limit = 25,
): Promise<SearchResults> {
  const norm = query.trim();
  if (!norm) return { tracks: [], albums: [], artists: [], playlists: [] };
  // Include the active profile in the cache key — results carry profile-scoped
  // ✓ marks, so a query cached under one profile must not be served to another.
  const key = `${norm.toLowerCase()}|${types}|${limit}|${ACTIVE_PROFILE_ID ?? ''}`;

  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.value;
  const pending = searchInflight.get(key);
  if (pending) return pending;

  const effective = expandQuery(norm);
  const run = hubFirst(
    async () => {
      const params = new URLSearchParams({
        q: effective,
        type: types,
        limit: String(limit),
        t: token,
      });
      if (ACTIVE_PROFILE_ID != null) params.set('profile_id', String(ACTIVE_PROFILE_ID));
      const res = await fetchHub(`/api/search?${params.toString()}`);
      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { message?: string };
          detail = body.message ?? '';
        } catch {
          /* ignore */
        }
        throw new Error(
          `search failed (${res.status})${detail ? `: ${detail}` : ''}`,
        );
      }
      return (await res.json()) as SearchResults;
    },
    () => searchDeezerDirect(effective, limit),
  )
    .then((value) => {
      searchCache.set(key, { at: Date.now(), value });
      // Evict the oldest entry if we're over the cap.
      if (searchCache.size > SEARCH_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of searchCache) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey) searchCache.delete(oldestKey);
      }
      return value;
    })
    .finally(() => {
      searchInflight.delete(key);
    });

  searchInflight.set(key, run);
  return run;
}

// Resolved-preview cache: a library track isn't downloaded yet has no preview
// URL of its own, so we look one up from the catalog by title+artist (and
// ISRC when we have it). Cache per track so repeated taps are instant.
const previewUrlCache = new Map<string, string | null>();

/**
 * Find a 30-second Deezer preview clip for a library track that isn't
 * downloaded, by searching the catalog for "{title} {artist}" and picking the
 * best match (ISRC-exact first, then exact title, then any hit with a preview).
 * Returns null when nothing with a preview is found. Cached per track.
 */
export async function resolveTrackPreview(
  track: { title: string; artists: string[]; isrc?: string | null },
  token: string,
): Promise<string | null> {
  const isrc = track.isrc?.trim().toLowerCase() || '';
  const titleNorm = track.title.trim().toLowerCase();
  const key = isrc || `${titleNorm}|${(track.artists[0] ?? '').toLowerCase()}`;
  if (previewUrlCache.has(key)) return previewUrlCache.get(key) ?? null;

  let url: string | null = null;
  try {
    const q = `${track.title} ${track.artists[0] ?? ''}`.trim();
    const res = await searchCatalog(q, token, 'track', 8);
    const withPreview = res.tracks.filter((t) => !!t.preview_url);
    const pick =
      (isrc
        ? withPreview.find((t) => (t.isrc ?? '').toLowerCase() === isrc)
        : undefined) ??
      withPreview.find((t) => t.title.trim().toLowerCase() === titleNorm) ??
      withPreview[0];
    url = pick?.preview_url ?? null;
  } catch {
    url = null;
  }
  previewUrlCache.set(key, url);
  return url;
}

// --- Browse / discovery -----------------------------------------------
//
// Deezer's global charts + editorial new releases, surfaced as a
// home/browse feed. Same row/grid shapes as search, so the Browse UI
// reuses the search components (preview, add-to-playlist, drill-in).

export interface BrowseResults {
  chart_tracks: SearchTrackResult[];
  chart_albums: SearchAlbumResult[];
  chart_artists: SearchArtistResult[];
  new_releases: SearchAlbumResult[];
  /** Genre view only: a second "all-time classics" song row (Last.fm). */
  all_time_tracks?: SearchTrackResult[];
  /** Genre view only: curated genre playlists (Deezer), drillable. */
  playlists?: CatalogPlaylistSummary[];
}

/** A catalog (Deezer) playlist card for the "Popular [genre] playlists" row. */
export interface CatalogPlaylistSummary {
  source: string;
  source_id: string;
  title: string;
  cover_url: string | null;
  track_count: number | null;
  creator: string | null;
}

/** A catalog playlist's metadata + full tracklist (the drill-in view). */
export interface CatalogPlaylist {
  source: string;
  source_id: string;
  title: string;
  cover_url: string | null;
  creator: string | null;
  track_count: number | null;
  tracks: SearchTrackResult[];
}

/** Fetch the Browse feed (Deezer charts + new releases) behind the
 *  session token. Pass `genreId` to scope the charts to one genre (then
 *  `new_releases` comes back empty — Deezer has no per-genre release feed).
 *  Not service-worker cached — discovery wants fresh data. */
export function getBrowse(
  token: string,
  genre?: { id: number; name: string } | null,
): Promise<BrowseResults> {
  // profileParam() yields `&profile_id=N`; the no-genre branch has no query
  // string yet, so swap the leading `&` for `?`.
  const path = genre
    ? `/api/browse?genre=${genre.id}&genre_name=${encodeURIComponent(genre.name)}${profileParam()}`
    : `/api/browse${profileParam().replace(/^&/, '?')}`;
  return jsonGet<BrowseResults>(path, token);
}

/** A genre's top artists (Deezer `/genre/{id}/artists`) — genre-accurate and
 *  already carrying portraits, in ONE call. The onboarding taste grid uses this
 *  instead of deriving names from the full Browse assembly and re-resolving each
 *  name to a portrait (which funneled ~100 throttled Deezer calls through one
 *  gate and made the artist step take 30-45s). */
export function getGenreArtists(
  genreId: number,
  token: string,
): Promise<SearchArtistResult[]> {
  return jsonGet<SearchArtistResult[]>(`/api/genres/${genreId}/artists`, token);
}

/** One Home-feed shelf. `kind` is a render hint (currently only 'track_row'). */
/** One card in a heterogeneous `mixed_row` shelf (Spotify's "More like {X}"
 *  blend). Wrapper-tagged by `type` so it maps 1:1 onto the artist / album /
 *  playlist cards. */
export type MixedItem =
  | { type: 'artist'; artist: SearchArtistResult }
  | { type: 'album'; album: SearchAlbumResult }
  | { type: 'playlist'; playlist: CatalogPlaylistSummary };

export interface HomeShelf {
  /** "track_row" (catalog tracks) | "album_row" (catalog albums) |
   *  "stat_row" (local library tracks) | "artist_row" (catalog artists) |
   *  "playlist_row" (editorial playlists) | "mixed_row" (heterogeneous blend). */
  kind: string;
  title: string;
  eyebrow?: string | null;
  tracks?: SearchTrackResult[];
  albums?: SearchAlbumResult[];
  stat_tracks?: StatTrack[];
  artists?: SearchArtistResult[];
  /** "playlist_row" — catalog editorial playlists, tap opens the playlist. */
  playlists?: CatalogPlaylistSummary[];
  /** "mixed_row" — an ordered blend of artist/album/playlist cards in one row. */
  items?: MixedItem[];
  /** Round header thumbnail (the seed artist's photo on a "More like {X}" row). */
  seed_art?: string;
  /** Server display hint (P1): 'rail' → render as a "Made for you" portrait tile
   *  (the mixes); 'spotlight' → render as the mid-feed full-width band. Absent on
   *  older bundled servers → the client just renders a normal row. */
  display?: 'rail' | 'spotlight';
  /** Refresh-cadence caption for a rail tile, e.g. "New every Monday". Absent →
   *  the client's default ("New every day"). */
  cadence?: string;
}
export interface HomeFeed {
  shelves: HomeShelf[];
  /** Server-computed 4-bucket greeting ("Good morning" / "Good afternoon" /
   *  "Good evening" / "Late night") on the SERVER's clock. Rendered verbatim so
   *  the header agrees with the daypart shelf and phone↔Mac agree on remote
   *  access. Absent on older bundled servers → the client falls back to its own
   *  local-clock greeting. */
  greeting?: string;
  /** True when a "Welcome back" win-back shelf was hoisted for a dormant
   *  profile (imp 8). Drives a dot on the Home tab. */
  welcome_back?: boolean;
  /** Age in seconds of the cached discovery pool backing this feed (N6): 0 on a
   *  just-built response, up to ~6h on a warm cache hit. The client renders it
   *  as an honest "Updated …" caption. Absent on older servers → static
   *  fallback. */
  discovery_age_secs?: number;
  /** False when the profile has no play history yet, so the endless stations
   *  have nothing to seed from and would build an empty queue. The client hides
   *  the station tiles. Absent on older servers → treated as ready, which is
   *  their existing behaviour (check `=== false`, never falsiness). */
  station_ready?: boolean;
  /** True only on a `fast` response: the cheap subset of shelves, sent so the
   *  page can paint while the expensive ones are still resolving. The caller
   *  shows it at once and APPENDS the full feed's extra shelves when they land.
   *  Absent on older servers → the feed is complete, which for them it is. */
  partial?: boolean;
}

/** Personalized Home shelves (e.g. "More like your favorites") for a profile.
 *  The heavy discovery POOLS are long-cached server-side; `visit` is a
 *  per-visit nonce the server folds into its selection seed, so each app-open
 *  (and each pull-to-refresh) shows a fresh slice of those pools at zero
 *  catalog cost. Best-effort (returns `{shelves: []}` if there's not enough
 *  listening history yet). */
export function getHome(
  token: string,
  profileId?: number | null,
  visit?: string,
  fast?: boolean,
): Promise<HomeFeed> {
  const params = new URLSearchParams();
  if (profileId != null) params.set('profile_id', String(profileId));
  if (visit) params.set('v', visit);
  // `fast` skips the four shelves that own a cold build's wall clock, so the
  // page can paint in seconds instead of waiting out the whole thing. Never
  // cached server-side; always a strict subset of the full feed.
  if (fast) params.set('fast', '1');
  const qs = params.toString();
  return jsonGet<HomeFeed>(qs ? `/api/home?${qs}` : '/api/home', token);
}

/** "My station" — a one-tap personal station (a fusion mix over your top
 *  artists). Returns a seed batch; the player's autoplay keeps it going. */
export function getStation(
  token: string,
  profileId?: number | null,
  mode?: string,
): Promise<SearchTrackResult[]> {
  const params = new URLSearchParams();
  if (profileId != null) params.set('profile_id', String(profileId));
  if (mode) params.set('mode', mode);
  const qs = params.toString();
  return jsonGet<SearchTrackResult[]>(`/api/station${qs ? `?${qs}` : ''}`, token);
}

/** A Deezer genre for the "Browse by genre" tile grid. */
export interface Genre {
  id: number;
  name: string;
  picture_url: string | null;
}

/** Fetch the genre taxonomy (Deezer) for the Browse tile grid. */
export function getGenres(token: string): Promise<Genre[]> {
  return jsonGet<Genre[]>('/api/genres', token);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function deezerPlaylistDirect(playlistId: string): Promise<CatalogPlaylist> {
  const id = encodeURIComponent(playlistId);
  const meta = await deezerJsonp<any>(`playlist/${id}`);
  let tracks: SearchTrackResult[] = [];
  try {
    const t = await deezerJsonp<DzList>(`playlist/${id}/tracks?limit=100`);
    tracks = (t.data ?? []).map(dzTrack);
  } catch {
    // Fall back to the tracks embedded in the playlist meta response.
    tracks = ((meta.tracks?.data as Record<string, unknown>[]) ?? []).map(dzTrack);
  }
  const creatorName: string | null = meta.creator?.name ?? null;
  // Match the desktop: drop Deezer's editorial byline so it doesn't leak.
  const creator = creatorName && /deezer/i.test(creatorName) ? null : creatorName;
  return {
    source: 'deezer',
    source_id: String(meta.id),
    title: meta.title ?? '',
    cover_url:
      meta.picture_xl || meta.picture_big || meta.picture_medium || null,
    creator,
    track_count: meta.nb_tracks ?? tracks.length,
    tracks,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Drill into a catalog (Deezer) playlist from the genre Browse page:
 *  returns its metadata plus the full tracklist (with previews + ✓ marks),
 *  so the drill-in reuses the search track list and "Add all" import.
 *  Hub-first, Deezer-direct fallback — so a playlist you've never opened still
 *  loads when the desktop is off (it's a Deezer playlist, fetchable directly). */
export async function getCatalogPlaylist(
  playlistId: string,
  token: string,
): Promise<CatalogPlaylist> {
  return hubFirst(
    async () => {
      const res = await fetchHub(
        `/api/catalog/playlists/${encodeURIComponent(playlistId)}?t=${encodeURIComponent(token)}${profileParam()}`,
      );
      if (!res.ok) throw new Error(`catalog playlist failed (${res.status})`);
      return (await res.json()) as CatalogPlaylist;
    },
    () => deezerPlaylistDirect(playlistId),
  );
}

/** Drill into an album result: returns the track listing for it. Hub-first,
 *  Deezer-direct fallback. */
export async function getAlbumTracks(
  albumId: string,
  token: string,
): Promise<SearchTrackResult[]> {
  return hubFirst(
    async () => {
      const res = await fetchHub(
        `/api/albums/${encodeURIComponent(albumId)}/tracks?t=${encodeURIComponent(token)}${profileParam()}`,
      );
      if (!res.ok) throw new Error(`album tracks failed (${res.status})`);
      return (await res.json()) as SearchTrackResult[];
    },
    async () => {
      const r = await deezerJsonp<DzList>(
        `album/${encodeURIComponent(albumId)}/tracks?limit=100`,
      );
      return (r.data ?? []).map(dzTrack);
    },
  );
}

/** Drill into an artist result: returns their albums in the same shape
 *  as search-album results, so the UI can reuse AlbumGrid directly. */
export async function getArtistAlbums(
  artistId: string,
  token: string,
): Promise<SearchAlbumResult[]> {
  const raw = await hubFirst(
    async () => {
      const res = await fetchHub(
        `/api/artists/${encodeURIComponent(artistId)}/albums?t=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`artist albums failed (${res.status})`);
      return (await res.json()) as SearchAlbumResult[];
    },
    async () => {
      const r = await deezerJsonp<DzList>(
        `artist/${encodeURIComponent(artistId)}/albums?limit=50`,
      );
      return (r.data ?? []).map(dzAlbum);
    },
  );
  return dedupeArtistAlbums(raw);
}

// Deezer (and the hub mirror) frequently list the same release twice — explicit
// + clean, or multiple distributions — as separate album ids. Collapse by
// title+type so artist discographies don't show visual duplicates, keeping the
// newest of each. Keying on type too means a single and an album that share a
// name (rare) both survive.
function dedupeArtistAlbums(
  list: SearchAlbumResult[],
): SearchAlbumResult[] {
  const byNewest = (a: SearchAlbumResult, b: SearchAlbumResult) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? '');
  const seen = new Set<string>();
  const out: SearchAlbumResult[] = [];
  for (const a of [...list].sort(byNewest)) {
    const key = `${a.name.trim().toLowerCase()}|${(a.album_type ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** An artist's most popular tracks (Deezer ranking). Same shape as
 *  search tracks — preview clips and library state included — so the UI
 *  reuses the search track list. */
export async function getArtistTopTracks(
  artistId: string,
  token: string,
): Promise<SearchTrackResult[]> {
  return hubFirst(
    async () => {
      const res = await fetchHub(
        `/api/artists/${encodeURIComponent(artistId)}/top?t=${encodeURIComponent(token)}${profileParam()}`,
      );
      if (!res.ok) throw new Error(`artist top tracks failed (${res.status})`);
      return (await res.json()) as SearchTrackResult[];
    },
    async () => {
      const r = await deezerJsonp<DzList>(
        `artist/${encodeURIComponent(artistId)}/top?limit=50`,
      );
      return (r.data ?? []).map(dzTrack);
    },
  );
}

/** "Fans also like" — related artists, same shape as search artists, so
 *  the UI reuses ArtistGrid and tapping one drills into that artist. */
export async function getArtistRelated(
  artistId: string,
  token: string,
): Promise<SearchArtistResult[]> {
  return hubFirst(
    async () => {
      const res = await fetchHub(
        `/api/artists/${encodeURIComponent(artistId)}/related?t=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`related artists failed (${res.status})`);
      return (await res.json()) as SearchArtistResult[];
    },
    async () => {
      const r = await deezerJsonp<DzList>(
        `artist/${encodeURIComponent(artistId)}/related?limit=20`,
      );
      return (r.data ?? []).map(dzArtist);
    },
  );
}

export interface ArtistBio {
  extract: string;
  title: string;
  url: string;
  /** Apple-style About facts, best-effort from Wikidata; absent when unknown. */
  born?: string | null;
  from?: string | null;
  genre?: string | null;
}

/** A short Wikipedia "About" blurb for an artist (free, name-matched,
 *  cached server-side). Best-effort: resolves to null when none is found
 *  or the request fails, so the caller just hides the section. */
export async function getArtistBio(
  name: string,
  token: string,
): Promise<ArtistBio | null> {
  try {
    const params = new URLSearchParams({ name, t: token });
    const res = await fetch(apiUrl(`/api/artists/bio?${params.toString()}`));
    if (!res.ok) return null;
    return (await res.json()) as ArtistBio | null;
  } catch {
    return null;
  }
}

/** Albums by OTHER artists that feature this one (Apple Music's "Appears On").
 *  A server-side search heuristic — best-effort, empty on any failure so the
 *  caller just hides the rail. */
export async function getArtistAppearsOn(
  name: string,
  token: string,
): Promise<SearchAlbumResult[]> {
  try {
    const params = new URLSearchParams({ name, t: token });
    const res = await fetch(
      apiUrl(`/api/artists/appears-on?${params.toString()}`),
    );
    if (!res.ok) return [];
    return (await res.json()) as SearchAlbumResult[];
  } catch {
    return [];
  }
}

// --- Lyrics (LRCLIB) --------------------------------------------------

export interface Lyrics {
  /** Plain (unsynced) lyrics, newline-separated. Null when unavailable. */
  plain: string | null;
  /** Synced lyrics in LRC format. Null when unavailable. */
  synced: string | null;
  instrumental: boolean;
}

/** A single timed lyric line (seconds + text), parsed from LRC. */
export interface LyricsLine {
  t: number;
  text: string;
}

/**
 * Fetch plain + synced lyrics for a track from the hub (which proxies LRCLIB,
 * free + no key). Returns null when nothing is found. Best-effort: any error
 * resolves to null so the caller just shows "not available".
 */
export async function getLyrics(
  token: string,
  sig: {
    title: string;
    artist: string;
    album?: string | null;
    durationMs?: number;
  },
): Promise<Lyrics | null> {
  try {
    const params = new URLSearchParams({
      title: sig.title,
      artist: sig.artist,
      album: sig.album ?? '',
      duration: String(Math.round((sig.durationMs ?? 0) / 1000)),
      t: token,
    });
    const res = await fetch(apiUrl(`/api/lyrics?${params.toString()}`));
    if (!res.ok) return null;
    return (await res.json()) as Lyrics | null;
  } catch {
    return null;
  }
}

/** Parse an LRC string ("[mm:ss.xx] line") into sorted timed lines. A line may
 *  carry several timestamps; each becomes its own entry. */
export function parseLrc(synced: string): LyricsLine[] {
  const out: LyricsLine[] = [];
  const stamp = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  for (const raw of synced.split('\n')) {
    const text = raw.replace(stamp, '').trim();
    stamp.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = stamp.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracStr = m[3] ? m[3].padEnd(3, '0').slice(0, 3) : '0';
      const frac = parseInt(fracStr, 10) / 1000;
      out.push({ t: min * 60 + sec + frac, text });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export interface CreatedPlaylist {
  id: number;
  name: string;
  spotify_id: string;
}

/**
 * Create a new local-only playlist. The host mints a synthetic
 * `local:{uuid}` id (in the legacy-named `spotify_id` column) so it reads as
 * NOT imported — re-importing an archive never touches or clobbers it.
 *
 * Caller typically follows up with a track-add so the user lands on a
 * populated playlist rather than an empty one.
 */
export async function createPlaylist(
  name: string,
  token: string,
  profileId?: number | null,
): Promise<CreatedPlaylist> {
  const res = await timedFetch(
    apiUrl(`/api/playlists?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, profile_id: profileId ?? null }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`create playlist failed (${res.status})${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as CreatedPlaylist;
}

export interface ImportAlbumResult {
  playlist_id: number;
  inserted: number;
  total: number;
}

/**
 * "Save this whole album to my library" — creates a new local
 * playlist named after the album and links every track in one server
 * round-trip. The rows are stored metadata-only.
 *
 * Returns the new playlist's id so the caller can navigate into it
 * if desired.
 */
/** Fetch one per-profile KV value (opaque JSON owned by the caller — e.g.
 *  the desktop sidebar pins). Returns null when unset. */
export async function getProfileKv<T>(
  key: string,
  token: string,
  profileId?: number | null,
): Promise<T | null> {
  const p = profileId != null ? `&profile_id=${profileId}` : '';
  const res = await fetch(
    apiUrl(
      `/api/profile-kv?key=${encodeURIComponent(key)}${p}&t=${encodeURIComponent(token)}`,
    ),
  );
  if (!res.ok) throw new Error(`kv get failed (${res.status})`);
  return (await res.json()) as T | null;
}

/** Upsert one per-profile KV value (stored verbatim as JSON). */
export async function putProfileKv(
  key: string,
  value: unknown,
  token: string,
  profileId?: number | null,
): Promise<void> {
  const p = profileId != null ? `&profile_id=${profileId}` : '';
  const res = await fetch(
    apiUrl(
      `/api/profile-kv?key=${encodeURIComponent(key)}${p}&t=${encodeURIComponent(token)}`,
    ),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    },
  );
  if (!res.ok) throw new Error(`kv put failed (${res.status})`);
}

/** Permanently stop recommending an artist for this profile (P15). Best-effort. */
export async function banArtist(
  token: string,
  profileId: number | null,
  artist: string,
): Promise<void> {
  const p = profileId != null ? `&profile_id=${profileId}` : '';
  await fetch(
    apiUrl(
      `/api/feedback/ban?artist=${encodeURIComponent(artist)}${p}&t=${encodeURIComponent(token)}`,
    ),
    { method: 'POST' },
  );
}

export async function importAlbum(
  name: string,
  tracks: SearchTrackResult[],
  token: string,
  artist?: string | null,
  profileId?: number | null,
): Promise<ImportAlbumResult> {
  const res = await timedFetch(
    apiUrl(`/api/albums/import?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        tracks,
        artist: artist ?? null,
        profile_id: profileId ?? null,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `import album failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  clearSearchCache();
  return (await res.json()) as ImportAlbumResult;
}

/**
 * "Save this whole catalog playlist to my library" — creates a new local
 * playlist named after the source list and links every track in one server
 * round-trip. Mirrors `importAlbum` but the new row is a plain playlist
 * (not an album).
 */
export async function importPlaylist(
  name: string,
  tracks: SearchTrackResult[],
  token: string,
  profileId?: number | null,
): Promise<ImportAlbumResult> {
  const res = await timedFetch(
    apiUrl(`/api/playlists/import?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        tracks,
        profile_id: profileId ?? null,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `import playlist failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  clearSearchCache();
  return (await res.json()) as ImportAlbumResult;
}

export interface ResolvedTrack {
  track_id: number;
  status: string;
}

/**
 * Turn a catalog search/browse result into a real library track row (no
 * playlist link) and get back its id + status. The row is only playable once
 * the user imports an audio file for it on the desktop. Deduped by ISRC, so
 * re-resolving the same result reuses the row.
 */
export async function resolveCatalogTrack(
  track: SearchTrackResult,
  token: string,
): Promise<ResolvedTrack> {
  const res = await fetch(
    apiUrl(`/api/tracks/resolve?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(track),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `resolve track failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  return (await res.json()) as ResolvedTrack;
}

/**
 * Batch version of {@link resolveCatalogTrack}: upsert a whole list of catalog
 * results in one round-trip and get back their ids + statuses in the SAME
 * order. Used by "play from this list" to seed the full queue (so playback
 * auto-advances down it) without firing one resolve request per track.
 * Unresolvable entries come back as `{ track_id: 0 }` — the caller drops those.
 */
export async function resolveCatalogTracks(
  tracks: SearchTrackResult[],
  token: string,
): Promise<ResolvedTrack[]> {
  const res = await fetch(
    apiUrl(`/api/tracks/resolve-batch?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `resolve tracks failed (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  const body = (await res.json()) as { resolved: ResolvedTrack[] };
  return body.resolved;
}

/**
 * Autoplay/radio: fetch ~`limit` catalog tracks similar to `artist`, resolve
 * them to library ids, and return queue-ready StreamTracks. Only rows that
 * already have an imported audio file are playable; the rest come back with a
 * falsy status and the player's queue filter drops them. Best-effort — returns
 * [] on any failure so autoplay never throws into the player loop.
 */
export async function fetchRadioStreamTracks(
  artist: string,
  token: string,
  opts: { title?: string; limit?: number; profileId?: number | null } = {},
): Promise<StreamTrack[]> {
  const { title, limit = 30, profileId } = opts;
  try {
    const params = new URLSearchParams({ artist });
    if (title) params.set('title', title);
    params.set('limit', String(limit));
    if (profileId != null) params.set('profile_id', String(profileId));
    const cat = await jsonGet<SearchTrackResult[]>(
      `/api/radio/similar?${params.toString()}`,
      token,
    );
    if (!Array.isArray(cat) || cat.length === 0) return [];
    const resolved = await resolveCatalogTracks(cat, token);
    return cat.map((ct, i) => {
      const tid = resolved[i]?.track_id ?? 0;
      return {
        id: tid,
        title: ct.title,
        artists: ct.artists,
        album: ct.album,
        album_art_url: ct.album_art_url,
        duration_ms: ct.duration_ms,
        position: i,
        has_audio: tid ? ct.has_audio : false,
        status: tid && ct.has_audio ? 'downloaded' : '',
      };
    });
  } catch (e) {
    console.warn('[beetbot] radio fetch failed', e);
    return [];
  }
}

// --- Chromecast (server-side Cast) -------------------------------------
//
// The Beetbot Rust backend speaks the Cast V2 protocol to Chromecasts
// on the LAN directly — phones don't talk to the devices, they tell
// the backend what to do and the backend handles the TLS handshake +
// LAUNCH + LOAD + transport.

export interface CastDevice {
  id: string;
  friendly_name: string;
  model: string | null;
  host: string;
  port: number;
  ip: string | null;
}

export interface CastStartResult {
  device_id: string;
  device_name: string;
  stream_url: string;
}

export async function listCastDevices(token: string): Promise<CastDevice[]> {
  return jsonGet<CastDevice[]>('/api/cast/devices', token);
}

export async function castStart(
  deviceId: string,
  trackId: number,
  token: string,
  /**
   * Optional resume position in seconds. Pass the local <audio>
   * element's currentTime when starting a cast from mid-playback so
   * the receiver picks up where the listener left off instead of
   * restarting from 0. Backend treats values <= 0 / non-finite the
   * same as omitting the field.
   */
  startTime?: number,
): Promise<CastStartResult> {
  const body: { device_id: string; track_id: number; start_time?: number } = {
    device_id: deviceId,
    track_id: trackId,
  };
  if (typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0) {
    body.start_time = startTime;
  }
  const res = await fetch(
    apiUrl(`/api/cast/start?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cast start failed (${res.status})${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as CastStartResult;
}

export type CastAction = 'play' | 'pause' | 'seek';

export async function castControl(
  action: CastAction,
  seconds: number | undefined,
  token: string,
): Promise<void> {
  const body: { action: CastAction; seconds?: number } = { action };
  if (seconds !== undefined) body.seconds = seconds;
  const res = await fetch(
    apiUrl(`/api/cast/control?t=${encodeURIComponent(token)}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cast ${action} failed (${res.status})${text ? `: ${text}` : ''}`);
  }
}

export async function castStop(token: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/cast/stop?t=${encodeURIComponent(token)}`),
    { method: 'POST' },
  );
  if (!res.ok) {
    throw new Error(`cast stop failed (${res.status})`);
  }
}

/** Receiver state mirrored from the most recent MEDIA_STATUS frame. */
export interface CastStatusPayload {
  player_state: string; // "PLAYING" | "PAUSED" | "BUFFERING" | "IDLE" | ""
  current_time: number | null;
  idle_reason: string | null; // "FINISHED" | "CANCELLED" | ...
  track_id: number | null;
}

export interface CastStatusOut {
  active: boolean;
  device_id: string;
  device_name: string;
  status: CastStatusPayload;
}

/**
 * Poll the active cast session for state changes. The frontend uses this to
 * keep the scrubber in sync and to detect IDLE+FINISHED so it can advance
 * the queue. Returns `active: false` when nothing is casting.
 */
export async function getCastStatus(token: string): Promise<CastStatusOut> {
  return jsonGet<CastStatusOut>('/api/cast/status', token);
}

// --- Playback handoff ("Beetbot Connect"-lite) ------------------------
//
// Hand the now-playing queue + position from one device to another
// (phone <-> desktop). Each device announces itself via a heartbeat and polls
// a hub "mailbox" for a snapshot addressed to it; the hub just relays an opaque
// blob, so it never needs to understand either player's queue shape.

const DEVICE_ID_KEY = 'beetbot.device_id';

/** Stable per-install device id (random), persisted in localStorage. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode etc — fall back to an ephemeral per-load id.
    return `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

/** A device's published now-playing snapshot, relayed to the other devices so
 *  they can show a "playing on <device>" banner and remote-control it. */
export interface NowPlayingInfo {
  title: string;
  artists: string[];
  album_art_url: string | null;
  is_playing: boolean;
  /** Playhead and track length, so another device can draw a live progress
   *  bar for this one. Optional — a device on an older build reports neither,
   *  and readers just render no progress line. */
  position_ms?: number | null;
  duration_ms?: number | null;
  /** Library track id. `album_art_url` is null for most library tracks — the
   *  cover lives behind `/api/tracks/{id}/art`, which needs a token — so the
   *  id is what actually lets the READING device show artwork, signed with
   *  its own token (ours would be useless to it). */
  track_id?: number | null;
  /** The album the current track belongs to. Carried so a reader can offer
   *  "Go to album" for what another device is playing — without it that menu
   *  item has nothing to navigate to. */
  album?: string | null;
  /** What this device plays next — shuffle-aware, so it's the order the device
   *  will really use rather than the raw array. Capped at HEARTBEAT_QUEUE_MAX
   *  because this rides a 2-second heartbeat and nobody reads past the first
   *  screenful; `queue_len` carries the true remaining count so a reader can
   *  still say "and 40 more". Optional — a device on an older build reports
   *  neither, and readers show no queue rather than an empty one. */
  queue?: NowPlayingQueueItem[] | null;
  queue_len?: number | null;
}

/** One upcoming row, trimmed to what a remote list actually draws. */
export interface NowPlayingQueueItem {
  id: number;
  title: string;
  artists: string[];
}

/** How many upcoming tracks a device publishes on its heartbeat. */
export const HEARTBEAT_QUEUE_MAX = 20;

export interface RemoteDevice {
  device_id: string;
  label: string;
  kind: string;
  /** Null/absent when the device has nothing loaded. */
  now_playing?: NowPlayingInfo | null;
}

export type RemoteAction = 'play' | 'pause' | 'next' | 'prev';

/** A track as carried in a handoff snapshot — id + display fields. Each
 *  receiver maps it into its own player's track shape (the phone streams by id;
 *  the desktop streams the same id over HTTP since it arrives with no local
 *  path). */
export interface HandoffTrack {
  id: number;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
}

export interface HandoffPayload {
  source_label: string;
  tracks: HandoffTrack[];
  index: number;
  /** Playhead position in seconds. */
  position: number;
  playing: boolean;
}

/** Abort a heartbeat / ping this soon so a dead host fails fast. Without it a
 *  POST to an unreachable desktop can hang 30-60s on iOS Safari, which would
 *  leave the connection banner stale (and stall the presence beat). */
const HEARTBEAT_TIMEOUT_MS = 4000;

/** Announce this device is online + controllable, and publish what it's
 *  playing right now. Fire-and-forget.
 *
 *  The POST doubles as the app's liveness probe: it's never service-worker-
 *  cached (unlike GET /api/playlists, which can answer 200 from cache while the
 *  host is off), so a *resolved* response — any status — proves the desktop is
 *  reachable, and a thrown/timed-out fetch proves it isn't. We flip the shared
 *  reachability flag accordingly, so the Player's existing 2s beat drives the
 *  connection banner with no extra traffic. */
export async function sendHeartbeat(
  token: string,
  /** Pass null to let the hub name this device — it knows the machine's
   *  hostname and the session's User-Agent, so it names devices better (and
   *  distinguishably) than a client constant ever could. */
  label: string | null,
  kind: string,
  nowPlaying?: NowPlayingInfo | null,
  profileId?: number | null,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
  try {
    await fetch(
      apiUrl(`/api/devices/heartbeat?t=${encodeURIComponent(token)}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: getDeviceId(),
          label,
          kind,
          // Scope presence to the active profile so accounts stay isolated.
          profile_id: profileId ?? null,
          now_playing: nowPlaying ?? null,
        }),
        signal: ctrl.signal,
      },
    );
    setHubReachable(true);
  } catch {
    // Offline / host asleep / dropped from the LAN — handoff won't be
    // available, and the connection banner reflects the unreachable hub.
    setHubReachable(false);
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot reachability probe for the connection banner. Hits a cheap,
 *  read-only, never-cached hub GET and flips the reachability flag so the UI
 *  can re-check *immediately* — when the tab regains focus or the device comes
 *  back online — instead of waiting up to a heartbeat interval. Returns the new
 *  reachability. A plain `/api/devices` read (the same call the presence poll
 *  already makes) keeps it side-effect-free. */
export async function pingHub(token: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setHubReachable(false);
    return false;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ device_id: getDeviceId(), t: token });
    // Any resolved response (even 401/5xx) means the desktop answered.
    const resp = await fetch(apiUrl(`/api/devices?${params.toString()}`), {
      signal: ctrl.signal,
    });
    // Reachability is unchanged by a 401 — something answered, which is the only
    // question this flag asks. What a 401-with-a-signIn-URL adds is WHY it said
    // no, so the banner can offer the fix instead of blaming the computer.
    setSignInUrl(await readSignInChallenge(resp));
    setHubReachable(true);
    return true;
  } catch {
    setHubReachable(false);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Queue a transport action for another device (its banner buttons).
 *
 *  Carries the active profile like [`listDevices`] does: remote control and
 *  handoff are scoped to one account, so the server files these per profile and
 *  a device only ever drains its own. (A paired phone's claim is ignored in
 *  favour of its session; this is what tells the DESKTOP, which has no
 *  session-bound profile, which of its profiles is acting.) */
export async function postRemoteCommand(
  token: string,
  targetDeviceId: string,
  action: RemoteAction,
): Promise<void> {
  try {
    await fetch(
      apiUrl(`/api/remote-command?t=${encodeURIComponent(token)}${profileParam()}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target_device_id: targetDeviceId, action }),
      },
    );
  } catch {
    /* best-effort */
  }
}

/** Drain transport actions addressed to this device. Values are the transport
 *  verbs plus the occasional "handoff:<requester-device-id>" pull request. */
export async function pollRemoteCommands(token: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({ device_id: getDeviceId(), t: token });
    if (ACTIVE_PROFILE_ID != null) params.set('profile_id', String(ACTIVE_PROFILE_ID));
    const res = await fetch(apiUrl(`/api/remote-command?${params.toString()}`));
    if (!res.ok) return [];
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}

/** Ask another device to hand its current queue + playhead over to this one
 *  (the "sync to here" / pull direction). The target replies by posting a
 *  normal handoff snapshot, which this device's handoff poll then adopts. */
export async function requestHandoff(
  token: string,
  targetDeviceId: string,
): Promise<void> {
  try {
    await fetch(
      apiUrl(`/api/remote-command?t=${encodeURIComponent(token)}${profileParam()}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_device_id: targetDeviceId,
          action: `handoff:${getDeviceId()}`,
        }),
      },
    );
  } catch {
    /* best-effort */
  }
}

/** Other devices online right now (for the "Play on …" picker). */
export async function listDevices(
  token: string,
  profileId?: number | null,
): Promise<RemoteDevice[]> {
  const params = new URLSearchParams({ device_id: getDeviceId(), t: token });
  // Only ask for devices on the active profile — accounts are isolated.
  if (profileId != null) params.set('profile_id', String(profileId));
  const res = await fetch(apiUrl(`/api/devices?${params.toString()}`));
  if (!res.ok) throw new Error(`devices → ${res.status}`);
  return (await res.json()) as RemoteDevice[];
}

/** Hand the current snapshot to `targetDeviceId`. Profile-scoped: a handoff
 *  carries your queue and now-playing, so it's filed per account and only a
 *  device on that account can claim it. */
export async function postHandoff(
  token: string,
  targetDeviceId: string,
  payload: HandoffPayload,
): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/handoff?t=${encodeURIComponent(token)}${profileParam()}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_device_id: targetDeviceId, payload }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`handoff failed (${res.status})${text ? `: ${text}` : ''}`);
  }
}

/** Claim a pending handoff addressed to this device (consume-once). Returns
 *  null when nothing is waiting. */
export async function pollHandoff(
  token: string,
): Promise<HandoffPayload | null> {
  try {
    const params = new URLSearchParams({ device_id: getDeviceId(), t: token });
    if (ACTIVE_PROFILE_ID != null) params.set('profile_id', String(ACTIVE_PROFILE_ID));
    const res = await fetch(apiUrl(`/api/handoff?${params.toString()}`));
    if (!res.ok) return null;
    return (await res.json()) as HandoffPayload | null;
  } catch {
    return null;
  }
}

// --- Offline cache helpers ---------------------------------------------
//
// The service worker manages a dedicated `beetbot-audio-v2` cache keyed by
// the URL stripped of `?t=token`. These helpers run on the page side and
// talk to the same `caches` namespace directly (Cache API is shared
// between worker and document contexts).
//
// Keep this constant in sync with AUDIO_CACHE in web-player/public/sw.js.
// The version was bumped to v2 to evict pre-embedded-art m4a files so
// AirPlay receivers can pick up the freshly-embedded `covr` atom.

export const AUDIO_CACHE_NAME = 'beetbot-audio-v2';
const OFFLINE_PLAYLISTS_KEY = 'beetbot.offline_playlists';

/**
 * Whether the browser actually exposes the Cache API to this origin.
 *
 * Cache API + Service Workers require a "secure context": `https://`,
 * `http://localhost`, or `http://127.0.0.1`. Safari does NOT treat `.local`
 * mDNS hostnames or LAN IPs as secure contexts -- so an iPhone hitting
 * `http://my-mac.local:47823` can stream tracks (no special API needed)
 * but cannot use offline caching. Chrome and Firefox are more permissive.
 *
 * Use this guard to disable / hide offline-cache UI when it would only
 * produce confusing errors. `window.isSecureContext` is the canonical
 * signal but we also probe for the actual `caches` global so a browser
 * that reports secure-context=true but doesn't ship Cache API (rare) still
 * gets graceful handling.
 */
export function offlineCacheAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return typeof (window as { caches?: unknown }).caches !== 'undefined';
}

/** Canonical cache key for a track id. Matches the SW's strip logic. */
export function cacheKeyFor(trackId: number): string {
  return `${location.origin}/stream/${trackId}`;
}

/** Set of track ids currently in the offline cache. */
export async function getCachedTrackIds(): Promise<Set<number>> {
  if (!offlineCacheAvailable()) return new Set();
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const keys = await cache.keys();
  const ids = new Set<number>();
  for (const req of keys) {
    const m = /\/stream\/(\d+)/.exec(new URL(req.url).pathname);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

/**
 * Ask the browser to keep our offline audio around. By default the Cache API
 * lives in "best-effort" storage that the OS — iOS especially — silently evicts
 * under space pressure, so a user's saved songs can vanish with no warning.
 * `navigator.storage.persist()` promotes the whole origin to "persistent"
 * storage, which browsers won't auto-evict; on an installed (home-screen) PWA
 * it's typically granted without a prompt. Idempotent and cheap: it no-ops once
 * already persisted, and fires the actual request at most once per session so a
 * batch download doesn't spam it. Best-effort — a denial just leaves us on the
 * old evictable footing, so callers fire-and-forget.
 */
let persistentStorageRequested = false;
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage) return false;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) {
      return true;
    }
    if (persistentStorageRequested) return false;
    persistentStorageRequested = true;
    if (navigator.storage.persist) return await navigator.storage.persist();
  } catch {
    /* persistence is a nice-to-have; a failure just keeps the old behaviour */
  }
  return false;
}

/**
 * Download a single track and store it in the audio cache. Resolves once
 * the body has fully landed; rejects on any HTTP / I/O failure.
 *
 * Implementation notes:
 *   - We fetch with no Range header. <audio> elements add one, but plain
 *     `fetch()` does not. We want a full 200 OK with the entire body so
 *     the cached response covers any future Range request.
 *   - We materialize the body as a Blob and then put a freshly-constructed
 *     Response into the cache with only the headers we need. iOS Safari is
 *     finicky about which response headers it allows through cache.put()
 *     (Set-Cookie, certain Vary values, etc.). Stripping to the minimum
 *     avoids accidental rejects.
 *   - Returns the number of bytes cached so the caller can roll up totals.
 */
export async function cacheTrack(
  trackId: number,
  token: string,
): Promise<number> {
  if (!offlineCacheAvailable()) {
    throw new Error(
      'Offline caching needs a secure context (HTTPS). Browsers block the Cache API on plain http:// LAN addresses.',
    );
  }
  // Promote to eviction-resistant storage before the first track lands, so a
  // user's saved songs aren't silently reclaimed by the OS. Fire-and-forget:
  // it's idempotent and a denial just leaves the cache on best-effort footing.
  void ensurePersistentStorage();
  const res = await fetch(streamUrl(trackId, token), { cache: 'no-store' });
  if (!res.ok) {
    // Shaped so friendlyError() classifies it as a host-error (not raw text).
    throw new Error(`stream/${trackId} failed (${res.status})`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`stream/${trackId} failed (empty response)`);
  }
  const contentType = res.headers.get('content-type') ?? 'audio/mp4';
  const cleanResponse = new Response(blob, {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': contentType,
      'content-length': String(blob.size),
      'accept-ranges': 'bytes',
    },
  });
  const cache = await caches.open(AUDIO_CACHE_NAME);
  await cache.put(cacheKeyFor(trackId), cleanResponse);
  return blob.size;
}

/** Remove a single track from the audio cache. */
export async function evictTrack(trackId: number): Promise<boolean> {
  if (!offlineCacheAvailable()) return false;
  const cache = await caches.open(AUDIO_CACHE_NAME);
  return cache.delete(cacheKeyFor(trackId));
}

/** Wipe the entire audio cache. */
export async function evictAllAudio(): Promise<void> {
  if (!offlineCacheAvailable()) return;
  await caches.delete(AUDIO_CACHE_NAME);
}

/** Current storage usage from `navigator.storage.estimate()`. */
export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
} | null> {
  if (!('storage' in navigator) || !navigator.storage.estimate) return null;
  const est = await navigator.storage.estimate();
  return {
    usage: est.usage ?? 0,
    quota: est.quota ?? 0,
  };
}

/** Persisted list of playlist ids the user has flagged for offline use. */
export function getOfflinePlaylistIds(): Set<number> {
  try {
    const raw = localStorage.getItem(profileScopedKey(OFFLINE_PLAYLISTS_KEY));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is number => typeof x === 'number'));
  } catch {
    return new Set();
  }
}

// --- Recent searches & items ------------------------------------------
//
// Spotify-style recents: instead of just the text you typed, we remember the
// *things you engaged with* — a track you played, an artist/album you opened —
// alongside plain text queries you committed. Shown when the search bar is
// empty as rich rows you can tap to re-open/replay. Storing entities (not just
// strings) means no more typed-fragment pollution and a tap re-opens the exact
// thing. Capped to avoid unbounded localStorage growth.

/** One entry in the recents list: a committed text query, or an entity the
 *  user opened/played. Entities store the full result so a tap can re-act. */
export type RecentItem =
  | { kind: 'query'; text: string }
  | { kind: 'track'; track: SearchTrackResult }
  | { kind: 'artist'; artist: SearchArtistResult }
  | { kind: 'album'; album: SearchAlbumResult }
  | { kind: 'playlist'; playlist: CatalogPlaylistSummary };

const RECENT_ITEMS_KEY = 'beetbot.recent_items';
const LEGACY_RECENT_KEY = 'beetbot.recent_searches';
const RECENT_ITEMS_LIMIT = 12;

/** Dedup/identity key — query by lowercased text, entities by source id. */
function recentKey(it: RecentItem): string {
  switch (it.kind) {
    case 'query':
      return `q:${it.text.trim().toLowerCase()}`;
    case 'track':
      return `t:${it.track.source_id}`;
    case 'artist':
      return `a:${it.artist.source_id}`;
    case 'album':
      return `al:${it.album.source_id}`;
    case 'playlist':
      return `pl:${it.playlist.source_id}`;
  }
}

function isValidRecentItem(it: unknown): it is RecentItem {
  if (!it || typeof it !== 'object') return false;
  const r = it as Record<string, unknown>;
  switch (r.kind) {
    case 'query':
      return typeof r.text === 'string' && r.text.trim().length > 0;
    case 'track': {
      const t = r.track as { source_id?: unknown; artists?: unknown } | undefined;
      return !!t?.source_id && Array.isArray(t.artists);
    }
    case 'artist':
      return !!(r.artist as { source_id?: unknown })?.source_id;
    case 'album': {
      const a = r.album as { source_id?: unknown; artists?: unknown } | undefined;
      return !!a?.source_id && Array.isArray(a.artists);
    }
    case 'playlist':
      return !!(r.playlist as { source_id?: unknown } | undefined)?.source_id;
    default:
      return false;
  }
}

export function getRecentItems(): RecentItem[] {
  try {
    const raw = localStorage.getItem(profileScopedKey(RECENT_ITEMS_KEY));
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        return arr.filter(isValidRecentItem).slice(0, RECENT_ITEMS_LIMIT);
      }
    }
    // One-time migration: old versions stored a plain string[] of queries.
    // Fold it into the new key and drop the old one so this runs only once.
    const legacy = localStorage.getItem(LEGACY_RECENT_KEY);
    if (legacy) {
      const list = JSON.parse(legacy) as unknown;
      if (Array.isArray(list)) {
        const migrated = list
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .map((text): RecentItem => ({ kind: 'query', text }))
          .slice(0, RECENT_ITEMS_LIMIT);
        try {
          localStorage.setItem(profileScopedKey(RECENT_ITEMS_KEY), JSON.stringify(migrated));
          localStorage.removeItem(LEGACY_RECENT_KEY);
        } catch {
          /* ignore */
        }
        return migrated;
      }
    }
    return [];
  } catch {
    return [];
  }
}

function pushRecentItem(it: RecentItem): RecentItem[] {
  const key = recentKey(it);
  const next = [it, ...getRecentItems().filter((x) => recentKey(x) !== key)].slice(
    0,
    RECENT_ITEMS_LIMIT,
  );
  try {
    localStorage.setItem(profileScopedKey(RECENT_ITEMS_KEY), JSON.stringify(next));
  } catch {
    /* localStorage may be blocked (private mode); ignore */
  }
  return next;
}

export function addRecentQuery(text: string): RecentItem[] {
  const t = text.trim();
  if (!t) return getRecentItems();
  return pushRecentItem({ kind: 'query', text: t });
}

export function addRecentTrack(track: SearchTrackResult): RecentItem[] {
  return pushRecentItem({ kind: 'track', track });
}

export function addRecentArtist(artist: SearchArtistResult): RecentItem[] {
  return pushRecentItem({ kind: 'artist', artist });
}

export function addRecentAlbum(album: SearchAlbumResult): RecentItem[] {
  return pushRecentItem({ kind: 'album', album });
}

export function addRecentPlaylist(playlist: CatalogPlaylistSummary): RecentItem[] {
  return pushRecentItem({ kind: 'playlist', playlist });
}

/** Drop a single recent entry (its ✕ button), leaving the rest. Returns the
 *  remaining list so the caller can update state without a re-read. */
export function removeRecentItem(it: RecentItem): RecentItem[] {
  const key = recentKey(it);
  const next = getRecentItems().filter((x) => recentKey(x) !== key);
  try {
    localStorage.setItem(profileScopedKey(RECENT_ITEMS_KEY), JSON.stringify(next));
  } catch {
    /* localStorage may be blocked (private mode); ignore */
  }
  return next;
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(profileScopedKey(RECENT_ITEMS_KEY));
    localStorage.removeItem(LEGACY_RECENT_KEY);
  } catch {
    /* ignore */
  }
}

// --- Recently played playlists ---------------------------------------
//
// "Last opened at" timestamp per playlist, used to order the Library grid and
// Home's quick-access tiles Spotify-style (most recently visited first).
// Opening a playlist counts as a play — the same heuristic Spotify uses.
//
// This follows the PROFILE, not the device: the profile already is the
// "listener", so splitting a single listener's history between their phone and
// their desktop just fragmented it (you'd play something on the phone and the
// Mac's order wouldn't budge). localStorage is the fast local cache — it keeps
// the read synchronous and works offline — while the hub's per-profile KV is
// the shared source of truth, exactly like `pins.ts` / `saved.ts`.
//
// Reads seed from the cache and hydrate from the hub; writes are write-through
// (local first, then a best-effort PUT). Pull and push both MERGE by keeping
// the newest timestamp per playlist, so a play on one device can never erase a
// play on the other — important when a device was offline for a while.

const RECENT_PLAYLISTS_KEY = 'beetbot.recently_played_playlists';
/** Per-profile KV key on the hub holding the shared id → timestamp map. */
const RECENT_PLAYLISTS_KV_KEY = 'recent_playlists';

// Bumped whenever the local cache changes (a play, or a merge from the hub), so
// components sorting by recency can re-render — localStorage isn't reactive.
let recentPlaylistsVersion = 0;
const recentPlaylistsListeners = new Set<() => void>();
/** Subscribe to recency changes (useSyncExternalStore-shaped). */
export function subscribeRecentlyPlayedPlaylists(fn: () => void): () => void {
  recentPlaylistsListeners.add(fn);
  return () => {
    recentPlaylistsListeners.delete(fn);
  };
}
/** Snapshot for useSyncExternalStore — changes identity when recency changes. */
export function getRecentlyPlayedPlaylistsVersion(): number {
  return recentPlaylistsVersion;
}
function bumpRecentPlaylists(): void {
  recentPlaylistsVersion += 1;
  for (const fn of recentPlaylistsListeners) fn();
}
// Cap the persisted map so a power user with hundreds of playlists
// doesn't bloat localStorage. Everything past this many entries gets
// dropped on the next write — those playlists fall to the "never
// opened" bucket and sort by their default position.
const RECENT_PLAYLISTS_LIMIT = 200;

/** Returns a Map of playlist_id → epoch-ms timestamp of last open. */
export function getRecentlyPlayedPlaylists(): Map<number, number> {
  try {
    const raw = localStorage.getItem(profileScopedKey(RECENT_PLAYLISTS_KEY));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return new Map();
    const m = new Map<number, number>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v === 'number' && Number.isFinite(v)) {
        m.set(id, v);
      }
    }
    return m;
  } catch {
    return new Map();
  }
}

/** Newest-wins union of two id → timestamp maps. Merging (rather than letting
 *  either side overwrite) is what makes two devices converge: whichever played
 *  a playlist more recently supplies its timestamp, and neither can drop the
 *  other's plays made while it was offline. */
function mergeRecentPlaylists(
  a: Map<number, number>,
  b: Map<number, number>,
): Map<number, number> {
  const out = new Map(a);
  for (const [id, ts] of b) {
    const cur = out.get(id);
    if (cur == null || ts > cur) out.set(id, ts);
  }
  return out;
}

/** Keep only the newest RECENT_PLAYLISTS_LIMIT entries. */
function capRecentPlaylists(m: Map<number, number>): Map<number, number> {
  if (m.size <= RECENT_PLAYLISTS_LIMIT) return m;
  return new Map(
    [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, RECENT_PLAYLISTS_LIMIT),
  );
}

function writeRecentPlaylists(m: Map<number, number>, profileId: number | null): void {
  try {
    localStorage.setItem(
      profileScopedKey(RECENT_PLAYLISTS_KEY, profileId),
      JSON.stringify(Object.fromEntries(m)),
    );
  } catch {
    /* private-mode / quota — ignore, sort just falls back to default order */
  }
}

/** Best-effort push of the merged map to the hub. Silent on failure — the local
 *  cache stands and the next successful sync reconciles. */
function pushRecentPlaylists(m: Map<number, number>, profileId: number | null): void {
  void ensureSession()
    .then((token) =>
      putProfileKv(RECENT_PLAYLISTS_KV_KEY, Object.fromEntries(m), token, profileId),
    )
    .catch(() => {});
}

/**
 * Pull the hub's copy for the active profile and merge it into the local cache.
 * Fire-and-forget: called on every profile switch (see `setActiveProfileId`), so
 * the order a device shows reflects what you played on the other one.
 */
export async function syncRecentlyPlayedPlaylists(): Promise<void> {
  const profileId = ACTIVE_PROFILE_ID;
  try {
    const token = await ensureSession();
    const server = await getProfileKv<Record<string, number>>(
      RECENT_PLAYLISTS_KV_KEY,
      token,
      profileId,
    );
    // The profile may have changed while the fetch was in flight — don't write
    // one profile's history into another's cache.
    if (ACTIVE_PROFILE_ID !== profileId) return;
    if (!server || typeof server !== 'object') return;
    const remote = new Map<number, number>();
    for (const [k, v] of Object.entries(server)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v === 'number' && Number.isFinite(v)) {
        remote.set(id, v);
      }
    }
    const local = getRecentlyPlayedPlaylists();
    const merged = capRecentPlaylists(mergeRecentPlaylists(local, remote));
    writeRecentPlaylists(merged, profileId);
    bumpRecentPlaylists();
    // If we knew plays the hub didn't (offline on this device), hand them back.
    for (const [id, ts] of local) {
      if ((remote.get(id) ?? -1) < ts) {
        pushRecentPlaylists(merged, profileId);
        break;
      }
    }
  } catch {
    /* offline / older server / unpaired — local cache stands */
  }
}

/** Mark `playlistId` as played-just-now: local cache first (instant + offline
 *  safe), then a best-effort push so the other device picks it up. */
export function markPlaylistPlayed(playlistId: number): void {
  if (!Number.isFinite(playlistId)) return;
  const profileId = ACTIVE_PROFILE_ID;
  const next = capRecentPlaylists(
    getRecentlyPlayedPlaylists().set(playlistId, Date.now()),
  );
  writeRecentPlaylists(next, profileId);
  bumpRecentPlaylists();
  pushRecentPlaylists(next, profileId);
}

/**
 * Re-order `playlists` so the most recently opened ones come first.
 * Playlists this profile has never opened (on any device) keep their
 * relative order at the bottom of the list — that's important so a
 * brand-new install still shows the user's library in a sensible order
 * before they've tapped anything.
 */
export function sortPlaylistsByRecent<T extends { id: number }>(
  playlists: T[],
): T[] {
  const recents = getRecentlyPlayedPlaylists();
  if (recents.size === 0) return playlists;
  const recent: T[] = [];
  const rest: T[] = [];
  for (const p of playlists) {
    if (recents.has(p.id)) recent.push(p);
    else rest.push(p);
  }
  recent.sort((a, b) => (recents.get(b.id) ?? 0) - (recents.get(a.id) ?? 0));
  return [...recent, ...rest];
}

export function setOfflinePlaylistIds(ids: Set<number>): void {
  try {
    localStorage.setItem(profileScopedKey(OFFLINE_PLAYLISTS_KEY), JSON.stringify([...ids]));
  } catch {
    // localStorage may be blocked (private mode); silently ignore.
  }
}

/**
 * Drop any playlist from the "Available offline" localStorage flag that
 * no longer has a single cached track (the audio cache was wiped — most
 * often because we bumped the AUDIO_CACHE name to invalidate stale
 * bytes, or because the user evicted the cache, or browser-level
 * storage purge). The badge / count in the library then reflects
 * reality instead of a stale promise.
 *
 * Pass the array of `{id, trackIds}` for every playlist marked offline.
 * The caller is expected to have fetched playlist detail (which the
 * library prefetch hot-paths via the SW API cache).
 *
 * Returns the cleaned id Set; callers should update React state with it.
 */
export async function reconcileOfflinePlaylists(
  playlists: Array<{ id: number; trackIds: number[] }>,
): Promise<Set<number>> {
  if (!offlineCacheAvailable()) return getOfflinePlaylistIds();
  const cached = await getCachedTrackIds();
  const current = getOfflinePlaylistIds();
  let changed = false;
  for (const p of playlists) {
    if (!current.has(p.id)) continue;
    // Drop the flag iff the cache holds zero of this playlist's
    // tracks. A partial cache (some tracks present, some missing —
    // possible if the user paused a download mid-way or added tracks
    // to a playlist after marking it offline) keeps the flag set;
    // the playlist screen still shows "Make offline" to re-trigger
    // the missing downloads.
    const anyCached = p.trackIds.some((tid) => cached.has(tid));
    if (!anyCached) {
      current.delete(p.id);
      changed = true;
    }
  }
  if (changed) setOfflinePlaylistIds(current);
  return current;
}
