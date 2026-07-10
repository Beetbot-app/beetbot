import { useEffect, useState } from 'react';
import { ambientGradient, extractDominantColor, type Rgb } from '../albumColor';

/**
 * The one hero backdrop for every detail page (artist / album / playlist), on
 * both platforms. It derives the page's own artwork color and paints the SAME
 * ambient wash the app window + Home use — so navigating between pages feels
 * like moving through one lit space rather than switching screens (identity
 * §Tint / swing X2).
 *
 * Three layers, back to front:
 *  1. a faint blurred cover — a belt-and-suspenders base so covers whose CDN
 *     blocks canvas reads (CORS) still contribute color even when extraction
 *     returns null;
 *  2. the top-anchored accent radial (ambientGradient hero variant), cross-fading
 *     on art change;
 *  3. a downward neutral-950 veil so hero text stays legible over the wash.
 *
 * Drop it in as the FIRST child of a `relative` hero container; size/position
 * come from the parent (or an override `className`). Purely decorative.
 */
export function HeroWash({
  coverUrl,
  className,
}: {
  coverUrl: string | null | undefined;
  className?: string;
}) {
  const [tint, setTint] = useState<Rgb | null>(null);
  useEffect(() => {
    if (!coverUrl) {
      setTint(null);
      return;
    }
    let cancelled = false;
    void extractDominantColor(coverUrl).then((c) => {
      if (!cancelled) setTint(c);
    });
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full scale-125 object-cover opacity-30 blur-2xl"
        />
      ) : null}
      <div
        className="absolute inset-0"
        style={{
          background: ambientGradient(tint, { anchor: 'hero' }),
          transition: 'background 700ms ease',
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-neutral-950/55 to-neutral-950" />
    </div>
  );
}
