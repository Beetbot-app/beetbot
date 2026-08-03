import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CardPlayButton, Marquee } from './Marquee';
import { SwipeRow } from './SwipeRow';
import { getAlbumTracks, type SearchAlbumResult, type SearchTrackResult } from '../api';

/** Desktop-only sidebar-pin controls. Kept primitive so this shared file needn't
 *  import the desktop pin store; the host maps these to its `usePinStore`. */
export interface SidebarPinController {
  isArtistPinned: (key: string) => boolean;
  toggleArtist: (a: { key: string; name: string; art: string | null }) => void;
  isAlbumPinned: (album: string, artist: string | null) => boolean;
  toggleAlbum: (a: { album: string; artist: string | null; art: string | null }) => void;
}

// Deezer preview clips are 30 seconds; the depleting ring runs for the
// same fixed duration. If a clip is a hair shorter, the audio `ended`
// event clears the ring, so the two stay visually in sync.
export const PREVIEW_SECONDS = 30;

// Injected once by SearchScreen. Drives the Shazam-style countdown ring:
// stroke-dashoffset sweeps from 0 (full ring) to the circle's
// circumference (empty), so the arc visibly depletes as the clip plays.
// The circumference is read from a per-ring CSS custom property so one
// rule works for any ring size.
export const PREVIEW_RING_KEYFRAMES = `
@keyframes beetbot-preview-ring {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: var(--bb-ring-c); }
}
@keyframes beetbot-page-enter {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}`;

/**
 * Shazam-style countdown ring: a faint full circle with a brighter arc
 * on top that depletes over PREVIEW_SECONDS via the CSS keyframe above.
 * Pure CSS so it animates on the compositor — no per-frame React state,
 * even with a full page of results. Absolutely positioned to overlay
 * whatever it's dropped into (album art, a track-number badge).
 */
export function PreviewRing({
  size,
  strokeWidth = 3,
}: {
  size: number;
  strokeWidth?: number;
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0 m-auto -rotate-90 pointer-events-none"
      aria-hidden
    >
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="#34d399"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        style={{
          strokeDasharray: c,
          // Consumed by the keyframe's `to` value.
          ['--bb-ring-c' as string]: String(c),
          animation: `beetbot-preview-ring ${PREVIEW_SECONDS}s linear forwards`,
        }}
      />
    </svg>
  );
}

/** Small grey "E" badge for explicit tracks (Spotify-style). */
export function ExplicitBadge() {
  return (
    <span
      className="shrink-0 inline-grid place-items-center h-[15px] min-w-[15px] px-[3px] rounded-[3px] bg-neutral-700 text-neutral-300 text-[9px] font-bold leading-none"
      title="Explicit"
      aria-label="Explicit"
    >
      E
    </span>
  );
}

