import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ensureSession,
  getArtistTopTracks,
  getGenreArtists,
  getHome,
  type HomeShelf,
  type SearchArtistResult,
  type SearchTrackResult,
} from '@shared/api';
import { setInstantHomeShelves } from '@shared/onboardingHome';

/** How many artists the derived grid offers, and the most a person can pick. */
export const GRID_SIZE = 15;
export const MAX_PICKS = 6;
/** How many "Surprise me" seeds — enough to shape a feed, few enough to feel picked. */
export const SURPRISE_PICKS = 3;

/** Genres required before the artist step unlocks (Aria's floor). Three genres
 *  guarantee enough signal to seed both the genre shelves and a full artist grid. */
export const MIN_GENRES = 3;
/** Artists kept per genre in the cache — the pool the derived grid draws from. */
const CACHE_ARTISTS_PER_GENRE = 10;
/** If the artist step is skipped, seed the follow set from this many of the
 *  genre-derived artists, so Library isn't empty and the artist shelves fill. */
const FALLBACK_ARTISTS = 5;

/**
 * The genre tiles that open onboarding, for anyone whose answer to "what do you
 * love?" is a sound. Each is one of the server's coarse taste buckets (see
 * `GENRE_BUCKETS` in the backend), paired with the catalog genre id its charts —
 * and its tile artwork (via `getGenres`) — live under. Picking genres:
 *   1. persists the bucket LABELS (`saved_genres`), which the server reads to
 *      fill the "Popular in {genre}" shelves before any listening history exists;
 *   2. seeds the NEXT step's artist grid from those genres' top tracks;
 *   3. provides a playback + follow seed if the artist step is skipped.
 *
 * Bucket labels must match the backend's `GENRE_BUCKETS` verbatim, and every id
 * must be one `bucket_to_deezer_genre` maps (Folk is deliberately absent — the
 * catalog doesn't cleanly chart it). The gradient is the tile's base colour; the
 * step overlays the real genre photo on top when `getGenres` provides one.
 */
export const GENRES: Array<{ bucket: string; deezerId: number; gradient: string }> = [
  { bucket: 'Electronic', deezerId: 113, gradient: 'linear-gradient(135deg,#6d4bd8,#b14bd8)' },
  { bucket: 'Jazz', deezerId: 129, gradient: 'linear-gradient(135deg,#1d9e9e,#1d6e9e)' },
  { bucket: 'Hip-Hop', deezerId: 116, gradient: 'linear-gradient(135deg,#d89a30,#d85a30)' },
  { bucket: 'R&B', deezerId: 165, gradient: 'linear-gradient(135deg,#993535,#d4537e)' },
  { bucket: 'Rock', deezerId: 152, gradient: 'linear-gradient(135deg,#4b6d11,#639922)' },
  { bucket: 'Pop', deezerId: 132, gradient: 'linear-gradient(135deg,#185fa5,#378add)' },
  { bucket: 'Classical', deezerId: 98, gradient: 'linear-gradient(135deg,#633806,#ba7517)' },
  { bucket: 'Country', deezerId: 84, gradient: 'linear-gradient(135deg,#712b13,#993c1d)' },
  { bucket: 'Latin', deezerId: 197, gradient: 'linear-gradient(135deg,#72243e,#d4537e)' },
  { bucket: 'Metal', deezerId: 464, gradient: 'linear-gradient(135deg,#3c3489,#534ab7)' },
];

/** A picked genre's top artists (Deezer `/genre/{id}/artists`) — genre-accurate
 *  and portrait-carrying — cached so the grid and the skip-path playback reuse
 *  the on-tap fetch rather than refetch. */
type GenreData = SearchArtistResult[];

/** A synthetic source id would mark an artist with no real catalog hit (no
 *  id/portrait). The genre-artists path only ever yields real artists, so this
 *  is now purely defensive — playback still skips anything so marked. */
const SYNTHETIC_ARTIST_PREFIX = 'name:';

