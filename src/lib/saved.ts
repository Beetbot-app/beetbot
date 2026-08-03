import { create } from 'zustand';
import { ensureSession, getProfileKv, putProfileKv } from '@shared/api';

// Saved artists: the ones the user has deliberately kept (Spotify/Apple-style),
// as opposed to the exhaustive set derived from every song in their playlists.
// Feeds the Library "Artists" tab. Scoped per profile, same mechanics as
// sidebar pins — localStorage is the fast cache, the hub's per-profile KV
// ("saved_artists") is the cross-device source of truth. (Saved *albums* reuse
// the existing album-import playlists, so they don't need a store here.)

export interface SavedArtist {
  /** Normalized grouping key (matches LibraryArtist.key) — used for joins. */
  key: string;
  name: string;
  art: string | null;
  savedAt: number;
  /** True once `art` is the real Deezer artist portrait (not the album-cover
   *  placeholder the bulk "Add from your songs" seed stores). Gates the
   *  one-time portrait backfill so we resolve each artist at most once. */
  portrait?: boolean;
}

/** Stable identity for dedupe/toggle. By lowercased display name (like pins),
 *  so a save from the artist page matches one from the library grid regardless
 *  of the normalized grouping key. */
export function savedArtistId(name: string): string {
  return name.toLowerCase();
}

/**
 * Keep a set of artists as onboarding picks, and don't return until the write
 * has LANDED.
 *
 * `addArtists` already pushes to the server, but fire-and-forget — right for a
 * toggle, wrong for onboarding, where the very next thing that happens is Home
 * asking the server for a feed seeded from exactly these picks. So await our own
 * write, which also evicts that profile's Home cache server-side. Lives here
 * rather than in the wizard because `shared/` (where the taste step lives) must
 * not reach up into `src/lib`, and both hosts hand this to it.
 */
export async function followArtists(
  items: Omit<SavedArtist, 'savedAt'>[],
  profileId: number,
): Promise<void> {
  useSavedStore.getState().addArtists(items);
  const token = await ensureSession();
  await putProfileKv('saved_artists', useSavedStore.getState().artists, token, profileId);
}

export function isArtistSaved(saved: SavedArtist[], name: string): boolean {
  const id = savedArtistId(name);
  return saved.some((a) => savedArtistId(a.name) === id);
}

// Saved genres: the coarse taste buckets ("Electronic", "Jazz", …) the user
// tapped during onboarding. Unlike artists there's no Library surface for them,
// so they don't need a store — they're a pure day-one seed the server reads to
// fill the genre shelves ("Popular in Electronic") before any listening history
// exists. Written to the same per-profile KV as saved_artists, under a key the
// PUT handler also treats as a Home-cache-evicting onboarding pick.
const SAVED_GENRES_KV_KEY = 'saved_genres';

/** Persist the onboarding genre picks (coarse bucket labels), awaited — the
 *  very next thing is Home asking the server for a feed seeded from them, and
 *  this write evicts that profile's cached feed server-side. Deduped, trimmed. */
export async function followGenres(buckets: string[], profileId: number): Promise<void> {
  const uniq = [...new Set(buckets.map((b) => b.trim()).filter(Boolean))];
  const token = await ensureSession();
  await putProfileKv(SAVED_GENRES_KV_KEY, uniq, token, profileId);
}

const KEY = 'beetbot.saved.artists';
type ByProfile = Record<string, SavedArtist[]>;

function load(): ByProfile {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as ByProfile;
  } catch {
    return {};
  }
}
function persist(map: ByProfile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage may be blocked; saves just won't survive a relaunch */
  }
}

let map = load();

const KV_KEY = 'saved_artists';

/** Best-effort write-through to the hub. Failures are silent — the local cache
 *  stays authoritative until the next successful sync. */
function pushToServer(profileId: number, artists: SavedArtist[]): void {
  void ensureSession()
    .then((token) => putProfileKv(KV_KEY, artists, token, profileId))
    .catch(() => {});
}

function applyLocal(profileId: number, next: SavedArtist[]): void {
  map = { ...map, [String(profileId)]: next };
  persist(map);
}

interface SavedState {
  profileId: number | null;
  artists: SavedArtist[];
  setProfile: (id: number | null) => void;
  /** Add if absent, remove if present (identity by lowercased name). */
  toggleArtist: (a: Omit<SavedArtist, 'savedAt'>) => void;
  removeArtist: (name: string) => void;
  /** Bulk add (skipping any already saved) — powers "Add from your songs". */
  addArtists: (items: Omit<SavedArtist, 'savedAt'>[]) => void;
  /** Set a saved artist's resolved portrait (marks `portrait` so the backfill
   *  skips it next time). No-op if the artist isn't saved or nothing changed. */
  setArtwork: (name: string, art: string | null) => void;
}

export const useSavedStore = create<SavedState>((set, get) => ({
  profileId: null,
  artists: [],
  setProfile: (id) => {
    // Seed instantly from the local cache, then hydrate from the hub. Ignore a
    // stale response if the profile changed again while the fetch was inflight.
    set({
      profileId: id,
      artists: id == null ? [] : (map[String(id)] ?? []),
    });
    if (id == null) return;
    void ensureSession()
      .then((token) => getProfileKv<SavedArtist[]>(KV_KEY, token, id))
      .then((server) => {
        if (!Array.isArray(server)) return;
        if (get().profileId !== id) return;
        applyLocal(id, server);
        set({ artists: server });
      })
      .catch(() => {
        /* offline / older server — local cache stands */
      });
  },
  toggleArtist: (a) => {
    const { profileId } = get();
    if (profileId == null) return;
    const cur = map[String(profileId)] ?? [];
    const id = savedArtistId(a.name);
    const next = cur.some((x) => savedArtistId(x.name) === id)
      ? cur.filter((x) => savedArtistId(x.name) !== id)
      : [{ ...a, savedAt: Date.now() }, ...cur];
    applyLocal(profileId, next);
    set({ artists: next });
    pushToServer(profileId, next);
  },
  removeArtist: (name) => {
    const { profileId } = get();
    if (profileId == null) return;
    const id = savedArtistId(name);
    const next = (map[String(profileId)] ?? []).filter(
      (x) => savedArtistId(x.name) !== id,
    );
    applyLocal(profileId, next);
    set({ artists: next });
    pushToServer(profileId, next);
  },
  addArtists: (items) => {
    const { profileId } = get();
    if (profileId == null) return;
    const cur = map[String(profileId)] ?? [];
    const have = new Set(cur.map((x) => savedArtistId(x.name)));
    const fresh = items
      .filter((a) => !have.has(savedArtistId(a.name)))
      .map((a) => ({ ...a, savedAt: Date.now() }));
    if (fresh.length === 0) return;
    const next = [...fresh, ...cur];
    applyLocal(profileId, next);
    set({ artists: next });
    pushToServer(profileId, next);
  },
  setArtwork: (name, art) => {
    const { profileId } = get();
    if (profileId == null) return;
    const id = savedArtistId(name);
    const cur = map[String(profileId)] ?? [];
    let changed = false;
    const next = cur.map((x) => {
      if (savedArtistId(x.name) !== id) return x;
      if (x.portrait && x.art === art) return x; // already resolved to this
      changed = true;
      return { ...x, art, portrait: true };
    });
    if (!changed) return;
    applyLocal(profileId, next);
    set({ artists: next });
    pushToServer(profileId, next);
  },
}));
