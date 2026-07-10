/**
 * A square cover built from up to four artworks — a 2×2 collage, Daily-Mix
 * style. Used by the "Made for you" mix tiles and the mix detail page, whose
 * content spans several albums so no single cover represents them.
 *
 * - 0 arts → a ♪ placeholder.
 * - 1 art  → that single image (no grid).
 * - 2–4    → a 2×2 grid; 2 or 3 arts repeat to fill the four cells so the tile
 *            never has an empty quadrant.
 *
 * Takes already-resolved image URLs (callers pass track/album art directly).
 */
export function CollageCover({
  urls,
  className,
  alt = '',
}: {
  urls: (string | null | undefined)[];
  className?: string;
  alt?: string;
}) {
  // Distinct, non-empty arts in order.
  const seen = new Set<string>();
  const arts: string[] = [];
  for (const u of urls) {
    if (u && !seen.has(u)) {
      seen.add(u);
      arts.push(u);
    }
  }

  if (arts.length === 0) {
    return (
      <div className={`grid place-items-center bg-neutral-800 ${className ?? ''}`}>
        <span className="text-neutral-600">♪</span>
      </div>
    );
  }

  if (arts.length === 1) {
    return (
      <img
        src={arts[0]}
        alt={alt}
        className={`object-cover ${className ?? ''}`}
        draggable={false}
        loading="lazy"
      />
    );
  }

  // Fill four quadrants, repeating the available arts if there are only 2 or 3.
  const quad = [0, 1, 2, 3].map((i) => arts[i % arts.length]);
  return (
    <div className={`grid grid-cols-2 grid-rows-2 bg-neutral-800 ${className ?? ''}`}>
      {quad.map((u, i) => (
        <img
          key={i}
          src={u}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          loading="lazy"
        />
      ))}
    </div>
  );
}