/** "55 min" / "1 hr 30 min" from a total milliseconds. */
export function albumDurationLabel(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} hr ${m} min`;
}

/** Format a Deezer release_date ("YYYY-MM-DD", sometimes just a year) as a
 *  human "Month D, YYYY" — Spotify shows this under the album tracklist.
 *  Parses the parts directly to avoid a UTC-midnight timezone shift. */
export function formatReleaseDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(iso.trim());
  if (!m) return '';
  const [, y, mo, d] = m;
  if (!mo || !d) return y; // year-only
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = MONTHS[Number(mo) - 1];
  if (!month) return y;
  return `${month} ${Number(d)}, ${y}`;
}

/** Pretty label for a Deezer `record_type`. */
export function albumTypeLabel(t: string | null): string {
  switch ((t ?? '').toLowerCase()) {
    case 'album':
      return 'Album';
    case 'single':
      return 'Single';
    case 'ep':
      return 'EP';
    case 'compile':
      return 'Compilation';
    default:
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
}

/** Card play buttons: fetch a collection's tracks and start playback from the
 *  first one, so a hovered album/artist card plays without opening its page.
 *  Shared by the search results, the "fans also like" shelf, and the artist /
 *  album detail surfaces. Declared at module scope so callers can pass a bound
 *  `onPlay` inline; failures leave the card untouched. */
export async function playAlbumCard(
  album: SearchAlbumResult,
  token: string,
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void,
) {
  try {
    const list = await getAlbumTracks(album.source_id, token);
    if (list.length) onPlay(list[0], list, 0);
  } catch {
    /* leave the card as-is on failure */
  }
}

export function AlbumGrid({
  albums,
  onOpen,
  onPlay,
  subtitleMode = 'default',
  layout = 'grid',
  activeAlbumName,
  isPlaying,
  onToggle,
}: {
  albums: SearchAlbumResult[];
  onOpen: (a: SearchAlbumResult) => void;
  /** When set, a white play button lifts in on the cover and plays the album
   *  (the card click still opens it) — the Home-card affordance. */
  onPlay?: (a: SearchAlbumResult) => void;
  /**
   * 'default'      → "Artist · 2016" (search / browse, where the artist
   *                  is useful context).
   * 'discography'  → "2016 • Album" (an artist's own page, where the
   *                  artist is redundant — Spotify-style).
   */
  subtitleMode?: 'default' | 'discography';
  /** 'grid' = wrapping grid (search/browse); 'row' = a single horizontal
   *  scroller (Apple-Music artist-page carousels). */
  layout?: 'grid' | 'row';
  /** Now-playing (desktop): the card whose album name matches shows a
   *  persistent play/pause button (Spotify-style), like the Home cards. */
  activeAlbumName?: string | null;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  if (albums.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No albums matched.</div>
    );
  }
  const normName = (s: string) => s.trim().toLowerCase();
  const cards = albums.map((a) => {
        const year = a.release_date ? a.release_date.slice(0, 4) : '';
        const typeLabel =
          subtitleMode === 'discography' ? albumTypeLabel(a.album_type) : '';
        // This card is the active playback source → persistent play/pause.
        const albumActive =
          !!activeAlbumName && normName(a.name) === normName(activeAlbumName);
        return (
          <div
            key={`${a.source}:${a.source_id}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(a)}
            onKeyDown={(e) => {
              // Only the card root answers keys — a bubbled Enter/Space from the
              // nested play button must NOT also open the page.
              if (
                e.target === e.currentTarget &&
                (e.key === 'Enter' || e.key === ' ')
              ) {
                e.preventDefault();
                onOpen(a);
              }
            }}
            className={`group relative cursor-pointer text-left transition active:scale-[0.98] ${
              layout === 'row' ? 'w-36 sm:w-40 shrink-0' : ''
            }`}
          >
            {/* Hover halo — the row carousels match the Home shelves exactly
                (generous -inset-3 rounded-2xl so the whole card lights up); the
                wrapping grid stays horizontal-only so stacked rows don't overlap
                their halos vertically. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute transition-colors duration-200 group-hover:bg-white/[0.06] ${
                layout === 'row'
                  ? '-inset-3 rounded-2xl'
                  : '-inset-x-2 inset-y-0 rounded-xl'
              }`}
            />
            <div className="relative">
              <div className="relative">
                <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
                  {a.cover_url ? (
                    <img
                      src={a.cover_url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-4xl text-neutral-600">♪</span>
                  )}
                </div>
                {onPlay ? (
                  <CardPlayButton
                    label={`Play ${a.name}`}
                    onPlay={albumActive && onToggle ? onToggle : () => onPlay(a)}
                    persistent={albumActive}
                    playing={albumActive && !!isPlaying}
                  />
                ) : null}
              </div>
              <Marquee text={a.name} className="mt-2 text-sm font-medium" />
              <div className="truncate text-xs text-neutral-500">
                {subtitleMode === 'discography' ? (
                  <>
                    {year}
                    {year && typeLabel ? ' • ' : ''}
                    {typeLabel}
                  </>
                ) : (
                  <>
                    {a.artists.join(', ')}
                    {year ? <> · {year}</> : null}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      });
  if (layout === 'row') {
    // Mirror the Home shelves EXACTLY so the cards' -inset-3 hover halo has
    // vertical room instead of being clipped: the scroller keeps py-4 +
    // overflow-y-clip (clips without becoming a scroll container → arrows still
    // work, no stray vertical scroll), and the -my-4 sits on THIS outer wrapper,
    // never the scroller (a negative margin there collapses ShelfRow's arrow
    // box). The arrows' artClass gains mt-4 to re-center on the padded cover.
    return (
      <div className="-my-4">
        <ShelfRow
          artClass="mt-4 h-36 sm:h-40"
          scrollerClassName="flex gap-3 overflow-x-auto overflow-y-clip overscroll-x-contain py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {cards}
        </ShelfRow>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {cards}
    </div>
  );
}

const SHELF_SCROLLER =
  'flex gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

/** Apple-Music-style horizontal shelf: one scrollable row with a rounded
 *  ‹ › button on each side that fades in on hover and only appears when that
 *  direction can still scroll. `artClass` is the artwork's height (e.g.
 *  "h-36 sm:h-40" for albums) so the buttons center on the artwork, not the
 *  taller card; omit it to center on the full row height. `scrollerClassName`
 *  overrides the row's flex/gap. Hidden below `sm` — touch screens swipe.
 *  Exported so the Home shelves share the exact same arrow affordance. */
/** Max width (px) of the row's scrolled-off-edge fade — also the distance over
 *  which it ramps in, so the fade GROWS with the scroll offset. */
const FADE_MAX = 80;

export function ShelfRow({
  artClass,
  scrollerClassName = SHELF_SCROLLER,
  children,
}: {
  artClass?: string;
  scrollerClassName?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // How many px are scrolled off each side, clamped to FADE_MAX. Kept as a
  // continuous amount (not a boolean) so the edge fade eases in as you scroll
  // instead of snapping on at a threshold — the Spotify behaviour.
  const [fade, setFade] = useState({ left: 0, right: 0 });
  // The scrolled-off-edge fade is a desktop mouse affordance (it pairs with the
  // hover scroll arrows). On a touch device — the phone PWA — there's no hover
  // to scroll a row back, so the dimming just reads as cut-off art; skip it.
  const [hoverable, setHoverable] = useState(
    typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover)');
    const on = () => setHoverable(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setFade({
      left: Math.max(0, Math.min(el.scrollLeft, FADE_MAX)),
      right: Math.max(0, Math.min(maxScroll - el.scrollLeft, FADE_MAX)),
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  // `amount` (0..1) = how far this side is scrolled off, so the button eases in
  // with the edge shadow instead of snapping on. On hover it reaches that
  // fraction of full opacity; off hover it's hidden.
  const arrow = (dir: 1 | -1, amount: number) => (
    <div
      className={`pointer-events-none absolute z-10 hidden items-center sm:flex ${
        artClass ? `top-0 ${artClass}` : 'inset-y-0'
      } ${dir < 0 ? 'left-0 justify-start pl-1' : 'right-0 justify-end pr-1'}`}
    >
      <button
        type="button"
        aria-label={dir < 0 ? 'Scroll left' : 'Scroll right'}
        tabIndex={-1}
        onClick={() => page(dir)}
        style={{ '--arrow-op': amount } as React.CSSProperties}
        className={`grid h-16 w-10 place-items-center rounded-2xl bg-neutral-700/80 text-white shadow-xl ring-1 ring-white/10 backdrop-blur-md transition-opacity duration-200 ease-out hover:bg-neutral-600/90 opacity-0 ${
          amount > 0.02
            ? 'pointer-events-auto group-hover/shelf:[opacity:var(--arrow-op)]'
            : 'pointer-events-none'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
          aria-hidden
        >
          <path d={dir < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
        </svg>
      </button>
    </div>
  );

  // Fade the row's scrolled-off edges (Spotify-style): each side's fade width =
  // how far it's scrolled off (fade.left/right), so it eases in as you scroll
  // rather than popping on, and mid-row cards stay full colour. 0 width on a
  // side = no fade there (at rest, at either end).
  const edgeMask =
    hoverable && (fade.left > 0 || fade.right > 0)
      ? `linear-gradient(to right, transparent 0, #000 ${fade.left}px, #000 calc(100% - ${fade.right}px), transparent 100%)`
      : undefined;

  return (
    // Named group ("shelf") so the arrows' group-hover/shelf doesn't collide
    // with the unnamed group-hover the song rows use for their own per-row hover
    // (an unnamed group-hover matches ANY ancestor .group, which would light up
    // every row at once when hovering anywhere in the shelf).
    <div className="group/shelf relative">
      <div
        ref={ref}
        className={scrollerClassName}
        style={edgeMask ? { maskImage: edgeMask, WebkitMaskImage: edgeMask } : undefined}
      >
        {children}
      </div>
      {arrow(-1, fade.left / FADE_MAX)}
      {arrow(1, fade.right / FADE_MAX)}
    </div>
  );
}

/**
 * "Downloaded" indicator — a verified-style seal with a check, shown only for
 * catalog/album tracks whose audio is already on the device (`has_audio`). Its
 * absence means "not downloaded". Mirrors the desktop `TrackRow` badge, which
 * lives in a desktop-only module that can't be imported into this shared file,
 * so it's reimplemented inline here.
 */
export function AlbumDownloadedBadge() {
  // Spotify-style "downloaded / available offline" mark — a green DOWN-ARROW
  // (not a check), so it reads distinctly from the green ✓ that means "in a
  // playlist": ↓ = on this device, ✓ = saved to a playlist.
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

/**
 * Wraps a track row in the swipe-to-action gesture on phone (→ Queue, ← Save),
 * or renders it untouched everywhere else. Kept tiny so the row's children stay
 * in place (no duplication) regardless of which branch renders. The Queue/Save
 * labels + colors mirror the library playlist page so the gesture reads the
 * same across library and catalog.
 */
export function MaybeSwipe({
  enabled,
  onQueue,
  onSave,
  children,
}: {
  enabled: boolean;
  onQueue: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <SwipeRow
      onSwipeRight={onQueue}
      onSwipeLeft={onSave}
      rightAction={{ label: 'Queue', bg: 'bg-neutral-800' }}
      leftAction={{ label: 'Save', bg: 'bg-neutral-100 text-neutral-950' }}
    >
      {children}
    </SwipeRow>
  );
}
