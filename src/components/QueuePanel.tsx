import { useEffect, useMemo, useState } from 'react';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { upcomingQueueIndices } from '@shared/playerStore';
import type { PlaylistTrack } from '@/lib/tauri';

const QUEUE_ROW_H = 60; // px; fixed so the pointer-drag math is exact.

/**
 * The desktop queue view — "Now playing" + Autoplay, then a drag-reorderable
 * "Up next".
 *
 * ONE implementation, shared by the fullscreen NowPlayingView and the docked
 * RightBar. They used to render the queue separately and had drifted badly: the
 * RightBar showed no now-playing row, no Autoplay, no reorder, and a duration
 * column the fullscreen didn't have. Same queue, two looks. Keep it here.
 *
 * Reads the player store directly, so a host just renders `<QueuePanel />` —
 * there's no wiring to get out of sync either.
 */
export function QueuePanel({ className = '' }: { className?: string }) {
  const track = usePlayerStore(currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  const jumpTo = usePlayerStore((s) => s.jumpTo);
  const removeAt = usePlayerStore((s) => s.removeAt);
  const playNext = usePlayerStore((s) => s.playNext);
  const moveItem = usePlayerStore((s) => s.moveItem);
  const movePlanItem = usePlayerStore((s) => s.movePlanItem);
  const clearUpcoming = usePlayerStore((s) => s.clearUpcoming);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const plan = usePlayerStore((s) => s.shuffleUpcomingIds);

  // Pointer drag-reorder of the up-next list — the phone's approach, robust in
  // the WKWebView (native HTML5 drag-and-drop is flaky there). `drag` holds the
  // grabbed DISPLAY position + the pointer's start/current Y. (Display
  // position, not queue index: under shuffle the list shows PLAN order, so
  // positions and queue indices no longer coincide.)
  const [drag, setDrag] = useState<{ fromPos: number; startY: number; y: number } | null>(null);

  // Up next in TRUE play order — sequential tail, or the shuffle plan.
  const upNext = useMemo(
    () =>
      upcomingQueueIndices(queue, currentIndex, shuffle, plan).map((i) => ({
        t: queue[i],
        i,
      })),
    [queue, currentIndex, shuffle, plan],
  );

  // Abort an in-progress drag if playback advances (or shuffle toggles) under
  // it — the grabbed display position would point at a different track.
  useEffect(() => setDrag(null), [currentIndex, shuffle]);
  // Where the dragged row would drop, clamped to the list.
  const dropPos =
    drag != null
      ? Math.max(
          0,
          Math.min(
            upNext.length - 1,
            drag.fromPos + Math.round((drag.y - drag.startY) / QUEUE_ROW_H),
          ),
        )
      : -1;
  // Shift a non-dragged row to open a gap at the drop position.
  const rowShift = (pos: number): number => {
    if (drag == null) return 0;
    if (dropPos > drag.fromPos && pos > drag.fromPos && pos <= dropPos) return -QUEUE_ROW_H;
    if (dropPos < drag.fromPos && pos < drag.fromPos && pos >= dropPos) return QUEUE_ROW_H;
    return 0;
  };
  const endDrag = (commit: boolean) => {
    if (drag != null && commit && dropPos !== drag.fromPos) {
      if (shuffle) {
        // The plan IS the play order under shuffle — reorder it directly.
        movePlanItem(drag.fromPos, dropPos);
      } else {
        // Sequential display is the contiguous queue tail, so display
        // positions map 1:1 onto queue indices.
        moveItem(currentIndex + 1 + drag.fromPos, currentIndex + 1 + dropPos);
      }
    }
    setDrag(null);
  };

  const scroller = `h-full overflow-y-auto overscroll-contain ${className}`;

  if (!track) {
    return (
      <div className={scroller}>
        <div className="px-2 py-4 text-sm text-neutral-500">Nothing playing.</div>
      </div>
    );
  }

  return (
    <div className={scroller}>
      <div className="flex items-center justify-between px-2 pt-1 pb-1">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Now playing</span>
        <button
          type="button"
          onClick={() => setAutoplay(!autoplay)}
          title="Autoplay similar songs when the queue ends"
          aria-pressed={autoplay}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition ${
            autoplay ? 'bg-white/10 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
          }`}
        >
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8" />
          </svg>
          Autoplay
        </button>
      </div>
      <QueueRow t={track} isCurrent playing={isPlaying} onPlay={() => {}} />
      <div className="flex items-center justify-between px-2 pt-4 pb-1">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Up next</span>
        {upNext.length > 0 ? (
          <button type="button" onClick={clearUpcoming} className="text-xs text-neutral-400 hover:text-neutral-200">
            Clear
          </button>
        ) : null}
      </div>
      {upNext.length === 0 ? (
        <div className="text-sm text-neutral-500 px-2 py-4">Nothing up next.</div>
      ) : (
        upNext.map(({ t, i }, pos) => {
          const dragging = drag?.fromPos === pos;
          return (
            <QueueRow
              key={`${i}:${t.id}`}
              t={t}
              onPlay={() => jumpTo(i)}
              onPlayNext={() => playNext(i)}
              onRemove={() => removeAt(i)}
              dragging={dragging}
              translate={dragging ? drag.y - drag.startY : rowShift(pos)}
              gripProps={{
                onPointerDown: (e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ fromPos: pos, startY: e.clientY, y: e.clientY });
                },
                onPointerMove: (e) => setDrag((d) => (d ? { ...d, y: e.clientY } : d)),
                onPointerUp: () => endDrag(true),
                onPointerCancel: () => endDrag(false),
              }}
            />
          );
        })
      )}
    </div>
  );
}

function QueueRow({
  t,
  isCurrent = false,
  playing = false,
  onPlay,
  onPlayNext,
  onRemove,
  dragging = false,
  translate = 0,
  gripProps,
}: {
  t: PlaylistTrack;
  isCurrent?: boolean;
  playing?: boolean;
  onPlay: () => void;
  onPlayNext?: () => void;
  onRemove?: () => void;
  dragging?: boolean;
  translate?: number;
  gripProps?: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
}) {
  return (
    <div
      className={`group flex items-center gap-3 px-2 rounded-lg ${
        isCurrent ? '' : 'hover:bg-white/5'
      } ${dragging ? 'bg-white/10 shadow-xl shadow-black/50' : ''}`}
      style={{
        height: QUEUE_ROW_H,
        transform: translate ? `translateY(${translate}px)` : undefined,
        transition: dragging ? 'none' : 'transform 180ms ease',
        zIndex: dragging ? 10 : undefined,
        position: 'relative',
        ...(isCurrent && !dragging
          ? {
              // The now-playing row takes a faint artwork-accent wash + hairline
              // ring instead of a flat white highlight (title/EQ are already tinted).
              backgroundColor:
                'color-mix(in srgb, var(--color-accent) 12%, transparent)',
              boxShadow:
                'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 18%, transparent)',
            }
          : {}),
      }}
    >
      <button type="button" onClick={onPlay} disabled={isCurrent} className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-default">
        <div className="h-11 w-11 shrink-0 rounded-lg bg-neutral-800 overflow-hidden grid place-items-center">
          {t.album_art_url ? (
            <img src={t.album_art_url} alt="" className="h-full w-full object-cover" draggable={false} loading="lazy" />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
        </div>
        <div className="min-w-0">
          <div className={`text-sm truncate ${isCurrent ? 'text-accent' : 'text-neutral-100'}`}>{t.title}</div>
          <div className="text-xs text-neutral-500 truncate">{t.artists.join(', ') || '—'}</div>
        </div>
      </button>
      {isCurrent ? (
        <span className="text-accent shrink-0 pr-1">
          <EqualizerBars playing={playing} />
        </span>
      ) : (
        <div className="flex items-center gap-0.5 shrink-0">
          <button type="button" onClick={onPlayNext} aria-label="Play next" title="Play next" className="h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 opacity-0 group-hover:opacity-100 transition">
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 6l8 6-8 6zM18 5v14" />
            </svg>
          </button>
          <button type="button" onClick={onRemove} aria-label="Remove from queue" title="Remove" className="h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 opacity-0 group-hover:opacity-100 transition">
            ✕
          </button>
          {/* Drag handle — press and drag to reorder. Pointer capture keeps the
              move/up events here even when the cursor leaves it. */}
          <button
            type="button"
            aria-label="Reorder"
            title="Drag to reorder"
            className="h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 touch-none cursor-grab active:cursor-grabbing"
            {...gripProps}
          >
            <svg width={17} height={17} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
              <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
              <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
