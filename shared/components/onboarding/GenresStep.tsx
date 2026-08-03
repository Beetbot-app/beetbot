import { useEffect, useState, type ReactNode } from 'react';
import { cn, EYEBROW_ON_ART } from '@shared/ui';
import { ensureSession, getGenres } from '@shared/api';
import { GENRES, MIN_GENRES, type TastePicks } from './useTastePicks';

/**
 * Step 1 — "What do you love?" A grid of genre tiles; at least `MIN_GENRES` are
 * required before the artist step unlocks. Each pick becomes a Home shelf AND
 * seeds the next step's artist suggestions, so the genres do double duty.
 *
 * The tiles match the Discover "Browse all" cards — a colour block with the real
 * genre photo tucked, tilted, into the corner (fetched via `getGenres`, keyed by
 * the bucket's catalog id). The gradient shows immediately; the photo drops in
 * when it loads, so the grid is never blank.
 */
export function GenresStep({
  taste,
  banners,
}: {
  taste: TastePicks;
  /** The host's error/notice banners, rendered under the step. */
  banners?: ReactNode;
}) {
  const { pickedGenres, toggleGenre } = taste;

  // Real genre artwork, keyed by catalog genre id → matched to each bucket's
  // `deezerId`. Best-effort: on failure the tiles just keep their gradient.
  const [images, setImages] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await ensureSession();
        const gs = await getGenres(token);
        if (cancelled) return;
        const m = new Map<number, string>();
        for (const g of gs) if (g.picture_url) m.set(g.id, g.picture_url);
        setImages(m);
      } catch {
        // Tiles fall back to gradient-only — no hard failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <p className={EYEBROW_ON_ART}>Let’s tune your Home</p>
      <h1 className="text-3xl font-bold tracking-tight">What do you love?</h1>
      <p className="max-w-lg text-sm leading-relaxed text-neutral-300">
        Pick at least {MIN_GENRES}. Each becomes a shelf on your Home, and next
        we’ll suggest artists from them.
      </p>

      {/* Rounded-rects per the shape rule (circle = artist). Discover-card look:
       *  colour block + tilted photo in the corner. Five columns so all ten
       *  genres sit in two even rows — no lonely pair on a third row. */}
      <div className="grid grid-cols-5 gap-3">
        {GENRES.map((g) => {
          const on = pickedGenres.has(g.bucket);
          const img = images.get(g.deezerId);
          return (
            <button
              key={g.bucket}
              type="button"
              onClick={() => toggleGenre(g)}
              aria-pressed={on}
              className={cn(
                'group relative isolate aspect-[16/10] overflow-hidden rounded-xl p-3 text-left ring-2 transition hover:brightness-110 active:scale-[.98]',
                on ? 'ring-white' : 'ring-transparent',
              )}
              style={{ backgroundImage: g.gradient }}
            >
              <span className="relative z-10 text-sm font-bold tracking-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]">
                {g.bucket}
              </span>
              {img ? (
                <img
                  src={img}
                  alt=""
                  draggable={false}
                  className="absolute -bottom-2 -right-3 h-[70%] aspect-square rounded-md object-cover rotate-[25deg] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
                />
              ) : null}
              {on ? (
                <span className="absolute right-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-[#43e08b] text-xs text-black shadow">
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {banners}
    </div>
  );
}