/** Round-robin interleave several lists so the result mixes sources from the
 *  first item, not all of list 1 then all of list 2. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const l of lists) if (l[i] !== undefined) out.push(l[i]);
  }
  return out;
}

/** The most "Because you like {artist}" rows we prepend to Home — enough to feel
 *  personal, few enough not to bury the server's own feed below them. */
const INSTANT_ARTIST_ROWS = 4;

/**
 * Turn the freshly-fetched seed-artist top tracks into instant Home shelves and
 * hand them to any mounted `HomeScreen` (see `shared/onboardingHome`), so a
 * just-onboarded profile lands on a full, high-signal page instead of the empty
 * partial the cold server discovery build leaves behind for tens of seconds.
 *
 * Reuses tracks onboarding already fetched for playback — no extra Deezer calls.
 * Builds a blended "Your mix" plus one "Because you like {artist}" row per pick
 * (capped). Artists with too few tracks are skipped rather than shown thin.
 */
function seedInstantHome(
  profileId: number,
  fetched: Array<{ artist: SearchArtistResult; tracks: SearchTrackResult[] }>,
): void {
  const withTracks = fetched.filter((f) => f.tracks.length >= 4);
  if (!withTracks.length) return;

  const shelves: HomeShelf[] = [];
  // Lead with a blended mix — the "just put something on" row.
  const mix = interleave(withTracks.map((f) => f.tracks.slice(0, 6))).slice(0, 24);
  if (mix.length >= 6) {
    shelves.push({
      kind: 'track_row',
      title: 'Your mix',
      eyebrow: 'Made from your picks',
      tracks: mix,
    });
  }
  for (const f of withTracks.slice(0, INSTANT_ARTIST_ROWS)) {
    shelves.push({
      kind: 'track_row',
      title: `Because you like ${f.artist.name}`,
      eyebrow: 'For you',
      tracks: f.tracks.slice(0, 16),
    });
  }
  setInstantHomeShelves(profileId, shelves);
}

export type TastePicks = ReturnType<typeof useTastePicks>;

/**
 * Everything the taste flow knows, with no host in it: the genre tiles, the
 * genre-derived artist grid, the picks, and the two side effects that must stay
 * strictly ordered — write the picks when leaving the artist step, start the
 * music only when the wizard finishes.
 *
 * The flow is two steps (Aria-style): pick genres (≥ MIN_GENRES), then pick
 * artists SEEDED FROM those genres' top tracks. Selecting a genre is instant —
 * its data is fetched in the BACKGROUND so tapping never blocks the next tap;
 * the artist step awaits any still-in-flight fetch before building its grid.
 *
 * Split out of the desktop wizard so the phone can run the same flow. It touches
 * ONLY `@shared/api` and the (Tauri-free) saved store, so it imports cleanly into
 * the web bundle; the one host-specific thing, playback, is injected.
 */
