import { useEffect, useState } from 'react';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { ensureSession, getLyrics, type Lyrics } from '@shared/api';

/**
 * Lyrics for the now-playing track (LRCLIB via the hub), refetched on track
 * change. Shared by the full now-playing view and the docked right bar so the
 * fetch logic lives in one place.
 */
export function useLyrics(): { lyrics: Lyrics | null; loading: boolean } {
  const track = usePlayerStore(currentTrack);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!track) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    setLyrics(null);
    setLoading(true);
    void ensureSession()
      .then((tok) =>
        getLyrics(tok, {
          title: track.title,
          artist: track.artists[0] ?? '',
          album: track.album,
          durationMs: track.duration_ms,
        }),
      )
      .then((l) => {
        if (!cancelled) setLyrics(l);
      })
      .catch(() => {
        if (!cancelled) setLyrics(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // Prefetch the next queued track's lyrics so they're cached before the song
  // rolls over. Fire-and-forget; keyed on the next track's id.
  const nextTrack = usePlayerStore((s) => s.queue[s.currentIndex + 1] ?? null);
  useEffect(() => {
    if (!nextTrack) return;
    void ensureSession()
      .then((tok) =>
        getLyrics(tok, {
          title: nextTrack.title,
          artist: nextTrack.artists[0] ?? '',
          album: nextTrack.album,
          durationMs: nextTrack.duration_ms,
        }),
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextTrack?.id]);

  return { lyrics, loading };
}
