import { PreviewRing } from '@shared/components/SearchScreen';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { formatDuration } from '@/lib/format';
import { canStream, usePlayerStore } from '@/lib/store';
import type { PlaylistTrack } from '@/lib/tauri';

interface Props {
  track: PlaylistTrack;
  index: number;
  /** Open the "Add audio file" import flow for this track. */
  onAddAudio: (track: PlaylistTrack) => void;
  onPlay: (track: PlaylistTrack) => void;
  isPlaying?: boolean;
  /** Audition the 30s preview clip (only offered for tracks without a file —
   *  ones with audio play the full file via the row click). */
  onPreview?: (track: PlaylistTrack) => void;
  previewing?: boolean;
  previewLoading?: boolean;
  /** Album view: every track shares the album's cover art and name, so we drop
   *  the redundant per-row cover + Album columns and fold play/preview into the
   *  # cell (Spotify-style) instead. */
  isAlbum?: boolean;
  /** Open the per-song "⋯" overflow menu at the given screen point (also wired
   *  to right-click). The parent owns the menu (it has the playlist context). */
  onShowMenu?: (track: PlaylistTrack, x: number, y: number) => void;
  /** Make the artist / album names clickable → navigate to their pages
   *  (hover-highlight). When absent they're plain text. */
  onGoToArtist?: (name: string) => void;
  onGoToAlbum?: (name: string, artist: string | null) => void;
}

