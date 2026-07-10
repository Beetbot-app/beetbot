import { useEffect, useMemo, useRef } from 'react';
import { parseLrc, type Lyrics } from '../api';

interface Props {
  lyrics: Lyrics | null;
  /** Current playhead, seconds. Drives the synced highlight + auto-scroll. */
  currentTime: number;
  loading?: boolean;
  /** When set, a synced line is tappable to seek there (Spotify-style). */
  onSeekTo?: (seconds: number) => void;
  /** Smaller type for tighter containers (the desktop panel). */
  compact?: boolean;
}

/**
 * Lyrics panel. Shows synced (LRC) lyrics karaoke-style — the current line is
 * highlighted and auto-scrolled to the middle, driven by the player's
 * position — and falls back to plain lyrics, an "instrumental" note, or a
 * "not available" message. The parent supplies the height; this fills it.
 */
export function LyricsView({
  lyrics,
  currentTime,
  loading,
  onSeekTo,
  compact,
}: Props) {
  const lines = useMemo(
    () => (lyrics?.synced ? parseLrc(lyrics.synced) : []),
    [lyrics?.synced],
  );

  const activeIdx = useMemo(() => {
    if (lines.length === 0) return -1;
    let idx = -1;
    // Small lead so the line flips a hair early (matches how it reads).
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= currentTime + 0.25) idx = i;
      else break;
    }
    return idx;
  }, [lines, currentTime]);

  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  // On a track change (new lyrics), jump the panel back to the top so it never
  // inherits the previous song's scroll position. Keyed on the lyrics content
  // (stable within a song) so it fires once per song, not on every tick; the
  // synced auto-scroll above then follows playback from the first line.
  // Declared after the active-line effect so, on the render where both fire,
  // this reset wins and the new song starts at the top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [lyrics?.synced, lyrics?.plain]);

  if (loading) {
    return (
      <div className="grid place-items-center h-full text-sm text-neutral-500">
        Loading lyrics…
      </div>
    );
  }

  if (!lyrics || (!lyrics.synced && !lyrics.plain)) {
    return (
      <div className="grid place-items-center h-full text-sm text-neutral-500">
        {lyrics?.instrumental ? '♪ Instrumental' : 'Lyrics not available'}
      </div>
    );
  }

  if (lines.length > 0) {
    return (
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto overscroll-contain px-1 py-[42%] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        // Fade lines out toward the top/bottom edges (Apple/Spotify "live
        // lyrics" look) so the active line near the middle is the focus.
        style={{
          maskImage:
            'linear-gradient(to bottom, transparent, black 16%, black 84%, transparent)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent, black 16%, black 84%, transparent)',
        }}
      >
        {lines.map((l, i) => {
          const active = i === activeIdx;
          return (
            <button
              key={`${l.t}-${i}`}
              type="button"
              ref={active ? activeRef : undefined}
              onClick={onSeekTo ? () => onSeekTo(l.t) : undefined}
              className={`block w-full text-left font-bold leading-snug py-2 origin-left transition duration-300 ${
                compact ? 'text-lg' : 'text-3xl'
              } ${
                active
                  ? 'text-white scale-[1.03]'
                  : 'text-white/40 hover:text-white/70'
              } ${onSeekTo ? 'cursor-pointer' : 'cursor-default'}`}
            >
              {l.text || '♪'}
            </button>
          );
        })}
      </div>
    );
  }

  // Plain (unsynced) fallback — same per-line rhythm and size as the synced view
  // (just no karaoke highlight, since there are no timestamps to follow). Each
  // line is its own element so it gets the same py-2 breathing room as a synced
  // line, instead of one cramped pre-wrap block. Blank lines are dropped so the
  // rhythm stays uniform like the synced view.
  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto overscroll-contain px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    >
      {(lyrics.plain ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => (
          <p
            key={i}
            className={`text-left font-bold leading-snug py-2 text-white/85 ${
              compact ? 'text-lg' : 'text-3xl'
            }`}
          >
            {line}
          </p>
        ))}
    </div>
  );
}
