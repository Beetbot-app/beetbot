import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { useUiStore } from '@/lib/ui';
import { useLyrics } from '@/lib/useLyrics';
import { LyricsView } from '@shared/components/LyricsView';
import type { PlaylistTrack } from '@/lib/tauri';

/**
 * Docked right bar — the quick, non-fullscreen surface. Opened by the player
 * bar's lyrics / queue buttons; shows the synced lyrics or the up-next queue
 * while the rest of the app stays put. (The fullscreen takeover lives in
 * NowPlayingView.) Frosted glass to match the chrome.
 *
 * Open/close animates like the left sidebar: the panel's WIDTH transitions
 * (so `main` smoothly gives/reclaims room) while a fixed-width content column
 * stays pinned to the RIGHT and gets clipped — the mirror of the sidebar's
 * left-pinned collapse. Always mounted here (App renders it unconditionally);
 * it self-manages an enter/exit so the close slide can finish before it
 * unmounts (which also keeps it out of the flex `gap` when fully closed).
 */
export function RightBar({ floating = false }: { floating?: boolean }) {
  const rightBar = useUiStore((s) => s.rightBar);
  const open = rightBar !== 'closed';
  const tab: 'lyrics' | 'queue' = rightBar === 'queue' ? 'queue' : 'lyrics';
  // Freeze the tab while closing so a queue→closed slide doesn't flash to
  // Lyrics for the 200ms it's still on screen.
  const tabRef = useRef<'lyrics' | 'queue'>(tab);
  if (open) tabRef.current = tab;

  // `mounted` = node present (kept alive through the exit slide); `shown` =
  // at full width (drives the width class). Enter: mount at w-0, then flip to
  // full on the next frame so the transition actually runs. Exit: collapse to
  // w-0, then unmount after the transition.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  return (
    <aside
      aria-hidden={!open}
      className={`${
        shown ? 'w-[22rem] max-w-[34vw]' : 'w-0'
      } shrink-0 h-full overflow-hidden flex flex-col items-end bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 transition-[width] duration-200 ${
        // Border/rounding only while it has width, so a w-0 frame never shows a
        // 1px sliver. Floating = a card; legacy = a left divider.
        shown
          ? floating
            ? 'rounded-2xl border border-white/10'
            : 'border-l border-white/5'
          : ''
      }`}
    >
      {/* Fixed-width content column, pinned RIGHT (items-end above): as the
          aside's width animates, this stays put and the empty space collapses
          on the LEFT — the mirror of the sidebar's left-pinned collapse. */}
      <div
        className={`w-[22rem] max-w-[34vw] flex-1 min-h-0 flex flex-col ${
          floating ? 'pt-3' : 'pt-14'
        }`}
      >
        <RightBarPanel tab={tabRef.current} />
      </div>
    </aside>
  );
}

/** The panel body. Split out so its data hooks (lyrics fetch, queue selectors,
 *  the per-tick currentTime re-render) only run while the bar is mounted. */
function RightBarPanel({ tab }: { tab: 'lyrics' | 'queue' }) {
  const setTab = useUiStore((s) => s.setRightBar);
  const close = useUiStore((s) => s.closeRightBar);

  const { lyrics, loading } = useLyrics();
  const track = usePlayerStore(currentTrack);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);

  const upNext = queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => i > currentIndex);

  return (
    <>
      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between border-b border-white/5">
        <div className="flex items-center gap-1">
          <TabBtn active={tab === 'lyrics'} onClick={() => setTab('lyrics')}>
            Lyrics
          </TabBtn>
          <TabBtn active={tab === 'queue'} onClick={() => setTab('queue')}>
            Up next
          </TabBtn>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          title="Close"
          className="h-8 w-8 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 px-3 py-2 overflow-hidden">
        {tab === 'lyrics' ? (
          <LyricsView
            lyrics={lyrics}
            currentTime={currentTime}
            loading={loading}
            onSeekTo={(s) => setCurrentTime(s)}
            compact
          />
        ) : (
          <div className="h-full overflow-y-auto overscroll-contain">
            {!track ? (
              <div className="px-2 py-4 text-sm text-neutral-500">
                Nothing playing.
              </div>
            ) : upNext.length === 0 ? (
              <div className="px-2 py-4 text-sm text-neutral-500">
                Nothing up next.
              </div>
            ) : (
              upNext.map(({ t, i }) => (
                <QueueRow
                  key={`${t.id}-${i}`}
                  t={t}
                  onPlay={() => playAt(i)}
                  onRemove={() => removeFromQueue(i)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm transition ${
        active
          ? 'bg-white/10 text-neutral-100'
          : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
}

function QueueRow({
  t,
  onPlay,
  onRemove,
}: {
  t: PlaylistTrack;
  onPlay: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5">
      <button
        type="button"
        onClick={onPlay}
        className="flex items-center gap-3 flex-1 min-w-0 text-left"
      >
        <div className="h-10 w-10 shrink-0 rounded bg-neutral-800 overflow-hidden grid place-items-center">
          {t.album_art_url ? (
            <img
              src={t.album_art_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-neutral-100 truncate">{t.title}</div>
          <div className="text-xs text-neutral-500 truncate">
            {t.artists.join(', ') || '—'}
          </div>
        </div>
      </button>
      <span className="text-[11px] text-neutral-600 tabular-nums shrink-0">
        {formatDuration(t.duration_ms)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove from queue"
        className="opacity-0 group-hover:opacity-100 transition h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
