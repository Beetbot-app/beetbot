import { useCallback, useEffect, useState } from 'react';
import {
  evictAllAudio,
  evictTrack,
  getCachedTrackIds,
  getStorageEstimate,
  listLibrarySongs,
  setOfflinePlaylistIds,
  type StreamTrack,
} from '@shared/api';
import { cn, EYEBROW_ON_ART } from '@shared/ui';
import { STICKY_FROST } from '@shared/components/PhoneTopBar';
import { SwipeRow } from '@shared/components/SwipeRow';
import { usePlayerStore } from '../store';

/**
 * "Saved on this device" — the songs whose audio lives in this phone's cache,
 * built like every other collection in the app: cover, title, count, then the
 * canonical shuffle · play row, then the tracks. Reached from Settings ›
 * Storage. It earns that treatment because it *is* a collection — one you can
 * play start to finish on a plane.
 *
 * Removal lives here, next to the songs it removes, at two scales: swipe a row
 * left to drop one track, or "Remove all" under the ⋯ actions. Both confirm
 * before deleting, because a download can cost real time and data to replace
 * and a swipe is easy to make by accident.
 *
 * The set is derived, never stored: cached ids come from Cache Storage itself
 * and are matched against the library, so this list cannot drift from what is
 * really on the device.
 */
