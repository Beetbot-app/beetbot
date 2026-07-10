// Pull a single representative color out of an album-art image, for the
// Daft-style ambient wash behind the app chrome. We downscale to a tiny canvas
// and take a *saturation-weighted* average so the tint leans toward the vivid
// part of the cover (the hue your eye reads) instead of muddying to gray.
//
// Remote covers (Deezer/Spotify CDNs) need CORS to be readable from a canvas;
// when the CDN doesn't allow it the canvas is tainted and getImageData throws —
// we just resolve null and the caller keeps its default tint. Never rejects.

export type Rgb = [number, number, number];

const cache = new Map<string, Rgb | null>();

export function extractDominantColor(url: string): Promise<Rgb | null> {
  const cached = cache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const done = (c: Rgb | null) => {
      cache.set(url, c);
      resolve(c);
    };
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return done(null);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let r = 0;
        let g = 0;
        let b = 0;
        let wsum = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue; // skip transparent
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];
          const max = Math.max(R, G, B);
          const min = Math.min(R, G, B);
          const sat = max === 0 ? 0 : (max - min) / max;
          // Baseline weight so flat covers still yield a color, plus a strong
          // pull toward saturated pixels so the tint matches the cover's accent.
          const w = 0.15 + sat * 1.5;
          r += R * w;
          g += G * w;
          b += B * w;
          wsum += w;
        }
        if (wsum === 0) return done(null);
        done([Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)]);
      } catch {
        done(null); // tainted canvas (CORS) — fall back to the default tint
      }
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

/**
 * The ambient artwork wash — ONE formula shared by the app-window backdrop
 * (App root) and the detail-page heroes (HeroWash), so moving between pages
 * feels like one lit space.
 *
 * - `anchor: 'window'` (default) fills the viewport over an opaque near-black
 *   base with a faint bottom glow — the whole-app wash.
 * - `anchor: 'hero'` is a top-anchored band that fades to transparent, so it
 *   layers over a page's own background.
 *
 * `tint` null → a fixed warm fallback (matches the app when nothing is playing
 * or the cover can't be read across CORS).
 */
export function ambientGradient(
  tint: Rgb | null,
  opts?: { anchor?: 'window' | 'hero' },
): string {
  const anchor = opts?.anchor ?? 'window';
  if (anchor === 'hero') {
    if (!tint) {
      return 'radial-gradient(120% 80% at 50% -12%, rgba(214,112,60,0.32), rgba(150,70,50,0.10) 45%, transparent 72%)';
    }
    const [r, g, b] = tint;
    return `radial-gradient(120% 80% at 50% -12%, rgba(${r},${g},${b},0.42), rgba(${r},${g},${b},0.12) 45%, transparent 72%)`;
  }
  if (!tint) {
    return 'radial-gradient(150% 95% at 50% -32%, rgba(214,112,60,0.42), rgba(150,70,50,0.16) 38%, transparent 72%), radial-gradient(100% 70% at 10% 120%, rgba(70,100,165,0.18), transparent 62%), #0a0a0b';
  }
  const [r, g, b] = tint;
  return `radial-gradient(150% 95% at 50% -32%, rgba(${r},${g},${b},0.5), rgba(${r},${g},${b},0.13) 42%, transparent 72%), radial-gradient(100% 70% at 10% 120%, rgba(${r},${g},${b},0.12), transparent 62%), #0a0a0b`;
}
