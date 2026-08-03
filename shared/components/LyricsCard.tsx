import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { parseLrc, type Lyrics } from '../api';
import { cn } from '../ui';
import { LyricsView } from './LyricsView';

/**
 * The lyrics card that sits under a Now Playing screen, plus the full-screen
 * reader it opens.
 *
 * Lives in shared because two screens show it: this phone's own Now Playing,
 * and the one for a device playing somewhere else. They were never going to
 * stay identical as two copies — and "what's playing over there" earns lyrics
 * for the same reason "what's playing here" does.
 */

/**
 * Card tint. Keeps more of the cover's color than the sheet wash does
 * (DESAT 0.15 vs 0.42) so the card reads as a distinct surface sitting ON the
 * wash rather than a hole in it — but still lands dark enough that
 * LyricsView's dimmed, not-yet-sung lines stay legible in white.
 */
export function lyricsCardBg(vibrant: string | null): string {
  const m = vibrant?.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 'rgb(30 30 34)';
  let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const gray = 0.3 * r + 0.5 * g + 0.2 * b;
  const DESAT = 0.15;
  r = r * (1 - DESAT) + gray * DESAT;
  g = g * (1 - DESAT) + gray * DESAT;
  b = b * (1 - DESAT) + gray * DESAT;
  const mix = (c: number, t: number, w: number) => Math.round(c * (1 - w) + t * w);
  return `rgb(${mix(r, 18, 0.5)}, ${mix(g, 18, 0.5)}, ${mix(b, 20, 0.5)})`;
}

/** True when there's anything worth putting in a card. */
export function hasLyricsToShow(lyrics: Lyrics | null, loading?: boolean): boolean {
  return !!loading || !!(lyrics && (lyrics.synced || lyrics.plain || lyrics.instrumental));
}

/**
 * The few lines shown on the card — a taste, not the lyrics. Renders a fixed
 * window starting at whatever is being sung right now (or the top, before the
 * first timestamp), so the card stays in step with the song without ever
 * becoming something you scroll. The parent clips and fades it.
 */
function LyricsPreview({
  lyrics,
  currentTime,
  loading,
}: {
  lyrics: Lyrics | null;
  currentTime: number;
  loading?: boolean;
}) {
  const synced = useMemo(
    () => (lyrics?.synced ? parseLrc(lyrics.synced) : []),
    [lyrics?.synced],
  );
  const plain = useMemo(
    () =>
      (lyrics?.plain ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    [lyrics?.plain],
  );
  const activeIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].t <= currentTime + 0.25) idx = i;
      else break;
    }
    return idx;
  }, [synced, currentTime]);

  if (loading) return <p className="text-sm text-white/60">Loading lyrics…</p>;
  if (lyrics?.instrumental && synced.length === 0 && plain.length === 0)
    return <p className="text-sm text-white/60">♪ Instrumental</p>;

  // WINDOW is generous: the clip decides what actually shows, and long lines
  // wrap, so erring high just means the mask has something to fade.
  const WINDOW = 5;
  const shown =
    synced.length > 0
      ? synced
          .slice(Math.max(0, activeIdx), Math.max(0, activeIdx) + WINDOW)
          .map((l) => l.text || '♪')
      : plain.slice(0, WINDOW);

  return (
    <div className="space-y-2">
      {shown.map((line, i) => (
        <p
          key={i}
          className={cn(
            'text-xl font-bold leading-snug',
            // Only the synced view has a "now" to point at; unsynced lyrics get
            // an even weight rather than a highlight that would be a guess.
            synced.length > 0 && i === 0 && activeIdx >= 0
              ? 'text-white'
              : 'text-white/55',
          )}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * The card itself: header row (title left, toggle button right), a clipped
 * preview, and the button that opens the full reader.
 *
 * The caller owns the scrolling — it places this last in a scroll container
 * whose player pane is sized to leave exactly the header row peeking.
 */
export function LyricsCard({
  lyrics,
  currentTime,
  loading,
  bg,
  atLyrics,
  onToggle,
  onShowFull,
  cardRef,
}: {
  lyrics: Lyrics | null;
  currentTime: number;
  loading?: boolean;
  /** lyricsCardBg(accent) — passed in so the caller controls the palette. */
  bg: string;
  /** Whether the sheet is currently scrolled down to this card. */
  atLyrics: boolean;
  /** Scroll to the card, or back up if already there. */
  onToggle: () => void;
  onShowFull: () => void;
  cardRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      ref={cardRef}
      aria-label="Lyrics"
      className="mt-6 rounded-2xl px-5 pt-4 pb-5 ring-1 ring-white/10 shadow-2xl shadow-black/40"
      style={{ background: bg }}
    >
      {/* Header row: title left, button right. Both sit inside the sliver that
          peeks above the fold, so the button is reachable without scrolling —
          and once you HAVE scrolled, it is still right there to send you back. */}
      <div className="shrink-0 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/90">Lyrics</h3>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Lyrics"
          aria-pressed={atLyrics}
          title="Lyrics"
          className={cn(
            // -mr-3 pulls the 44px target out by the glyph's 12px inset so the
            // ICON's right edge sits on the card's padding line, level with
            // where "Lyrics" starts. -my-3 does the same vertically: without
            // it the button's 44px height sets the row height and both the
            // title and the glyph centre 12px inside it, reading as a fat gap
            // under the card's top edge.
            'h-11 w-11 -mr-3 -my-3 shrink-0 grid place-items-center rounded-full active:bg-white/20',
            atLyrics
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z" />
            <path d="M7.066 4.76A1.665 1.665 0 0 0 4 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112zm4 0A1.665 1.665 0 0 0 8 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112z" />
          </svg>
        </button>
      </div>
      {/* Fixed height + overflow-hidden: no second scroller inside the sheet's,
          so a drag here always moves the sheet. The mask fades the cut-off line
          rather than guillotining it. */}
      <div
        className="mt-3 h-40 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to bottom, black 62%, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 62%, transparent)',
        }}
      >
        <LyricsPreview lyrics={lyrics} currentTime={currentTime} loading={loading} />
      </div>
      <button
        type="button"
        onClick={onShowFull}
        className="mt-3 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 active:opacity-80"
      >
        Show lyrics
      </button>
    </section>
  );
}

/**
 * Lyrics, full screen — where reading them actually happens. Karaoke highlight,
 * auto-follow and (when the caller can seek) tap-a-line-to-seek, on the cover's
 * own tint so it reads as the same song rather than a separate app.
 */
export function FullLyricsScreen({
  title,
  artists,
  lyrics,
  currentTime,
  loading,
  onSeekTo,
  bg,
  onClose,
}: {
  title: string;
  artists: string[];
  lyrics: Lyrics | null;
  currentTime: number;
  loading?: boolean;
  onSeekTo?: (seconds: number) => void;
  bg: string;
  onClose: () => void;
}) {
  useEffect(() => {
    // Capture phase + stopPropagation: close THIS before the Now Playing sheet
    // underneath sees the key and dismisses itself too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col text-white"
      style={{
        background: bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Lyrics"
    >
      <div className="shrink-0 px-5 pt-3 pb-2 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold truncate">{title}</h2>
          <p className="text-sm text-white/70 truncate">{artists.join(', ')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lyrics"
          className="h-11 w-11 -mr-3 shrink-0 grid place-items-center rounded-full text-white/80 active:bg-white/20"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 px-5 pb-3">
        <LyricsView
          lyrics={lyrics}
          currentTime={currentTime}
          loading={loading}
          onSeekTo={onSeekTo}
        />
      </div>
    </div>,
    document.body,
  );
}