export function OfflineSongsScreen({
  token,
  profileId,
  onBack,
}: {
  token: string;
  profileId: number | null;
  onBack: () => void;
}) {
  const [songs, setSongs] = useState<StreamTrack[] | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row a left-swipe armed: it swaps to a confirm strip until answered. */
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const shuffleOn = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const load = useCallback(async () => {
    const [ids, est, rows] = await Promise.all([
      getCachedTrackIds(),
      getStorageEstimate(),
      listLibrarySongs(token, profileId).catch(() => [] as StreamTrack[]),
    ]);
    setSongs(rows.filter((t) => ids.has(t.id)));
    setUsage(est ? est.usage : null);
  }, [token, profileId]);
  useEffect(() => {
    void load();
  }, [load]);

  const removeOne = async (id: number) => {
    setPendingId(null);
    setBusy(true);
    try {
      await evictTrack(id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    setBusy(true);
    try {
      await evictAllAudio();
      setOfflinePlaylistIds(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Playing from here queues only what is on the device — the whole point of
  // the collection is that it works with no connection.
  const playFrom = (song: StreamTrack) => {
    const list = songs ?? [];
    const idx = list.findIndex((t) => t.id === song.id);
    if (idx >= 0) setQueue(list, idx);
  };
  const playAll = () => {
    if (songs && songs.length > 0) setQueue(songs, 0);
  };
  const shufflePlay = () => {
    if (!songs || songs.length === 0) return;
    if (!shuffleOn) toggleShuffle();
    setQueue(songs, Math.floor(Math.random() * songs.length));
  };

  const count = songs?.length ?? 0;
  const empty = songs !== null && count === 0;

  return (
    <div className="pb-6">
      <div className={cn(STICKY_FROST, 'sticky top-0 z-20 border-b border-white/5')}>
        <div className="flex items-center gap-1 px-2 pt-4 pb-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="h-9 w-9 grid place-items-center rounded-full text-neutral-300 active:bg-white/10"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <span className="min-w-0 truncate text-sm font-medium text-neutral-300">
            Storage
          </span>
        </div>
      </div>

      {/* Hero — the same shape as a playlist: cover, eyebrow, title, meta,
          then the canonical shuffle · play pair. */}
      <div className="flex flex-col items-center px-4 pt-5">
        <div className="h-40 w-40 overflow-hidden rounded-xl bg-neutral-900 shadow-lg ring-1 ring-white/5">
          <CoverMosaic songs={songs} />
        </div>
        <p className={cn(EYEBROW_ON_ART, 'mt-4 mb-1')}>On this device</p>
        <h1 className="text-2xl font-bold tracking-tight text-center">
          Saved offline
        </h1>
        <p className="mt-1 text-xs text-neutral-400">
          {songs === null
            ? 'Counting…'
            : empty
              ? 'Nothing saved yet'
              : `${count} ${count === 1 ? 'song' : 'songs'}${usage != null ? ` · ${formatBytes(usage)}` : ''}`}
        </p>
        <p className="mt-1 max-w-xs text-center text-xs text-neutral-500">
          These play with no connection — your computer can be off.
        </p>

        {!empty && (
          <div className="mt-4 flex items-center justify-center gap-4">
            <button
              type="button"
              disabled={count === 0 || busy}
              onClick={shufflePlay}
              aria-label="Shuffle play"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="m15 15 6 6" />
                <path d="M4 4l5 5" />
              </svg>
            </button>
            <button
              type="button"
              disabled={count === 0 || busy}
              onClick={playAll}
              aria-label="Play"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <button
              type="button"
              disabled={count === 0 || busy}
              onClick={() => void removeAll()}
              aria-label="Remove all from this device"
              className={cn(
                'grid h-10 w-10 place-items-center rounded-full active:bg-white/20 disabled:opacity-40',
                clearArmed ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-neutral-200',
              )}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M19 6l-1 14H6L5 6" />
              </svg>
            </button>
          </div>
        )}
        {clearArmed && (
          <p className="mt-2 text-xs text-red-400">
            Tap again to remove all {count} songs from this device.
          </p>
        )}
      </div>

      {/* Tracks. Swipe a row left to remove just that one. */}
      <ul className="mt-6 flex flex-col px-2">
        {songs === null
          ? Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-2 py-2 animate-pulse" aria-hidden>
                <div className="h-12 w-12 shrink-0 rounded bg-neutral-900" />
                <div className="flex-1">
                  <div className="h-3 w-1/2 rounded bg-neutral-900" />
                  <div className="mt-1.5 h-2.5 w-1/3 rounded bg-neutral-900" />
                </div>
              </li>
            ))
          : songs.map((t) =>
              pendingId === t.id ? (
                // The armed row: the swipe asked, this answers. Inline rather
                // than a dialog so the track you swiped stays in front of you.
                <li
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg bg-red-500/10 px-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-100">
                      Remove “{t.title}”?
                    </p>
                    <p className="truncate text-xs text-neutral-400">
                      It stays in your library — you can download it again.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingId(null)}
                    className="shrink-0 rounded-full px-3 py-1.5 text-sm text-neutral-300 active:bg-white/10"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeOne(t.id)}
                    className="shrink-0 rounded-full bg-red-500/20 px-3 py-1.5 text-sm font-medium text-red-300 active:bg-red-500/30"
                  >
                    Remove
                  </button>
                </li>
              ) : (
                <li key={t.id}>
                  <SwipeRow
                    onSwipeLeft={() => setPendingId(t.id)}
                    leftAction={{ label: 'Remove', bg: 'bg-red-500/80' }}
                  >
                    <button
                      type="button"
                      onClick={() => playFrom(t)}
                      className="flex w-full items-center gap-3 px-2 py-2 text-left active:bg-white/5"
                    >
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-neutral-900 grid place-items-center">
                        {t.album_art_url ? (
                          <img src={t.album_art_url} alt="" className="h-full w-full object-cover" draggable={false} />
                        ) : (
                          <span className="text-xs text-neutral-600">♪</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{t.title}</div>
                        <div className="truncate text-xs text-neutral-500">
                          {t.artists.join(', ') || '—'}
                        </div>
                      </div>
                    </button>
                  </SwipeRow>
                </li>
              ),
            )}
      </ul>

      {empty && (
        <p className="px-8 py-10 text-center text-sm text-neutral-500">
          Make a playlist available offline and its songs show up here.
        </p>
      )}
    </div>
  );
}

/** Cover for the collection: a 2×2 of the first four tracks' art, the same
 *  shape the library uses for playlists — so this reads as a collection at a
 *  glance rather than a settings page. One track shows its art full-bleed. */
function CoverMosaic({ songs }: { songs: StreamTrack[] | null }) {
  const art = (songs ?? []).map((t) => t.album_art_url).filter(Boolean).slice(0, 4) as string[];
  if (art.length === 0) {
    return (
      <div className="grid h-full w-full place-items-center text-neutral-700">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </div>
    );
  }
  if (art.length < 4) {
    return <img src={art[0]} alt="" className="h-full w-full object-cover" draggable={false} />;
  }
  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2">
      {art.map((src, i) => (
        <img key={i} src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
