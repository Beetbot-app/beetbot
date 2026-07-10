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
 * NowPlayingView.) Frosted glass to match the chrome; `pt-14` clears the
 * overlaid top bar.
 */
export function RightBar({ floating = false }: { floating?: boolean }) {
  const tab = useUiStore((s) => (s.rightBar === 'queue' ? 'queue' : 'lyrics'));
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
    <aside
      className={`w-[22rem] max-w-[34vw] shrink-0 h-full flex flex-col bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 ${
        // Floating card sits below the header → small inner inset; legacy
        // overlaps the absolute header → clear it (pt-14).
        floating
          ? 'rounded-2xl border border-white/10 overflow-hidden pt-3'
          : 'border-l border-white/5 pt-14'
      }`}
    >
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
    </aside>
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
