import { useEffect, useState } from 'react';
import { cn, SCRIM, SHEET } from '@shared/ui';

// Share dialog (Daft-style): produces a universal song.link (Odesli) link that
// resolves to a page with the track on every streaming service, and — when the
// Odesli API is reachable — inline buttons per service. Built from the track's
// Spotify id; the constructed `song.link/s/<id>` link is the always-available
// fallback, so even if the enrichment fetch fails the user still gets a working
// cross-service link. Tracks without a Spotify id fall back to copying text.

const SERVICES: { key: string; label: string }[] = [
  { key: 'spotify', label: 'Spotify' },
  { key: 'appleMusic', label: 'Apple Music' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'youtubeMusic', label: 'YouTube Music' },
  { key: 'deezer', label: 'Deezer' },
  { key: 'tidal', label: 'Tidal' },
  { key: 'amazonMusic', label: 'Amazon Music' },
  { key: 'soundcloud', label: 'SoundCloud' },
  { key: 'pandora', label: 'Pandora' },
];

export interface ShareTarget {
  title: string;
  artist: string | null;
  /** Bare Spotify track id, or null when the track isn't from Spotify. */
  spotifyId: string | null;
  art: string | null;
}

/** Parse a stored `spotify_id` ("spotify:track:<id>") into the bare id. */
export function spotifyTrackId(spotifyId: string): string | null {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(spotifyId);
  return m ? m[1] : null;
}

export function ShareDialog({
  target,
  onClose,
}: {
  target: ShareTarget;
  onClose: () => void;
}) {
  const [pageUrl, setPageUrl] = useState<string | null>(
    target.spotifyId ? `https://song.link/s/${target.spotifyId}` : null,
  );
  const [links, setLinks] = useState<{ label: string; url: string }[]>([]);
  const [loading, setLoading] = useState(!!target.spotifyId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!target.spotifyId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const api = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(
      `https://open.spotify.com/track/${target.spotifyId}`,
    )}`;
    fetch(api)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: SonglinkResponse) => {
        if (cancelled) return;
        if (data.pageUrl) setPageUrl(data.pageUrl);
        const byPlat = data.linksByPlatform ?? {};
        setLinks(
          SERVICES.filter((s) => byPlat[s.key]?.url).map((s) => ({
            label: s.label,
            url: byPlat[s.key]!.url,
          })),
        );
      })
      .catch(() => {
        /* keep the constructed song.link/s/ fallback URL */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.spotifyId]);

  const shareText = `${target.title}${target.artist ? ` — ${target.artist}` : ''}`;
  const copyValue = pageUrl ?? shareText;
  const copy = () => {
    void navigator.clipboard?.writeText(copyValue).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cn(SCRIM, 'z-[70] grid place-items-center p-6')}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cn(SHEET, 'w-full max-w-md')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-12 w-12 shrink-0 rounded bg-neutral-800 overflow-hidden grid place-items-center">
              {target.art ? (
                <img
                  src={target.art}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-neutral-600">♪</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold">Share</div>
              <div className="text-xs text-neutral-500 truncate">{shareText}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>
        <div className="px-5 pb-5">
          <div className="flex items-center gap-2 mb-3">
            <input
              readOnly
              value={copyValue}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 rounded-lg bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm text-neutral-300"
            />
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-lg px-3 py-2 bg-neutral-100 hover:bg-white text-neutral-950 text-sm font-medium transition"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {pageUrl ? (
            <p className="text-xs text-neutral-500 mb-3">
              A universal link — opens a page with this song on every service.
            </p>
          ) : (
            <p className="text-xs text-neutral-500 mb-3">
              This track isn’t from Spotify, so there’s no universal link — copy
              the title and artist to share.
            </p>
          )}
          {loading ? (
            <div className="text-xs text-neutral-500">Finding links…</div>
          ) : links.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-neutral-200 hover:bg-white/5 transition"
                >
                  {l.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface SonglinkResponse {
  pageUrl?: string;
  linksByPlatform?: Record<string, { url: string } | undefined>;
}
