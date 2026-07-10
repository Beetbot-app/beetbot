import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { useNavStore } from '@/lib/nav';
import { useUiStore } from '@/lib/ui';
import { useProfileStore } from '@/lib/profile';
import { useLikesStore } from '@/lib/likes';
import { extractDominantColor } from '@shared/albumColor';
import { LyricsView } from '@shared/components/LyricsView';
import { LikeButton } from '@shared/components/LikeButton';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { ContextMenu, MenuGlyphs, type MenuState } from '@shared/components/ContextMenu';
import { AddToPlaylistModal } from '@shared/components/SearchScreen';
import {
  ShareDialog,
  spotifyTrackId,
  type ShareTarget,
} from '@/components/ShareDialog';
import { ensureSession, getTrackPlaylistIds, type SearchTrackResult } from '@shared/api';
import { useLyrics } from '@/lib/useLyrics';
import type { PlaylistTrack } from '@/lib/tauri';

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
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playPause = usePlayerStore((s) => s.playPause);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const playNext = usePlayerStore((s) => s.playNext);
  const moveItem = usePlayerStore((s) => s.moveItem);
  const clearUpcoming = usePlayerStore((s) => s.clearUpcoming);

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

  // ⋯ menu + the surfaces it opens.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addToPlaylist, setAddToPlaylist] = useState<{
    track: SearchTrackResult;
    token: string;
  } | null>(null);
  const [share, setShare] = useState<ShareTarget | null>(null);
  // HTML5 drag-reorder of the up-next list. The ref is the authoritative source
  // read on drop (immune to render timing); the state just drives the ghost.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

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
            track: {
              source: 'local',
              source_id: String(t.id),
              title: t.title,
              artists: t.artists ?? [],
              album: t.album ?? null,
              album_art_url: t.album_art_url ?? null,
              duration_ms: t.duration_ms ?? 0,
              isrc: t.isrc ?? null,
              local_track_id: t.id,
              in_playlist_ids: inIds,
              has_audio: t.local_path != null,
              preview_url: null,
              explicit: false,
            },
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
          {
            label: 'Share',
            icon: MenuGlyphs.share,
            separator: true,
            onClick: () =>
              setShare({
                title: track.title,
                artist: track.artists[0] ?? null,
                spotifyId: spotifyTrackId(track.spotify_id),
                art: track.album_art_url,
              }),
          },
        ],
      });
    },
    [track, openAddToPlaylist, goArtist, goAlbum],
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

  const upNext = queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => i > currentIndex);

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
        <div className="flex-1 min-h-0 flex gap-8 px-10 pt-14 pb-8">
          {/* Left: cover + meta + transport */}
          <div className="flex-1 min-w-0 flex flex-col items-center justify-center max-w-[46%]">
            <button
              type="button"
              onClick={goAlbum}
              disabled={!track.album}
              className="w-full max-w-[min(52vh,38vw)] aspect-square rounded-2xl overflow-hidden bg-neutral-900 shadow-2xl disabled:cursor-default"
            >
              {track.album_art_url ? (
                <img src={track.album_art_url} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="h-full w-full grid place-items-center text-neutral-700 text-6xl">♪</div>
              )}
            </button>

            <div className="w-full max-w-[min(52vh,38vw)] mt-6">
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
                <button type="button" onClick={toggleShuffle} aria-label="Shuffle" className={shuffle ? 'text-accent' : 'text-neutral-500 hover:text-neutral-200'}>
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
                <button type="button" onClick={toggleRepeat} aria-label="Repeat" className={repeat !== 'off' ? 'text-accent' : 'text-neutral-500 hover:text-neutral-200'}>
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                  {repeat === 'one' ? <span className="text-[9px] font-bold">1</span> : null}
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

          {/* Right: Lyrics / Up Next */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-1 mb-3">
              <TabBtn active={tab === 'lyrics'} onClick={() => setTab('lyrics')}>Lyrics</TabBtn>
              <TabBtn active={tab === 'queue'} onClick={() => setTab('queue')}>Up next</TabBtn>
              <button
                type="button"
                onClick={() => setAutoplay(!autoplay)}
                title="Autoplay similar songs when the queue ends"
                aria-pressed={autoplay}
                className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition ${
                  autoplay ? 'bg-white/10 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
                }`}
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8" />
                </svg>
                Autoplay
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {tab === 'lyrics' ? (
                <LyricsView lyrics={lyrics} currentTime={currentTime} loading={lyricsLoading} onSeekTo={(s) => setCurrentTime(s)} />
              ) : (
                <div className="h-full overflow-y-auto overscroll-contain pr-1">
                  <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 pt-1 pb-1">Now playing</div>
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
                    upNext.map(({ t, i }) => (
                      <QueueRow
                        key={`${t.id}-${i}`}
                        t={t}
                        onPlay={() => playAt(i)}
                        onPlayNext={() => playNext(i)}
                        onRemove={() => removeFromQueue(i)}
                        dragging={dragIndex === i}
                        onDragStart={() => {
                          dragIndexRef.current = i;
                          setDragIndex(i);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          const from = dragIndexRef.current;
                          if (from != null) moveItem(from, i);
                          dragIndexRef.current = null;
                          setDragIndex(null);
                        }}
                        onDragEnd={() => {
                          dragIndexRef.current = null;
                          setDragIndex(null);
                        }}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-neutral-500">Nothing playing</div>
      )}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {addToPlaylist && (
        <AddToPlaylistModal
          track={addToPlaylist.track}
          token={addToPlaylist.token}
          activeProfileId={activeProfileId}
          onClose={closeAddToPlaylist}
        />
      )}
      {share && <ShareDialog target={share} onClose={() => setShare(null)} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm transition ${
        active ? 'bg-white/10 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
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
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  t: PlaylistTrack;
  isCurrent?: boolean;
  playing?: boolean;
  onPlay: () => void;
  onPlayNext?: () => void;
  onRemove?: () => void;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      draggable={!isCurrent}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-3 px-2 py-2 rounded-lg ${
        isCurrent ? '' : 'hover:bg-white/5'
      } ${dragging ? 'opacity-40' : ''}`}
      style={
        isCurrent
          ? {
              // The now-playing row takes a faint artwork-accent wash + hairline
              // ring instead of a flat white highlight (title/EQ are already tinted).
              backgroundColor:
                'color-mix(in srgb, var(--color-accent) 12%, transparent)',
              boxShadow:
                'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 18%, transparent)',
            }
          : undefined
      }
    >
      {!isCurrent ? (
        <span className="cursor-grab text-neutral-600 group-hover:text-neutral-400 select-none shrink-0" aria-hidden title="Drag to reorder">
          ⠿
        </span>
      ) : null}
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
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
          <button type="button" onClick={onPlayNext} aria-label="Play next" title="Play next" className="h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200">
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 6l8 6-8 6zM18 5v14" />
            </svg>
          </button>
          <button type="button" onClick={onRemove} aria-label="Remove from queue" title="Remove" className="h-7 w-7 grid place-items-center rounded text-neutral-500 hover:text-neutral-200">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
