import { CardPlayButton } from '@shared/components/Marquee';
import type { PlaylistSummary } from '@/lib/tauri';

interface Props {
  playlist: PlaylistSummary;
  onOpen: (id: number) => void;
  /** When set, a white play button lifts in on the cover and plays the
      playlist (the card click still opens it) — the Home-card affordance. */
  onPlay?: (playlist: PlaylistSummary) => void;
}

export function PlaylistCard({ playlist, onOpen, onPlay }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(playlist.id)}
      onKeyDown={(e) => {
        // Only the card root answers keys — a bubbled Enter/Space from the
        // nested play button must NOT also open the playlist.
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onOpen(playlist.id);
        }
      }}
      // w-full is load-bearing: the card is wrapped in a context-menu div in
      // Library's grid, so it is NOT a grid item — without an explicit width it
      // shrink-to-fits its longest line (the untruncated playlist name),
      // blowing the card out over its neighbors on long names.
      className="group relative w-full cursor-pointer text-left transition active:scale-[0.98]"
    >
      {/* Hover halo — same borderless card language as the Home shelves. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className="relative">
          <div className="aspect-square w-full overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {playlist.cover_url ? (
              <img
                src={playlist.cover_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <CoverFallback source={playlist.source} />
            )}
          </div>
          {onPlay ? (
            <CardPlayButton
              label={`Play ${playlist.name}`}
              onPlay={() => onPlay(playlist)}
            />
          ) : null}
        </div>
        <h3 className="mt-2 truncate font-medium" title={playlist.name}>
          {playlist.name}
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          {playlist.track_count} {playlist.track_count === 1 ? 'track' : 'tracks'}
        </p>
      </div>
    </div>
  );
}

function CoverFallback({ source }: { source: PlaylistSummary['source'] }) {
  // Picks a tiny glyph for the placeholder when a playlist has no
  // cover art. ★ for Favorites, ♪ for everything else.
  const initial = source === 'liked' ? '★' : '♪';
  return (
    <div className="h-full w-full grid place-items-center text-3xl text-neutral-600">
      {initial}
    </div>
  );
}
