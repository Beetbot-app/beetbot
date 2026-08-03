import { type ReactNode } from 'react';
import { cn, BTN_GHOST, EYEBROW_ON_ART } from '@shared/ui';
import { GRID_SIZE, type TastePicks } from './useTastePicks';

/** Skeletons shaped like the artist grid they precede — a pulsing circle + name
 *  per tile, so the wait reads as "this is loading" rather than a grey slab. */
export function ArtistGridSkeleton() {
  return (
    <div className="grid grid-cols-5 gap-x-4 gap-y-5">
      {Array.from({ length: GRID_SIZE }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-2">
          <div className="h-24 w-24 animate-pulse rounded-full bg-neutral-800" />
          <div className="h-3 w-14 animate-pulse rounded bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}

/**
 * Step 2 — "Any artists you love?" The circular artist grid, SEEDED from the
 * genres picked in step 1 (so the suggestions are relevant, not a generic global
 * chart). Optional: skipping it still seeds a few genre-derived artists.
 *
 * Presentational: every piece of state and every side effect lives in
 * `useTastePicks`, which the HOST calls — the footer needs to know whether
 * artists were picked, and the backdrop blooms from `taste.activeArt`.
 */
export function ArtistsStep({
  taste,
  importSlot,
  banners,
}: {
  taste: TastePicks;
  /** Desktop only: the "Or bring your playlists" importer, which needs Tauri IPC.
   *  Omitted on the phone — there's no filesystem to import from. */
  importSlot?: ReactNode;
  /** The host's error/notice banners, rendered under the step. */
  banners?: ReactNode;
}) {
  const { chartArtists, artistsLoading, selected, setHoverArt, toggleArtist, surpriseMe } =
    taste;

  return (
    <div className="space-y-5">
      <p className={EYEBROW_ON_ART}>Almost there</p>
      <h1 className="text-3xl font-bold tracking-tight">Any artists you love?</h1>
      <p className="max-w-lg text-sm leading-relaxed text-neutral-300">
        Pulled from the genres you picked. Choose any you love — or skip, and
        we’ll start from your genres. Music starts once you’re done.
      </p>

      {artistsLoading ? (
        <ArtistGridSkeleton />
      ) : chartArtists.length ? (
        <div className="grid grid-cols-5 gap-x-4 gap-y-5">
          {chartArtists.map((a) => {
            const on = selected.has(a.name);
            return (
              <button
                key={a.source_id}
                type="button"
                onClick={() => toggleArtist(a)}
                onMouseEnter={() => setHoverArt(a.picture_url ?? null)}
                onMouseLeave={() => setHoverArt(null)}
                onFocus={() => setHoverArt(a.picture_url ?? null)}
                onBlur={() => setHoverArt(null)}
                aria-pressed={on}
                className="group flex flex-col items-center gap-2"
              >
                <span
                  className={cn(
                    'relative block h-24 w-24 overflow-hidden rounded-full ring-2 transition',
                    on ? 'ring-white' : 'ring-white/10 group-hover:ring-white/40',
                  )}
                >
                  {a.picture_url ? (
                    <img
                      src={a.picture_url}
                      alt=""
                      draggable={false}
                      className="h-full w-full object-cover transition duration-[var(--dur-surface)] group-hover:scale-105"
                    />
                  ) : (
                    <span className="grid h-full w-full place-items-center bg-neutral-800 text-xl text-neutral-400">
                      {a.name.charAt(0)}
                    </span>
                  )}
                  {on && (
                    <span className="absolute inset-0 grid place-items-center bg-black/45 text-xl text-white">
                      ✓
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 text-center text-xs leading-tight text-neutral-300">
                  {a.name}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          No suggestions loaded — that’s fine, skip and your genres will seed your
          Home. You can search for anything once you’re in.
        </p>
      )}

      <div className="flex items-center gap-4 pt-1">
        <button
          type="button"
          onClick={surpriseMe}
          disabled={!chartArtists.length}
          className={cn(BTN_GHOST, 'disabled:opacity-40')}
        >
          Surprise me
        </button>
        {importSlot}
      </div>
      {banners}
    </div>
  );
}
