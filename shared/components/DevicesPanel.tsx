import { trackArtUrl, type NowPlayingInfo, type RemoteAction, type RemoteDevice } from '../api';
import { BEET_LIVE, cn } from '../ui';

/**
 * The device list, rendered INSIDE the player bar rather than as a modal over
 * the page — tapping Devices grows the bar upward to reveal it, and tapping
 * again collapses it. One continuous surface: the thing you were looking at
 * gets taller, instead of a separate window appearing on top of it.
 *
 * Deliberately NOT Spotify Connect's "one stream that moves". Beetbot is a
 * household server, so two devices genuinely can play different music at once.
 * This panel never takes your music away: it shows the others and lets you
 * steer one (transport, right on its row) or pull its music over ("Play here",
 * a handoff that pauses it there). The bar below keeps playing throughout.
 */
export function DevicesPanel({
  devices,
  token,
  onCommand,
  onPlayHere,
  onOpenDevice,
}: {
  devices: RemoteDevice[];
  /** This device's token — another device's artwork is fetched with OUR
   *  credential, never theirs. */
  token: string;
  /** Send a transport command to another device. */
  onCommand: (deviceId: string, action: RemoteAction) => void;
  /** Pull that device's queue + playhead onto this one. */
  onPlayHere: (deviceId: string) => void;
  /** Open the full now-playing screen for that device (tap its artwork). */
  onOpenDevice: (device: RemoteDevice) => void;
}) {
  // `GET /api/devices` already omits the caller, so every row here is someone
  // else. Playing devices first — that's what you opened this to reach.
  const rows = [...devices].sort(
    (a, b) =>
      Number(!!b.now_playing?.is_playing) - Number(!!a.now_playing?.is_playing) ||
      a.label.localeCompare(b.label),
  );

  // The hub names devices from the hostname / User-Agent, which still can't
  // tell two iPhones apart. Number them only when names actually collide — a
  // tag on a household's only phone would be noise. Numbering beats slicing
  // the device id: an id tail is meaningless to a human and can read as a
  // word ("sim-computer" → "uter"). Order is by id so the numbers are stable
  // across polls rather than shuffling as playback state changes.
  const counts = new Map<string, number>();
  for (const d of rows) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  // Stable ordinals, assigned by device id so the numbers don't shuffle as
  // playback state reorders the rows between polls.
  const ordinals = new Map<string, number>();
  const nextFor = new Map<string, number>();
  for (const d of [...rows].sort((a, b) => a.device_id.localeCompare(b.device_id))) {
    if ((counts.get(d.label) ?? 0) > 1) {
      const n = (nextFor.get(d.label) ?? 0) + 1;
      nextFor.set(d.label, n);
      ordinals.set(d.device_id, n);
    }
  }
  const displayName = (d: RemoteDevice) => {
    const n = ordinals.get(d.device_id);
    return n ? `${d.label} (${n})` : d.label;
  };

  return (
    // Padding lives on the CONTENT, not this wrapper: with it here, every row
    // rule stopped 12px short of the card edge while this element's own bottom
    // border ran the full width — two different-looking lines in one card.
    <div className="pt-2.5 pb-0.5 border-b border-white/10">
      <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wide text-neutral-400">
        Devices
      </div>

      {rows.length === 0 && (
        <div className="px-3 pb-2.5 text-xs text-neutral-400">
          No other devices right now.
        </div>
      )}

      {rows.map((d) => {
        const np = d.now_playing ?? null;
        const name = displayName(d);
        return (
          // Same column rhythm as the track row below: artwork, text, then the
          // two trailing controls at the bar's own widths — so every play
          // button in this card sits on one vertical line, and "play here"
          // lands exactly where the Devices button is.
          <div key={d.device_id} className="border-t border-white/10">
            <div className="px-3 py-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => onOpenDevice(d)}
              aria-label={`Now playing on ${name}`}
              className="shrink-0 rounded-lg overflow-hidden active:opacity-80"
            >
              <DeviceArt nowPlaying={np} kind={d.kind} token={token} />
            </button>

            <button
              type="button"
              onClick={() => onOpenDevice(d)}
              className="min-w-0 flex-1 text-left active:opacity-80"
            >
              {/* Tinted while that device is actually playing — the one
                  glanceable "this is the live one" cue, now that the row no
                  longer prefixes the track with a status glyph.
                  Deliberately the SAME fixed green as the Devices button's
                  dot, not var(--color-accent): the accent is extracted from
                  album art, so on a monochrome cover it resolves to grey and
                  the cue vanishes exactly when you need it. Status colour has
                  to mean one thing every time. */}
              <div
                className="text-sm font-medium truncate leading-tight"
                style={np?.is_playing ? { color: BEET_LIVE } : undefined}
              >
                {name}
              </div>
              {/* No ▶/❙❙ prefix here. The trailing button already IS the
                  state — a play triangle means "paused, tap to resume" — and
                  the two glyphs are opposites, so showing both read as a
                  contradiction. The track row below states it the same way:
                  title, artist, and the button carries the rest. */}
              <div className="text-xs text-neutral-400 truncate leading-tight">
                {np
                  ? `${np.title}${np.artists.length ? ` · ${np.artists.join(', ')}` : ''}`
                  : 'Nothing playing'}
              </div>
            </button>

            {np && (
              <>
                {/* Aligned under the bar's Devices button. */}
                <button
                  type="button"
                  onClick={() => onPlayHere(d.device_id)}
                  aria-label={`Play ${name}'s music here`}
                  title={`Play ${name}'s music here`}
                  className="h-11 w-9 shrink-0 grid place-items-center text-neutral-200 active:scale-90 transition"
                >
                  {/* Play INSIDE a device. Every arrow-into-a-container I
                      tried — tray or phone — reads as "download", which
                      promises the wrong thing entirely. This is as wide as the
                      Devices glyph beside it, so it doesn't look like the
                      smaller button either. */}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="2.5" y="5" width="19" height="13" rx="2.5" />
                    <path d="M5.5 21h13" />
                    <path d="M10.5 9.2v4.6l4-2.3z" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                {/* Aligned under the bar's play button. No prev/next here —
                    the bar itself carries only play, and the full screen (tap
                    the artwork) is where skipping lives. */}
                <button
                  type="button"
                  onClick={() => onCommand(d.device_id, np.is_playing ? 'pause' : 'play')}
                  aria-label={`${np.is_playing ? 'Pause' : 'Play'} on ${name}`}
                  className="h-11 w-11 shrink-0 grid place-items-center text-white active:scale-90 transition"
                >
                  {np.is_playing ? (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              </>
            )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The album cover of what that device is playing, with the device glyph as the
 * fallback. Art comes from the track id signed with OUR token — `album_art_url`
 * is null for most library tracks, which is why a device row used to show a
 * bare laptop icon while music was clearly playing on it.
 */
function DeviceArt({
  nowPlaying,
  kind,
  token,
}: {
  nowPlaying: NowPlayingInfo | null;
  kind: string;
  token: string;
}) {
  const src =
    nowPlaying?.track_id != null
      ? trackArtUrl(nowPlaying.track_id, token)
      : (nowPlaying?.album_art_url ?? null);
  if (src) {
    return (
      // `block` matters: as a flex child this span was blockified for free,
      // but inside the artwork button it is a plain inline span, where width
      // and height simply do not apply — the cover rendered at full size.
      <span className="block h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-neutral-800">
        <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
      </span>
    );
  }
  return <DeviceIcon kind={kind} active={!!nowPlaying?.is_playing} />;
}

/** Laptop vs phone glyph — the fallback when there's no cover to show. */
function DeviceIcon({ kind, active }: { kind: string; active: boolean }) {
  const cls = cn(
    'h-9 w-9 shrink-0 grid place-items-center rounded-lg',
    active ? 'text-neutral-950' : 'bg-white/10 text-neutral-300',
  );
  return (
    <span
      className={cls}
      style={active ? { backgroundColor: BEET_LIVE } : undefined}
      aria-hidden
    >
      {kind === 'desktop' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M2 20h20" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <path d="M11 18.5h2" />
        </svg>
      )}
    </span>
  );
}