/** The 30s-preview glyph: spinner while loading, pause while playing, else play. */
function PreviewGlyph({
  previewing,
  previewLoading,
}: {
  previewing?: boolean;
  previewLoading?: boolean;
}) {
  if (previewLoading) {
    return (
      <svg className="h-4 w-4 animate-spin text-white" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  if (previewing) {
    return (
      <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4 text-white translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** "Downloaded" indicator — quiet DOWN-ARROW (not a check), shown only for
 *  tracks whose audio is on the device. Distinct from the ✓ that means "in a
 *  playlist": ↓ = on this device, ✓ = saved to a playlist. */
function DownloadedBadge() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[17px] w-[17px] text-neutral-500"
      fill="currentColor"
      role="img"
      aria-label="Downloaded"
    >
      <title>Downloaded</title>
      <path d="M13 3a1 1 0 1 0-2 0v9.6l-3.3-3.3a1 1 0 0 0-1.4 1.4l5 5a1 1 0 0 0 1.4 0l5-5a1 1 0 0 0-1.4-1.4L13 12.6V3Z" />
      <path d="M5 19.5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z" />
    </svg>
  );
}

export function TrackRow({
  track,
  index,
  onAddAudio,
  onPlay,
  isPlaying,
  onPreview,
  previewing,
  previewLoading,
  isAlbum,
  onShowMenu,
  onGoToArtist,
  onGoToAlbum,
}: Props) {
  // Whether audio is ACTUALLY running (vs. current-but-paused). Spotify-style
  // current-row indicator: bouncing equalizer bars while playing; when paused
  // the number returns (the row + number keep their highlight), instead of a
  // static play glyph.
  const audible = usePlayerStore((s) => s.isPlaying);
  // Artist name(s) → clickable links (navigate to that artist), stopping
  // propagation so they don't also trigger the row's play. Plain text otherwise.
  const renderArtists = () => {
    const names = track.artists;
    if (!names.length) return '—';
    if (!onGoToArtist) return names.join(', ');
    return names.map((name, idx) => (
      <span key={idx}>
        {idx > 0 ? ', ' : ''}
        <span
          role="link"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            const n = name.trim();
            if (n) onGoToArtist(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              const n = name.trim();
              if (n) onGoToArtist(n);
            }
          }}
          className="cursor-pointer hover:text-neutral-200 hover:underline"
        >
          {name}
        </span>
      </span>
    ));
  };
  // `hasFile` drives the file-state column + the "Add file…" affordance.
  // `playable` drives the play interactions: a downloaded track plays its file,
  // and on the full build any track plays via on-demand live stream. Only the
  // open build (no engine) leaves a fileless track preview-only.
  const hasFile = track.local_path != null || track.status === 'downloaded';
  const playable = canStream(track);
  const handleRowClick = playable ? () => onPlay(track) : undefined;
  // Album view collapses the cover + Album columns (both are the same for every
  // track) and moves play/preview onto the # cell.
  const grid = isAlbum
    ? 'grid-cols-[2.5rem_1fr_5rem_2rem_5rem]'
    : 'grid-cols-[2.5rem_3rem_1fr_1fr_5rem_5rem_2.5rem]';
  return (
    <div
      onClick={handleRowClick}
      onContextMenu={
        onShowMenu
          ? (e) => {
              e.preventDefault();
              onShowMenu(track, e.clientX, e.clientY);
            }
          : undefined
      }
      className={`group grid ${grid} gap-3 items-center px-4 h-14 border-b border-white/5 ${
        playable
          ? `text-neutral-100 cursor-pointer ${isPlaying ? 'bg-neutral-900/50' : ''}`
          : 'text-neutral-500'
      } hover:bg-neutral-900/40 transition-colors`}
    >
      {isAlbum ? (
        // Album: track number, with play (file) / preview (no file) on hover.
        <span className="relative grid h-full w-full place-items-center text-sm tabular-nums">
          <span
            className={`${isPlaying ? 'text-neutral-100' : 'text-neutral-500'} ${
              !isPlaying && (playable || onPreview)
                ? 'group-hover:opacity-0'
                : ''
            } ${!playable && (previewing || previewLoading) ? 'opacity-0' : ''}`}
          >
            {isPlaying && audible ? <EqualizerBars /> : index + 1}
          </span>
          {!playable && onPreview ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPreview(track);
              }}
              title={previewing ? 'Stop preview' : 'Preview (30s clip)'}
              aria-label={previewing ? 'Stop preview' : 'Preview'}
              className={`absolute inset-0 grid place-items-center transition-opacity ${
                previewing || previewLoading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <PreviewGlyph previewing={previewing} previewLoading={previewLoading} />
              {previewing ? <PreviewRing size={28} strokeWidth={2} /> : null}
            </button>
          ) : playable && !isPlaying ? (
            // Playable: the whole row already plays on click; just hint it.
            <span className="pointer-events-none absolute inset-0 grid place-items-center text-neutral-100 opacity-0 group-hover:opacity-100">
              <svg className="h-4 w-4 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          ) : null}
        </span>
      ) : (
        // Playlist view: number, swapping to a ▶ hint on hover for playable
        // rows (the whole row already plays on click) — matching the album view.
        <span className="relative grid h-full w-full place-items-center text-sm tabular-nums">
          <span
            className={`${isPlaying ? 'text-neutral-100' : 'text-neutral-500'} ${
              !isPlaying && playable ? 'group-hover:opacity-0' : ''
            }`}
          >
            {isPlaying && audible ? <EqualizerBars /> : index + 1}
          </span>
          {playable && !isPlaying ? (
            <span className="pointer-events-none absolute inset-0 grid place-items-center text-neutral-100 opacity-0 group-hover:opacity-100">
              <svg className="h-4 w-4 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          ) : null}
        </span>
      )}
      {!isAlbum &&
        (!playable && onPreview ? (
          // Not playable (open build, no file) — the cover doubles as a 30s
          // preview play/pause control, Spotify/Shazam-style. When playable the
          // cover is plain art and the row click plays the full track.
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPreview(track);
            }}
            title={previewing ? 'Stop preview' : 'Preview (30s clip)'}
            aria-label={previewing ? 'Stop preview' : 'Preview'}
            className="relative h-10 w-10 rounded bg-neutral-800 overflow-hidden grid place-items-center group/art"
          >
            {track.album_art_url ? (
              <img
                src={track.album_art_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-neutral-600 text-xs">♪</span>
            )}
            <span
              className={`absolute inset-0 grid place-items-center bg-black/45 transition-opacity ${
                previewing || previewLoading
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/art:opacity-100'
              }`}
            >
              <PreviewGlyph previewing={previewing} previewLoading={previewLoading} />
            </span>
            {previewing ? <PreviewRing size={40} strokeWidth={2} /> : null}
          </button>
        ) : (
          <div className="h-10 w-10 rounded-lg bg-neutral-800 overflow-hidden grid place-items-center">
            {track.album_art_url ? (
              <img
                src={track.album_art_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-neutral-600 text-xs">♪</span>
            )}
          </div>
        ))}
      <div className="min-w-0">
        <div className="truncate font-medium" title={track.title}>
          {track.title}
        </div>
        <div className="truncate text-sm text-neutral-500" title={track.artists.join(', ')}>
          {renderArtists()}
        </div>
      </div>
      {!isAlbum && (
        <div className="truncate text-sm text-neutral-400" title={track.album ?? ''}>
          {track.album && onGoToAlbum ? (
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onGoToAlbum(track.album!, track.artists[0] ?? null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onGoToAlbum(track.album!, track.artists[0] ?? null);
                }
              }}
              className="cursor-pointer hover:text-neutral-200 hover:underline"
            >
              {track.album}
            </span>
          ) : (
            (track.album ?? '—')
          )}
        </div>
      )}
      {/* FILE — the green "downloaded" seal, or (for fileless tracks) the
          "add an audio file" + on hover, in the SAME spot so it lines up under
          the "File" header (not an orphaned column to the right). */}
      <div className="grid place-items-start">
        <span className="grid h-7 w-7 place-items-center">
          {hasFile ? (
            <DownloadedBadge />
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAddAudio(track);
              }}
              className="grid h-full w-full place-items-center rounded text-neutral-400 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 group-hover:opacity-100 focus-visible:opacity-100"
              title="Add an audio file for this track"
              aria-label="Add audio file"
            >
              {/* Plus-in-circle — "add a file". */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8" />
                <path d="M8 12h8" />
              </svg>
            </button>
          )}
        </span>
      </div>
      <div className="text-sm text-neutral-500 tabular-nums text-right">
        {formatDuration(track.duration_ms)}
      </div>
      {!isAlbum && (
        <div className="grid place-items-center">
          {onShowMenu ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShowMenu(track, e.clientX, e.clientY);
              }}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition w-8 h-8 grid place-items-center rounded-full text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
              title="More options"
              aria-label={`More options for ${track.title}`}
            >
              {/* Three-dot overflow, like Spotify's per-row menu. */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