export function useTastePicks({
  activeProfileId,
  onPlayTracks,
  followArtists,
  followGenres,
}: {
  activeProfileId: number;
  /** Start playing. Injected per host: `playOnDesktop` / the phone's player. */
  onPlayTracks: (queue: SearchTrackResult[]) => Promise<void>;
  /** Persist the artist picks, awaited. Injected (rather than imported) because
   *  the saved store lives in `src/lib` and `shared/` must not reach up into it. */
  followArtists: (
    items: Array<{ key: string; name: string; art: string | null }>,
    profileId: number,
  ) => Promise<void>;
  /** Persist the genre picks (bucket labels), awaited. Same injection reason. */
  followGenres: (buckets: string[], profileId: number) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  // Drives the backdrop bloom: what you're pointing at wins, else the last thing
  // you picked, so the color persists through the rest of the flow.
  const [hoverArt, setHoverArt] = useState<string | null>(null);
  const [pickedArt, setPickedArt] = useState<string | null>(null);
  const activeArt = hoverArt ?? pickedArt;

  // --- Step 1: genres -------------------------------------------------------
  // Selected buckets are the ONLY genre state that re-renders; each genre's
  // resolved data and its in-flight fetch live in refs so a tap never has to
  // await anything.
  const [pickedGenres, setPickedGenres] = useState<Set<string>>(new Set());
  const genreData = useRef<Map<string, GenreData>>(new Map());
  const genreFetches = useRef<Map<string, Promise<void>>>(new Map());

  /** Kick off (once) the background fetch of a genre's top artists — ONE light
   *  Deezer call (`/genre/{id}/artists`), genre-accurate and portrait-carrying,
   *  with no Browse assembly and no per-name re-resolution. */
  const fetchGenre = useCallback((g: { bucket: string; deezerId: number }) => {
    if (genreData.current.has(g.bucket) || genreFetches.current.has(g.bucket)) return;
    const p = (async () => {
      try {
        const token = await ensureSession();
        const artists = await getGenreArtists(g.deezerId, token);
        genreData.current.set(g.bucket, artists.slice(0, CACHE_ARTISTS_PER_GENRE));
        // Bloom the backdrop from the genre's top artist once it lands (hover wins).
        const art = artists[0]?.picture_url;
        if (art) setPickedArt(art);
      } catch {
        // Leave uncached; the derive step fetches it (and tops up globally).
      } finally {
        genreFetches.current.delete(g.bucket);
      }
    })();
    genreFetches.current.set(g.bucket, p);
  }, []);

  /**
   * Toggle a genre tile — INSTANT and optimistic: flip the pick synchronously
   * (so the ✓ appears immediately and the next tile is tappable right away) and
   * fetch the genre's data in the background. No await, no disabling siblings.
   */
  const toggleGenre = useCallback(
    (g: { bucket: string; deezerId: number }) => {
      setPickedGenres((cur) => {
        const next = new Set(cur);
        if (next.has(g.bucket)) next.delete(g.bucket);
        else next.add(g.bucket);
        return next;
      });
      fetchGenre(g);
    },
    [fetchGenre],
  );

  const enoughGenres = useMemo(() => pickedGenres.size >= MIN_GENRES, [pickedGenres]);

  // --- Step 2: artists (derived from the picked genres) ---------------------
  const [chartArtists, setChartArtists] = useState<SearchArtistResult[]>([]);
  const [artistsLoading, setArtistsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /**
   * Build the artist grid from the picked genres, painting faces AS each genre's
   * artists arrive rather than flashing the whole grid at the end.
   *
   * Each genre is ONE light Deezer call (`/genre/{id}/artists`) that already
   * returns real, genre-accurate artists WITH portraits — so there's no
   * track-derivation and no per-name re-resolution. The old path derived names
   * from each genre's fully-resolved top tracks and then re-searched every name
   * to a portrait, funneling ~100 throttled Deezer calls (110ms apart, one gate)
   * into a single blocking batch — 30-45s, then all 15 at once. Reuses the
   * on-tap fetch when it's in flight/cached; tops up from the global top artists
   * (Deezer genre 0) if the union is thin.
   */
  const deriveArtistsFromGenres = useCallback(async () => {
    setArtistsLoading(true);
    const buckets = [...pickedGenres];
    // Per-genre lists as they arrive, re-interleaved into the grid on each
    // arrival so faces stream in AND stay varied across the picked genres.
    const arrived: SearchArtistResult[][] = [];
    let grid: SearchArtistResult[] = [];
    const repaint = () => {
      const merged: SearchArtistResult[] = [];
      const seen = new Set<string>();
      for (const a of interleave(arrived)) {
        if (merged.length >= GRID_SIZE) break;
        const k = a.name.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        merged.push(a);
      }
      grid = merged;
      setChartArtists(merged);
    };

    try {
      const token = await ensureSession();
      const loadGenre = async (b: string): Promise<SearchArtistResult[]> => {
        if (genreData.current.has(b)) return genreData.current.get(b)!;
        const inflight = genreFetches.current.get(b);
        if (inflight) {
          await inflight;
          if (genreData.current.has(b)) return genreData.current.get(b)!;
        }
        const g = GENRES.find((x) => x.bucket === b);
        if (!g) return [];
        try {
          const artists = (await getGenreArtists(g.deezerId, token)).slice(
            0,
            CACHE_ARTISTS_PER_GENRE,
          );
          genreData.current.set(b, artists);
          return artists;
        } catch {
          return [];
        }
      };

      // Fire all picked genres at once; paint each genre's artists the moment it
      // lands (each is ~1 throttled call, so the grid fills within ~1s).
      await Promise.all(
        buckets.map(async (b) => {
          const artists = await loadGenre(b);
          if (artists.length) {
            arrived.push(artists);
            repaint();
          }
        }),
      );

      // Thin union → top up from the global top artists (Deezer genre 0), one call.
      if (grid.length < GRID_SIZE) {
        try {
          const global = await getGenreArtists(0, token);
          if (global.length) {
            arrived.push(global);
            repaint();
          }
        } catch {
          // Keep the genre artists we already painted.
        }
      }
    } catch {
      // Session/fetch failed — leave whatever painted (else the skeleton).
    } finally {
      setArtistsLoading(false);
    }

    // Pre-warm the feed (best-effort): persist the GENRES now and kick a
    // background Home build, so a SKIP of the artist step still lands on a filled
    // (genre-seeded) Home. Deliberately does NOT follow the genre-derived
    // artists — following artists the user never picked is exactly the surprise
    // we must avoid, and because the follow write is additive it would linger
    // even after explicit picks. The seed list is kept ONLY for the skip path's
    // playback / instant-Home shelves (transient, never saved). The Home cache
    // key is (profile, date), so this warm and the finish refetch hit the same
    // entry.
    try {
      const token = await ensureSession();
      const seedList = grid.slice(0, FALLBACK_ARTISTS);
      const promise = (async () => {
        if (buckets.length) await followGenres(buckets, activeProfileId);
        void getHome(token, activeProfileId).catch(() => {});
      })();
      warmedRef.current = { seedList, promise };
    } catch {
      // Pre-warm is best-effort; the finish refetch still builds the feed.
    }
  }, [pickedGenres, activeProfileId, followGenres]);

  const toggleArtist = useCallback((a: SearchArtistResult) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(a.name)) next.delete(a.name);
      else if (next.size < MAX_PICKS) {
        next.add(a.name);
        setPickedArt(a.picture_url ?? null);
      }
      return next;
    });
  }, []);

  /** "Surprise me" — seed a few of the genre-derived artists at random. */
  const surpriseMe = useCallback(() => {
    if (!chartArtists.length) return;
    // Fisher-Yates — sort(() => Math.random() - 0.5) is a biased shuffle.
    const shuffled = [...chartArtists];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const picks = shuffled.slice(0, SURPRISE_PICKS);
    setSelected(new Set(picks.map((a) => a.name)));
    setPickedArt(picks[0]?.picture_url ?? null);
  }, [chartArtists]);

  // Remember what was picked so it can start playing when the wizard finishes.
  // Read from refs, not state, because `follow` and `play` happen at different
  // moments and the component may have re-rendered in between.
  const seedArtistsRef = useRef<SearchArtistResult[]>([]);
  // The genre step pre-warms the feed: leaving it persists the genres + the
  // genre-derived fallback artists and kicks a Home build in the background, so
  // by the time the user finishes the cold build is (often) already done and
  // Home is instant. `followPicks` reuses this on the skip path rather than
  // re-writing (which would evict the warm and restart the build).
  const warmedRef = useRef<{
    seedList: SearchArtistResult[];
    promise: Promise<void>;
  } | null>(null);

  /**
   * Follow the picks: save the genre buckets AND the artists (explicitly chosen,
   * or a few genre-derived ones if the artist step was skipped) to the profile,
   * so Home can seed from both. Then warm the server's now-picks-based feed so
   * the refetch on finish lands on a filled page. Deliberately plays NOTHING.
   */
  const followPicks = useCallback(async () => {
    const explicit = chartArtists.filter((a) => selected.has(a.name));
    const buckets = [...pickedGenres];

    // Skip path: the user picked NO artists. Follow NOTHING (only the genres,
    // already saved by the pre-warm) — auto-following the genre-derived grid is
    // exactly the "artists I didn't select" surprise. Reuse the pre-warm's Home
    // build; keep the genre seed only for playback / instant-Home (transient).
    if (!explicit.length) {
      if (warmedRef.current) {
        seedArtistsRef.current = warmedRef.current.seedList;
        return warmedRef.current.promise;
      }
      // No pre-warm ran (rare) — at least persist the genres.
      seedArtistsRef.current = chartArtists.slice(0, FALLBACK_ARTISTS);
      if (buckets.length) await followGenres(buckets, activeProfileId);
      return;
    }

    // Explicit picks: follow ONLY the artists the user chose (plus the genres).
    seedArtistsRef.current = explicit;
    const items = explicit.map((a) => ({
      key: a.name,
      name: a.name,
      art: a.picture_url ?? null,
    }));
    setSeeding(true);
    try {
      // Awaited: the picks must be persisted — and the server's Home cache for
      // this profile invalidated — before the wizard can finish. Both KV writes
      // evict the cache server-side, so the finish refetch sees the seeded feed.
      if (buckets.length) await followGenres(buckets, activeProfileId);
      await followArtists(items, activeProfileId);
      // Then warm the now-picks-based feed in the background, so finish's
      // refetch is a fast cache hit rather than a cold multi-second build.
      const token = await ensureSession();
      void getHome(token, activeProfileId).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setSeeding(false);
    }
  }, [chartArtists, selected, pickedGenres, activeProfileId, followArtists, followGenres]);

  /**
   * Start playing. Call ONLY when the wizard finishes. Builds the opening queue
   * from the seed artists' top tracks — the same fetch that seeds Home's instant
   * "Because you like {artist}" shelves, so it's paid once.
   */
  const startPicksPlayback = useCallback(async () => {
    const picked = seedArtistsRef.current;
    const lists: SearchTrackResult[][] = [];

    // The genre-artists path yields only real artists, so every seed carries a
    // catalog id; the synthetic-id guard below is now purely defensive.
    const realArtists = picked.filter((a) => !a.source_id.startsWith(SYNTHETIC_ARTIST_PREFIX));
    if (realArtists.length) {
      try {
        const token = await ensureSession();
        // Fetch each seed artist's top tracks ONCE, then use it twice: to seed
        // Home's instant "Because you like {artist}" shelves (so a just-onboarded
        // profile lands on a full page immediately, not the empty partial the cold
        // ~40s discovery build leaves behind) and to build the opening play queue.
        const fetched = await Promise.all(
          realArtists.map((a) =>
            getArtistTopTracks(a.source_id, token)
              .then((tracks) => ({ artist: a, tracks }))
              .catch(() => ({ artist: a, tracks: [] as SearchTrackResult[] })),
          ),
        );
        seedInstantHome(activeProfileId, fetched);
        for (const f of fetched) if (f.tracks.length) lists.push(f.tracks.slice(0, 6));
      } catch (e) {
        console.warn('[beetbot] onboarding artist playback failed', e);
      }
    }

    const queue = interleave(lists).slice(0, 25);
    if (queue.length) {
      try {
        await onPlayTracks(queue);
      } catch (e) {
        console.warn('[beetbot] onboarding playback failed', e);
      }
    }
  }, [onPlayTracks, activeProfileId]);

  const hasArtistPicks = useMemo(() => selected.size > 0, [selected]);

  return {
    // step 1
    pickedGenres,
    enoughGenres,
    toggleGenre,
    // step 2
    chartArtists,
    artistsLoading,
    selected,
    hasArtistPicks,
    deriveArtistsFromGenres,
    toggleArtist,
    surpriseMe,
    // shared
    seeding,
    error,
    activeArt,
    clearError: useCallback(() => setError(null), []),
    setHoverArt,
    followPicks,
    startPicksPlayback,
  };
}
