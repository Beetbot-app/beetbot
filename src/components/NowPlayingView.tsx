import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { useNavStore } from '@/lib/nav';
import { useUiStore } from '@/lib/ui';
import { useProfileStore } from '@/lib/profile';
import { useAddAudio } from '@/lib/addAudio';
import { useDownloadsStore, trackHasFile } from '@/lib/downloads';
import { useCapabilitiesStore } from '@/lib/capabilities';
import { useLikesStore } from '@/lib/likes';
import { extractDominantColor } from '@shared/albumColor';
import { LyricsView } from '@shared/components/LyricsView';
import { LikeButton } from '@shared/components/LikeButton';
import {
  ContextMenu,
  MenuGlyphs,
  fileMenuItems,
  sleepTimerMenuItems,
  sleepTimerMenuLabel,
  type MenuState,
} from '@shared/components/ContextMenu';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { playlistTrackToSearch } from '@/lib/trackAdapter';
import { ensureSession, getTrackPlaylistIds, type SearchTrackResult } from '@shared/api';
import { useLyrics } from '@/lib/useLyrics';
import { QueuePanel } from '@/components/QueuePanel';
import { LyricsIcon, QueueIcon } from '@/components/PlayerIcons';

/**
 * Full-area "Now Playing" — Apple Music-style. Fills the main content area
 * (the left sidebar + top bar stay), with the big cover + transport on the
 * left and a Lyrics / Up Next switch on the right, over an artwork-derived
 * wash. The star is a one-tap Favorite toggle; the ⋯ opens add-to-playlist /
 * go-to / share. Seeking goes through the store's setCurrentTime (the player
 * bar's <audio> effect applies it).
 */
