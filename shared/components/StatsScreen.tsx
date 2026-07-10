import { useEffect, useMemo, useState } from 'react';
import { getStats, type ListeningStats } from '../api';
import { cn, BAR, CARD, EYEBROW, navPill } from '../ui';

interface Props {
  token: string;
  profileId: number | null;
  onBack: () => void;
}

const RANGES: { key: string; label: string; days: number }[] = [
  { key: '4w', label: 'Last 4 weeks', days: 28 },
  { key: '6m', label: 'Last 6 months', days: 182 },
  { key: 'all', label: 'All time', days: 0 },
];

/**
 * Personal listening stats / "Wrapped". Reads play_events from the hub (all
 * private + local) and shows totals, top artists and top songs over a chosen
 * window. Shared by the phone and desktop.
 */
export function StatsScreen({ token, profileId, onBack }: Props) {
  const [rangeKey, setRangeKey] = useState('4w');
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [loading, setLoading] = useState(true);

  const since = useMemo(() => {
    const r = RANGES.find((x) => x.key === rangeKey)!;
    return r.days === 0 ? 0 : Math.floor(Date.now() / 1000) - r.days * 86400;
  }, [rangeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStats(token, profileId, since)
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStats(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, profileId, since]);

  const empty = !loading && (!stats || stats.total_plays === 0);

  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <div className={cn(BAR, 'sticky top-0 z-10 border-b flex items-center gap-1 px-3 py-3')}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="h-9 w-9 grid place-items-center rounded-full text-neutral-300 hover:bg-neutral-800 active:bg-neutral-800"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-xl font-bold tracking-tight">Your stats</h1>
      </div>

      <div className="px-4 flex gap-2 flex-wrap">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRangeKey(r.key)}
            className={cn('rounded-full px-3 py-1.5 text-xs transition active:bg-white/10', navPill(rangeKey === r.key))}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="px-4 mt-10 text-sm text-neutral-500">Loading…</div>
      ) : empty ? (
        <div className="px-4 mt-10 text-sm text-neutral-500">
          No listening yet in this window. Play some music and your stats will
          fill in here.
        </div>
      ) : (
        stats && (
          <>
            <div className="px-4 mt-6 grid grid-cols-3 gap-3 text-center">
              <Headline value={stats.total_minutes} label="minutes" />
              <Headline value={stats.total_plays} label="plays" />
              <Headline value={stats.unique_artists} label="artists" />
            </div>

            {stats.top_artists.length > 0 && (
              <section className="mt-8">
                <h2 className={cn(EYEBROW, 'px-4 mb-2')}>
                  Top artists
                </h2>
                <ol>
                  {stats.top_artists.slice(0, 10).map((a, i) => (
                    <li
                      key={`${a.name}-${i}`}
                      className="px-4 py-2 flex items-center gap-3"
                    >
                      <span className="w-5 text-right text-sm text-neutral-500 tabular-nums">
                        {i + 1}
                      </span>
                      <span className="flex-1 min-w-0 truncate text-sm">
                        {a.name}
                      </span>
                      <span className="text-xs text-neutral-500 tabular-nums">
                        {a.count} {a.count === 1 ? 'play' : 'plays'}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {stats.top_tracks.length > 0 && (
              <section className="mt-6">
                <h2 className={cn(EYEBROW, 'px-4 mb-2')}>
                  Top songs
                </h2>
                <ol>
                  {stats.top_tracks.slice(0, 15).map((t, i) => (
                    <li
                      key={`${t.track_id}-${i}`}
                      className="px-4 py-2 flex items-center gap-3"
                    >
                      <span className="w-5 text-right text-sm text-neutral-500 tabular-nums shrink-0">
                        {i + 1}
                      </span>
                      <div className="h-10 w-10 shrink-0 rounded-lg bg-neutral-800 overflow-hidden">
                        {t.album_art_url ? (
                          <img
                            src={t.album_art_url}
                            alt=""
                            className="h-full w-full object-cover"
                            draggable={false}
                            loading="lazy"
                          />
                        ) : null}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{t.title}</div>
                        <div className="text-xs text-neutral-500 truncate">
                          {t.artists.join(', ')}
                        </div>
                      </div>
                      <span className="text-xs text-neutral-500 tabular-nums shrink-0">
                        {t.count} {t.count === 1 ? 'play' : 'plays'}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}

function Headline({ value, label }: { value: number; label: string }) {
  return (
    <div className={cn(CARD, 'py-4')}>
      <div className="text-2xl font-bold tracking-tight tabular-nums">
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-neutral-500 mt-0.5">{label}</div>
    </div>
  );
}
