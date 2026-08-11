import { canStream } from '../store';
import type { StreamTrack } from '@shared/api';

/**
 * A flat list of tracks: art, title, artists; tap plays. Non-playable rows
 * dim. Shared by Library › Songs, Library › Offline, and the "Saved on this
 * device" screen in Settings, so a song row looks the same wherever the phone
 * lists songs.
 */
export function SongsList({
  songs,
  hasQuery,
  query,
  onPlay,
  emptyLabel = 'No songs in your library yet.',
}: {
  songs: StreamTrack[] | null;
  hasQuery: boolean;
  query: string;
  onPlay: (t: StreamTrack) => void;
  /** Shown when the list is empty and there is no query — the Offline view
   *  needs to say something other than "no songs in your library". */
  emptyLabel?: string;
}) {
  if (songs === null) {
    return (
      <ul className="flex flex-col" aria-hidden>
        {Array.from({ length: 8 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 py-2 px-1 animate-pulse">
            <div className="h-12 w-12 shrink-0 rounded bg-neutral-900" />
            <div className="flex-1">
              <div className="h-3 w-1/2 rounded bg-neutral-900" />
              <div className="mt-1.5 h-2.5 w-1/3 rounded bg-neutral-900" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (songs.length === 0) {
    return (
      <div className="px-2 py-8 text-center text-sm text-neutral-500">
        {hasQuery
          ? `No matches for “${query}”.`
          : emptyLabel}
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {songs.map((t) => {
        const playable = canStream(t);
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => playable && onPlay(t)}
              className={`w-full flex items-center gap-3 py-2 px-1 rounded-lg text-left ${
                playable
                  ? 'hover:bg-neutral-900 active:bg-neutral-900'
                  : 'opacity-50'
              }`}
            >
              <div className="h-12 w-12 shrink-0 grid place-items-center overflow-hidden rounded bg-neutral-800">
                {t.album_art_url ? (
                  <img
                    src={t.album_art_url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-neutral-600 text-xs">♪</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{t.title}</div>
                <div className="text-xs text-neutral-500 truncate">
                  {t.artists.join(', ') || '—'}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