export function NowPlayingView() {
  const track = usePlayerStore(currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const buffering = usePlayerStore((s) => s.buffering);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const repeat = usePlayerStore((s) => s.repeat);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const playPause = usePlayerStore((s) => s.playPause);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const openArtist = useNavStore((s) => s.openArtist);
  const openAlbum = useNavStore((s) => s.openAlbum);
  const tab = useUiStore((s) => s.nowPlayingTab);
  const setTab = useUiStore((s) => s.setNowPlayingTab);
  const close = useUiStore((s) => s.closeFullNowPlaying);

  // ---- Liked Songs (shared with the player bar) ----
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const likedIds = useLikesStore((s) => s.likedIds);
  const toggleLike = useLikesStore((s) => s.toggle);
  const refreshLikes = useLikesStore((s) => s.refresh);
  useEffect(() => {
    void refreshLikes(activeProfileId);
  }, [activeProfileId, refreshLikes]);
  const trackLiked = track ? likedIds.has(track.id) : false;

  // ⋯ menu + the surfaces it opens. `sleepMenu` is the duration picker the
  // menu's "Sleep timer" row opens — separate state so the first menu's
  // onClose (which fires right after the row's onClick) can't wipe it.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sleepMenu, setSleepMenu] = useState<MenuState | null>(null);
  const [addToPlaylist, setAddToPlaylist] = useState<{
    track: SearchTrackResult;
    token: string;
  } | null>(null);

  // Keep the Lyrics / Up-next pane the same height as the player column (album
  // art → volume) so they read as one block and the corner toggles sit clear
  // below both. A callback ref + ResizeObserver tracks the column's live height.
  const roRef = useRef<ResizeObserver | null>(null);
  const [playerH, setPlayerH] = useState(0);
  const playerColRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    const measure = () => setPlayerH(el.offsetHeight);
    measure();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(el);
  }, []);

  // Apple Music model: open collapsed (big centered artwork), then a corner
  // toggle slides in the Lyrics / Up-next pane. Local so every open starts
  // collapsed; `tab` (in the UI store) remembers which pane you last used.
  const [paneOpen, setPaneOpen] = useState(false);
  const togglePane = useCallback(
    (which: 'lyrics' | 'queue') => {
      setPaneOpen((open) => !(open && tab === which));
      setTab(which);
    },
    [tab, setTab],
  );
  // Keep the pane's CONTENT mounted through its close animation so it fades out
  // with the collapsing panel instead of vanishing the instant you toggle it
  // shut (the width still animates to 0 either way; this just keeps something in
  // it to see). Matches the 300ms width/opacity transition below.
  const [paneMounted, setPaneMounted] = useState(false);
  useEffect(() => {
    if (paneOpen) {
      setPaneMounted(true);
      return;
    }
    const t = window.setTimeout(() => setPaneMounted(false), 320);
    return () => window.clearTimeout(t);
  }, [paneOpen]);

  // Navigating to an artist/album leaves the now-playing surface (matches Apple
  // Music) — otherwise the full view would just cover the page you opened.
  const goArtist = useCallback(
    (a: string) => {
      close();
      openArtist(a);
    },
    [close, openArtist],
  );
  const goAlbum = useCallback(() => {
    if (!track?.album) return;
    close();
    openAlbum(track.album, track.artists[0] ?? null);
  }, [close, openAlbum, track]);

  const openAddToPlaylist = useCallback(() => {
    if (!track) return;
    const t = track;
    void ensureSession().then((tok) =>
      getTrackPlaylistIds(t.id, tok, activeProfileId)
        .catch(() => [] as number[])
        .then((inIds) => {
          setAddToPlaylist({
            token: tok,
            track: playlistTrackToSearch(t, { inPlaylistIds: inIds }),
          });
        }),
    );
  }, [track, activeProfileId]);

  const closeAddToPlaylist = useCallback(() => {
    setAddToPlaylist(null);
    // The picker may have toggled Liked Songs — refresh the heart fill.
    void refreshLikes(activeProfileId);
  }, [refreshLikes, activeProfileId]);

  const openMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      const pid = activeProfileId; // captured for the download actions' closures
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Add to playlist',
            icon: MenuGlyphs.addToPlaylist,
            onClick: openAddToPlaylist,
          },
          {
            label: 'Go to artist',
            icon: MenuGlyphs.artist,
            onClick: () => goArtist(track.artists[0]),
            disabled: !track.artists[0],
          },
          {
            label: 'Go to album',
            icon: MenuGlyphs.album,
            onClick: goAlbum,
            disabled: !track.album,
          },
          // Save offline / remove / attach-a-file — the shared file actions, so
          // every ⋯ menu offers the same set. Save and remove appear only on a
          // build that can acquire.
          ...fileMenuItems({
            hasFile: trackHasFile(track),
            downloading:
              useDownloadsStore.getState().byTrack[track.id] !== undefined,
            canDownload: useCapabilitiesStore.getState().canDownload,
            onDownload:
              pid != null
                ? () =>
                    void useDownloadsStore.getState().download(track.id, pid)
                : undefined,
            onRemove:
              pid != null
                ? () => void useDownloadsStore.getState().remove(track.id, pid)
                : undefined,
            onAddAudio: () => useAddAudio.getState().openForTrack(track),
          }),
          {
            label: sleepTimerMenuLabel(sleepTimerEndsAt, sleepAtTrackEnd),
            icon: MenuGlyphs.sleep,
            separator: true,
            onClick: () =>
              setSleepMenu({
                x: e.clientX,
                y: e.clientY,
                items: sleepTimerMenuItems(
                  sleepTimerEndsAt,
                  sleepAtTrackEnd,
                  setSleepTimer,
                ),
              }),
          },
        ],
      });
    },
    [
      track,
      openAddToPlaylist,
      goArtist,
      goAlbum,
      sleepTimerEndsAt,
      sleepAtTrackEnd,
      setSleepTimer,
    ],
  );

  // Artwork-derived wash for an immersive, album-forward backdrop.
  const artUrl = track?.album_art_url ?? null;
  const [tint, setTint] = useState<[number, number, number] | null>(null);
  useEffect(() => {
    if (!artUrl) {
      setTint(null);
      return;
    }
    let cancelled = false;
    void extractDominantColor(artUrl).then((c) => {
      if (!cancelled) setTint(c);
    });
    return () => {
      cancelled = true;
    };
  }, [artUrl]);

  // Lyrics for the Lyrics tab (shared fetch).
  const { lyrics, loading: lyricsLoading } = useLyrics();

  const bg = tint
    ? `radial-gradient(120% 90% at 25% 10%, rgba(${tint[0]},${tint[1]},${tint[2]},0.42), rgba(${tint[0]},${tint[1]},${tint[2]},0.10) 45%, transparent 75%), #0a0a0b`
    : 'radial-gradient(120% 90% at 25% 10%, rgba(120,90,80,0.25), transparent 70%), #0a0a0b';

  const dur = duration || (track ? track.duration_ms / 1000 : 0);
  const remaining = Math.max(0, Math.round(dur - currentTime));
  const scrubPct = dur > 0 ? (Math.min(currentTime, dur) / dur) * 100 : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: bg }}
      role="dialog"
      aria-modal="true"
    >
      {/* Keep the window draggable + clear of the macOS traffic lights. */}
      <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-12" aria-hidden />
      <button
        type="button"
        onClick={close}
        aria-label="Close now playing"
        title="Close"
        className="absolute z-10 top-4 right-5 h-9 w-9 grid place-items-center rounded-full bg-black/30 text-neutral-300 hover:text-neutral-100 hover:bg-black/50 backdrop-blur-sm"
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {track ? (
        <div className="flex-1 min-h-0 flex items-center justify-center px-10 pt-14 pb-8">
          {/* Left: cover + meta + transport. Centered when collapsed; shifts
              left and shrinks when a pane opens (Apple Music). The pane is
              sized to this column's height (below), so both centre as one
              block and the corner toggles clear them. */}
          <div
            ref={playerColRef}
            className="min-w-0 flex-none flex flex-col items-center justify-center transition-all duration-300 ease-out"
            // Width animates (not mx-auto, which can't be transitioned and made
            // the artwork jump). justify-center on the parent centers this when
            // the pane is 0-width, and lets it slide left as the pane widens.
            style={{ width: paneOpen ? 300 : 'min(54vh, 440px)' }}
          >
            <button
              type="button"
              onClick={goAlbum}
              disabled={!track.album}
              className="w-full aspect-square rounded-2xl overflow-hidden bg-neutral-900 shadow-2xl disabled:cursor-default transition-all duration-300"
            >
              {track.album_art_url ? (
                <img src={track.album_art_url} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="h-full w-full grid place-items-center text-neutral-700 text-6xl">♪</div>
              )}
            </button>

            <div className="w-full mt-6">
              {/* Title + artist on the left; heart + ⋯ on the right (Apple Music). */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {track.album ? (
                    <button
                      type="button"
                      onClick={goAlbum}
                      className="block max-w-full text-2xl font-bold tracking-tight truncate text-left hover:underline"
                      title={track.title}
                    >
                      {track.title}
                    </button>
                  ) : (
                    <div className="text-2xl font-bold tracking-tight truncate">{track.title}</div>
                  )}
                  <div className="mt-1 text-base text-neutral-300 truncate">
                    {track.artists.length > 0
                      ? track.artists.map((a, i) => (
                          <span key={`${a}-${i}`}>
                            {i > 0 ? ', ' : ''}
                            <button type="button" onClick={() => goArtist(a)} className="hover:underline hover:text-neutral-100">
                              {a}
                            </button>
                          </span>
                        ))
                      : '—'}
                    {track.album ? <span className="text-neutral-500"> — {track.album}</span> : null}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 mt-0.5">
                  <LikeButton
                    liked={trackLiked}
                    onToggle={() => toggleLike(track.id, activeProfileId)}
                    label={trackLiked ? 'Remove from Favorites' : 'Add to Favorites'}
                    size={20}
                    className="h-9 w-9"
                  />
                  <button
                    type="button"
                    onClick={openMenu}
                    aria-label="More"
                    title="More"
                    className="h-9 w-9 grid place-items-center rounded-full text-neutral-300 hover:text-neutral-100 hover:bg-white/10"
                  >
                    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <circle cx="5" cy="12" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="19" cy="12" r="1.6" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Scrubber — elapsed / remaining */}
              <div className="mt-6 flex items-center gap-3">
                <span className="text-xs text-neutral-400 tabular-nums w-10 text-right">
                  {formatDuration(Math.round(currentTime) * 1000)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(dur, 1)}
                  step={1}
                  value={Math.min(currentTime, dur)}
                  onChange={(e) => setCurrentTime(Number(e.target.value))}
                  aria-label="Seek"
                  className="flex-1 h-1.5 appearance-none rounded-full cursor-pointer [--sf:rgba(255,255,255,0.8)] [--st:rgba(255,255,255,0.18)] [--sth:transparent] hover:[--sf:rgba(255,255,255,0.98)] hover:[--st:rgba(255,255,255,0.28)] hover:[--sth:#ffffff] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--sth)] [&::-webkit-slider-thumb]:transition-colors [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--sth)]"
                  style={{
                    // Flagship tint surface: the scrubber fill takes the artwork
                    // accent while playing (white remains the paused default).
                    ...(isPlaying
                      ? {
                          ['--sf' as string]:
                            'color-mix(in srgb, var(--color-accent) 90%, white)',
                        }
                      : {}),
                    background: `linear-gradient(to right, var(--sf) ${scrubPct}%, var(--st) ${scrubPct}%)`,
                  }}
                />
                <span className="text-xs text-neutral-400 tabular-nums w-10">
                  -{formatDuration(remaining * 1000)}
                </span>
              </div>

              {/* Transport */}
              <div className="mt-4 flex items-center justify-center gap-7">
                <button type="button" onClick={toggleShuffle} aria-label="Shuffle" aria-pressed={shuffle} className={`h-9 w-9 grid place-items-center rounded-full transition ${shuffle ? 'text-accent' : 'text-neutral-500 hover:text-neutral-200'}`} style={shuffle ? { backgroundColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent)' } : undefined}>
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                  </svg>
                </button>
                <button type="button" onClick={prev} aria-label="Previous" className="text-neutral-200 hover:text-white">
                  <svg width={28} height={28} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M11.5 6 11.5 18 3.5 12z" />
                    <path d="M20.5 6 20.5 18 12.5 12z" />
                  </svg>
                </button>
                <button type="button" onClick={playPause} aria-label={isPlaying ? 'Pause' : 'Play'} className="h-16 w-16 grid place-items-center text-white hover:scale-105 active:scale-95 transition">
                  {buffering && isPlaying ? (
                    <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="animate-spin" aria-hidden>
                      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                    </svg>
                  ) : isPlaying ? (
                    <svg width={44} height={44} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>
                  ) : (
                    <svg width={44} height={44} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <button type="button" onClick={next} aria-label="Next" className="text-neutral-200 hover:text-white">
                  <svg width={28} height={28} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M3.5 6 3.5 18 11.5 12z" />
                    <path d="M12.5 6 12.5 18 20.5 12z" />
                  </svg>
                </button>
                <button type="button" onClick={toggleRepeat} aria-label="Repeat" aria-pressed={repeat !== 'off'} className={`relative h-9 w-9 grid place-items-center rounded-full transition ${repeat !== 'off' ? 'text-accent' : 'text-neutral-500 hover:text-neutral-200'}`} style={repeat !== 'off' ? { backgroundColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent)' } : undefined}>
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                  {repeat === 'one' ? <span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold leading-none bg-neutral-950 rounded-full px-1">1</span> : null}
                </button>
              </div>

              {/* Volume */}
              <div className="mt-5 flex items-center gap-3 justify-center">
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500" aria-hidden>
                  <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
                </svg>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  aria-label="Volume"
                  className="w-40 h-1.5 appearance-none rounded-full cursor-pointer [--vf:rgba(255,255,255,0.45)] [--vt:rgba(255,255,255,0.13)] [--vth:transparent] hover:[--vf:rgba(255,255,255,0.95)] hover:[--vt:rgba(255,255,255,0.28)] hover:[--vth:#ffffff] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--vth)] [&::-webkit-slider-thumb]:transition-colors [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--vth)]"
                  style={{
                    background: `linear-gradient(to right, var(--vf) ${volume * 100}%, var(--vt) ${volume * 100}%)`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Right pane — Lyrics / Up next. Its WIDTH, margin and opacity animate
              in lock-step with the artwork column's width, so opening/closing
              glides instead of snapping. Kept mounted through the close (see
              paneMounted) so the content fades out with the panel rather than
              vanishing first. The artwork centers when the pane is 0-width. */}
          <div
            aria-hidden={!paneOpen}
            className="min-w-0 overflow-hidden flex flex-col"
            style={{
              width: paneOpen ? '52%' : '0%',
              maxWidth: 680,
              marginLeft: paneOpen ? 40 : 0,
              opacity: paneOpen ? 1 : 0,
              // `height` tracks the (live-measured) column height, so it must NOT
              // transition — only the open/close properties do, or the height
              // would smear as the artwork resizes.
              height: playerH || undefined,
              transitionProperty: 'width, margin-left, opacity',
              transitionDuration: '300ms',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            {paneMounted ? (
              <div key={tab} className="flex-1 min-h-0">
                {tab === 'lyrics' ? (
                  <LyricsView lyrics={lyrics} currentTime={currentTime} loading={lyricsLoading} onSeekTo={(s) => setCurrentTime(s)} />
                ) : (
                  <QueuePanel className="pr-1" />
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-neutral-500">Nothing playing</div>
      )}

      {/* Corner toggles — Lyrics + Up next (Apple Music places them here). */}
      {track && (
        <div className="absolute right-6 bottom-6 z-10 flex items-center gap-2.5">
          <CornerToggle
            on={paneOpen && tab === 'lyrics'}
            label="Lyrics"
            onClick={() => togglePane('lyrics')}
          >
            <LyricsIcon size={20} />
          </CornerToggle>
          <CornerToggle
            on={paneOpen && tab === 'queue'}
            label="Up next"
            onClick={() => togglePane('queue')}
          >
            <QueueIcon size={20} />
          </CornerToggle>
        </div>
      )}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {sleepMenu && (
        <ContextMenu state={sleepMenu} onClose={() => setSleepMenu(null)} />
      )}
      {addToPlaylist && (
        <AddToPlaylistModal
          track={addToPlaylist.track}
          token={addToPlaylist.token}
          activeProfileId={activeProfileId}
          onClose={closeAddToPlaylist}
        />
      )}
    </div>
  );
}


/** A bottom-corner toggle (Lyrics / Up next). `children` are the glyph — pass
 *  the shared PlayerIcons so these read as the same controls as the player
 *  bar's. Lit with the artwork accent when its pane is open. */
function CornerToggle({
  on,
  label,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={`h-10 w-10 grid place-items-center rounded-xl border transition ${
        on
          ? 'bg-white/10 text-accent border-white/15'
          : 'bg-black/30 text-neutral-300 border-transparent hover:text-neutral-100 hover:bg-black/45 backdrop-blur-sm'
      }`}
    >
      {children}
    </button>
  );
}
