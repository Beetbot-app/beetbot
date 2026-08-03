import { useEffect, useMemo, useState } from 'react';
import { getStats, searchCatalog, type ListeningStats } from '../api';
import { hasRealPortrait, pickArtistForName } from '../artistName';
import { cn, BAR } from '../ui';

interface Props {
  token: string;
  profileId: number | null;
  onBack: () => void;
  /** Show the in-header back chevron. Desktop hides it (the global top-bar
   *  Back/Forward already covers it); the phone keeps it as its only way back. */
  showBack?: boolean;
}

const RANGES: { key: string; label: string; days: number }[] = [
  { key: '4w', label: 'Last 4 weeks', days: 28 },
  { key: '6m', label: 'Last 6 months', days: 182 },
  { key: 'all', label: 'All time', days: 0 },
];

/**
 * Personal listening stats / "Wrapped". Reads play_events from the hub (all
 * private + local) and shows totals, top artists and top songs over a chosen
 * window. Shared by the phone and desktop. Apple-Music-Replay styling: a
 * segmented range control, big headline numerals, and grouped lists with inset
 * hairline separators, centred in a readable column.
 */
export function StatsScreen({ token, profileId, onBack, showBack = true }: Props) {
  const [rangeKey, setRangeKey] = useState('4w');
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [loading, setLoading] = useState(true);
  // Resolved artist portraits, name → Deezer picture URL (null = looked up, none
  // found). Same one-per-artist resolve the sidebar uses; searchCatalog caches,
  // so re-queries are cheap and the avatars pop in as they arrive.
  const [artistPics, setArtistPics] = useState<Record<string, string | null>>({});

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

  // Resolve a round portrait for each top artist (the stats payload only has
  // name + count). Best-effort and idempotent: already-resolved names are left
  // untouched, so a range switch only fetches the ones it hasn't seen.
  useEffect(() => {
    if (!stats || stats.top_artists.length === 0) return;
    const names = stats.top_artists.slice(0, 10).map((a) => a.name);
    let cancelled = false;
    // Fire every lookup at once (not one-after-another) so the portraits arrive
    // together in ~one round-trip instead of trickling in over several seconds.
    // Each resolves independently and paints as it lands; searchCatalog caches,
    // so a re-open is instant.
    void Promise.all(
      names.map(async (name) => {
        try {
          // Wider search + pick by name/fans, not result [0] — Deezer floods
          // same-name impostors and photo-less phantoms ahead of the real act.
          const res = await searchCatalog(name, token, 'artist', 8);
          const best = pickArtistForName(res.artists ?? [], name);
          const pic = hasRealPortrait(best?.picture_url) ? best!.picture_url : null;
          if (!cancelled) {
            setArtistPics((prev) =>
              name in prev ? prev : { ...prev, [name]: pic },
            );
          }
        } catch {
          /* leave unresolved → the placeholder shows, retried on next load */
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [stats, token]);

  const empty = !loading && (!stats || stats.total_plays === 0);

  return (
    // No solid page background: let the app-shell ambient wash show through
    // (the same top fade as the Settings page). The phone body is bg-neutral-950,
    // so it stays flat dark there.
    <div className="min-h-full text-neutral-100">
      {/* Sticky nav bar — flush at the top of the scroll container, frosted. */}
      <header
        className={cn(
          BAR,
          'sticky top-0 z-10 border-b border-white/5 flex items-center gap-2 px-4 sm:px-5 py-3',
        )}
      >
        {showBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-ml-1 h-9 w-9 grid place-items-center rounded-full text-neutral-300 transition hover:bg-white/10 active:bg-white/10"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
        <h1 className="text-lg font-bold tracking-tight">Your stats</h1>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 pb-20">
        {/* Segmented range control (Apple-style: a pill track with a solid
            selected segment). */}
        <div className="mt-5 flex justify-center">
          <div
            role="tablist"
            aria-label="Time range"
            className="inline-flex gap-1 rounded-full bg-white/[0.06] p-1"
          >
            {RANGES.map((r) => {
              const active = rangeKey === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setRangeKey(r.key)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition',
                    active
                      ? 'bg-white text-neutral-900 shadow-sm'
                      : 'text-neutral-400 hover:text-neutral-100',
                  )}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        {loading ? (
          <p className="mt-16 text-center text-sm text-neutral-500">Loading…</p>
        ) : empty ? (
          <p className="mx-auto mt-16 max-w-xs text-center text-sm text-neutral-500">
            No listening yet in this window. Play some music and your stats will
            fill in here.
          </p>
        ) : (
          stats && (
            <>
              {/* Headline totals. */}
              <div className="mt-7 grid grid-cols-3 gap-3 sm:gap-4">
                <Headline value={stats.total_minutes} label="minutes" />
                <Headline value={stats.total_plays} label="plays" />
                <Headline value={stats.unique_artists} label="artists" />
              </div>

              {stats.top_artists.length > 0 && (
                <Section title="Top artists">
                  <GroupedList>
                    {stats.top_artists.slice(0, 10).map((a, i) => (
                      <Row
                        key={`${a.name}-${i}`}
                        rank={i + 1}
                        art={artistPics[a.name]}
                        round
                        title={a.name}
                        count={a.count}
                      />
                    ))}
                  </GroupedList>
                </Section>
              )}

              {stats.top_tracks.length > 0 && (
                <Section title="Top songs">
                  <GroupedList>
                    {stats.top_tracks.slice(0, 15).map((t, i) => (
                      <Row
                        key={`${t.track_id}-${i}`}
                        rank={i + 1}
                        art={t.album_art_url}
                        title={t.title}
                        subtitle={t.artists.join(', ')}
                        count={t.count}
                      />
                    ))}
                  </GroupedList>
                </Section>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

function Headline({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] px-2 py-5 text-center">
      <div className="text-[26px] sm:text-3xl font-bold tracking-tight tabular-nums leading-none">
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 text-[13px] text-neutral-400">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="mb-3 text-[17px] font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

/** Rounded card whose rows carry inset hairline separators (the last one is
 *  suppressed) — Apple's grouped-list look. */
function GroupedList({ children }: { children: React.ReactNode }) {
  return (
    <ol className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] [&>li:last-child_.hairline]:border-0">
      {children}
    </ol>
  );
}

function Row({
  rank,
  art,
  round,
  title,
  subtitle,
  count,
}: {
  rank: number;
  art?: string | null;
  round?: boolean;
  title: string;
  subtitle?: string;
  count: number;
}) {
  return (
    <li className="flex items-center gap-3 pl-4">
      <span className="w-5 shrink-0 text-center text-[13px] tabular-nums text-neutral-500">
        {rank}
      </span>
      <div
        className={cn(
          'grid h-11 w-11 shrink-0 place-items-center overflow-hidden bg-neutral-800',
          round ? 'rounded-full' : 'rounded-lg',
        )}
      >
        {art ? (
          <img
            src={art}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
          />
        ) : round ? (
          <span className="text-sm font-semibold text-neutral-500">
            {title.slice(0, 1).toUpperCase()}
          </span>
        ) : null}
      </div>
      {/* Content carries the separator, so it insets to the text start. The
          min-height keeps single-line (artist) rows the same height as the
          two-line (song) rows. */}
      <div className="hairline flex min-h-[3.5rem] min-w-0 flex-1 items-center gap-3 border-b border-white/[0.06] py-2.5 pr-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] leading-tight">{title}</div>
          {subtitle && (
            <div className="mt-0.5 truncate text-[13px] text-neutral-500">
              {subtitle}
            </div>
          )}
        </div>
        <span className="shrink-0 text-[13px] tabular-nums text-neutral-500">
          {count} {count === 1 ? 'play' : 'plays'}
        </span>
      </div>
    </li>
  );
}
