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
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the active line centered. The FIRST placement for a given song snaps
  // there INSTANTLY, everything after follows playback smoothly. "First" covers
  // both cases that used to land you at the top: opening the panel while a song
  // is already mid-playback, and a new track's lyrics loading in. Without the
  // instant snap, opening the lyrics sat at the top until the next line was
  // reached (the old reset-to-top ran on mount and overrode the auto-scroll).
  // No active line yet (playhead before the first timestamp) → sit at the top,
  // which also gives a fresh track its top-of-lyrics start.
  const lyricsKey = lyrics?.synced ?? lyrics?.plain ?? null;
  const placedFor = useRef<string | null>(null);
  useEffect(() => {
    const firstPlacement = placedFor.current !== lyricsKey;
    placedFor.current = lyricsKey;
    const line = activeRef.current;
    const box = scrollRef.current;
    if (line && box) {
      // Scroll THIS box only. scrollIntoView() would centre the line in every
      // ancestor scroller too — which on the phone means every new lyric line
      // drags the whole Now Playing sheet down to the lyrics card, whether or
      // not you were looking at it.
      const delta = line.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const top = box.scrollTop + delta - (box.clientHeight - line.offsetHeight) / 2;
      box.scrollTo({ top, behavior: firstPlacement ? 'auto' : 'smooth' });
    } else if (firstPlacement && box) {
      box.scrollTop = 0;
    }
  }, [activeIdx, lyricsKey]);

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
        // overflow-x-hidden is load-bearing: `overflow-y-auto` alone leaves the
        // x-axis computing to auto, and the active line's scale-[1.03] from
        // origin-left overhangs the right edge — so lyrics could be dragged
        // sideways. pr-3 gives that 3% somewhere to grow into, so the clip
        // lands on empty padding rather than on the last glyph of a full line.
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain pl-1 pr-3 py-[24%] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
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
      className="h-full overflow-y-auto overflow-x-hidden overscroll-contain pl-1 pr-3 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
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
