import { create } from 'zustand';
import { ensureSession, getProfileKv, putProfileKv } from '@shared/api';

// Sidebar pins (Daft-style): artists / albums / songs / playlists the user has
// pinned to the sidebar, scoped per profile (the library is shared, but pins
// are a personal shortcut list). localStorage is the fast local cache; the
// hub's per-profile KV ("sidebar_pins") is the source of truth, so pins
// survive reinstalls and follow the profile across devices. Reads hydrate
// from the server after seeding from cache; writes are write-through
// (local first, then best-effort PUT).

export type Pin =
  | { kind: 'artist'; key: string; name: string; art: string | null }
  | { kind: 'album'; album: string; artist: string | null; art: string | null }
  | {
      kind: 'song';
      id: number;
      title: string;
      artist: string | null;
      art: string | null;
    }
  | {
      kind: 'playlist';
      id: number;
      name: string;
      art: string | null;
      /** The library source ('album' for whole-album imports) — drives the
       *  sidebar subtitle so a pinned album reads "Album", not "Playlist".
       *  Identity is still id-based, so this is display-only. */
      source?: string;
    };

/** Stable identity for a pin, used for dedupe / toggle / unpin. */
export function pinId(p: Pin): string {
  switch (p.kind) {
    case 'artist':
      // Identity by display name (case-insensitive) so a pin made from the
      // artist page dedupes with one made from the library, regardless of the
      // normalized grouping key.
      return `artist:${p.name.toLowerCase()}`;
    case 'album':
      return `album:${p.album.toLowerCase()}::${(p.artist ?? '').toLowerCase()}`;
    case 'song':
      return `song:${p.id}`;
    case 'playlist':
      return `playlist:${p.id}`;
  }
}

export function isPinned(pins: Pin[], p: Pin): boolean {
  const id = pinId(p);
  return pins.some((x) => pinId(x) === id);
}

const KEY = 'beetbot.pins';
type ByProfile = Record<string, Pin[]>;

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
    /* storage may be blocked; pins just won't survive a relaunch */
  }
}

// The full map lives module-scoped; the store mirrors the active profile's slice
// as a reactive `pins` array so components re-render on change.
let map = load();

interface PinState {
  profileId: number | null;
  pins: Pin[];
  setProfile: (id: number | null) => void;
  toggle: (p: Pin) => void;
  unpin: (id: string) => void;
}

const KV_KEY = 'sidebar_pins';

/** Best-effort write-through to the hub. Failures are silent — the local
 *  cache stays authoritative until the next successful sync. */
function pushToServer(profileId: number, pins: Pin[]): void {
  void ensureSession()
    .then((token) => putProfileKv(KV_KEY, pins, token, profileId))
    .catch(() => {});
}

function applyLocal(profileId: number, next: Pin[]): void {
  map = { ...map, [String(profileId)]: next };
  persist(map);
}

export const usePinStore = create<PinState>((set, get) => ({
  profileId: null,
  pins: [],
  setProfile: (id) => {
    // Seed instantly from the local cache, then hydrate from the hub (the
    // cross-device source of truth). Ignore the response if the profile
    // changed again while the fetch was in flight.
    set({ profileId: id, pins: id == null ? [] : (map[String(id)] ?? []) });
    if (id == null) return;
    void ensureSession()
      .then((token) => getProfileKv<Pin[]>(KV_KEY, token, id))
      .then((server) => {
        if (!Array.isArray(server)) return;
        if (get().profileId !== id) return;
        applyLocal(id, server);
        set({ pins: server });
      })
      .catch(() => {
        /* offline / older server — local cache stands */
      });
  },
  toggle: (p) => {
    const { profileId } = get();
    if (profileId == null) return;
    const cur = map[String(profileId)] ?? [];
    const id = pinId(p);
    const next = cur.some((x) => pinId(x) === id)
      ? cur.filter((x) => pinId(x) !== id)
      : [p, ...cur];
    applyLocal(profileId, next);
    set({ pins: next });
    pushToServer(profileId, next);
  },
  unpin: (id) => {
    const { profileId } = get();
    if (profileId == null) return;
    const next = (map[String(profileId)] ?? []).filter((x) => pinId(x) !== id);
    applyLocal(profileId, next);
    set({ pins: next });
    pushToServer(profileId, next);
  },
}));
