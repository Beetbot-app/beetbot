import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ipc, type Profile } from '@/lib/tauri';
import { useProfilesVersion } from '@shared/profilesChanged';
import { useProfileStore } from '@/lib/profile';

/**
 * Persistent top bar (Spotify-style). The window uses an overlaid title bar
 * (`titleBarStyle: Overlay`), so this bar IS the title area: the whole header is
 * a drag region (a layer behind the controls), the native traffic lights float
 * over its top-left, and the Home button + centered search + account menu sit on
 * top. The search input itself lives in the shared `SearchScreen` (overlay mode)
 * and portals into `barSlotRef`.
 */
export function TopBar({
  homeActive,
  homeBadge,
  onHome,
  onSettings,
  onOpenStats,
  onBack,
  onForward,
  canBack,
  canForward,
  profileId,
  onSwitchProfile,
  barSlotRef,
}: {
  homeActive: boolean;
  homeBadge?: boolean;
  onHome: () => void;
  onSettings: () => void;
  onOpenStats: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  profileId: number;
  onSwitchProfile: () => void;
  /** Callback ref for the search-bar portal target. */
  barSlotRef: (el: HTMLDivElement | null) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Re-read when a profile may have changed elsewhere — including on a phone,
  // which writes over HTTP and is otherwise invisible to this window.
  const profilesVersion = useProfilesVersion();
  useEffect(() => {
    let cancelled = false;
    ipc
      .listProfiles()
      .then((ps) => {
        if (!cancelled) setProfiles(ps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileId, profilesVersion]);
  const profile = profiles.find((p) => p.id === profileId) ?? null;

  return (
    // z-[45]: ABOVE a page overlay (the search/artist/album drill-in is z-40),
    // so the account dropdown — which hangs down from the avatar into that
    // overlay's region — paints over it instead of behind. Still BELOW the
    // full-screen Now Playing view and modal scrims (z-50), which should cover
    // the bar. Before this, the bar and the overlay were both z-40, so on any
    // search/artist page the dropdown opened but was hidden behind the overlay.
    <header className="absolute top-0 left-0 right-0 z-[45] h-14">
      {/* Drag layer — lets you move the window by the bar's empty space. The
          control groups below are `pointer-events-none` so a click on their
          EMPTY area (around the search bar, gaps, etc.) falls through to this
          layer and drags the window; only the actual controls re-enable
          pointer events. The native traffic lights overlay the top-left
          (titleBarStyle: Overlay). */}
      {/* A plain CLICK on the empty bar (no drag) dismisses an open search —
          the drag region eats mousedown natively, but click still fires. The
          shared SearchScreen listens for this and closes its dropdown / steps
          out of results. A drag (mousedown + move) doesn't fire click, so window
          dragging is unaffected. */}
      <div
        data-tauri-drag-region
        className="absolute inset-0"
        onClick={() => window.dispatchEvent(new Event('beetbot:dismiss-search'))}
      />

      {/* Back / forward — just past the traffic lights, like Spotify. */}
      <div className="pointer-events-none absolute left-[84px] top-1/2 -translate-y-1/2 flex items-center gap-1">
        <NavArrow dir="back" disabled={!canBack} onClick={onBack} />
        <NavArrow dir="forward" disabled={!canForward} onClick={onForward} />
      </div>

      {/* Home + search, centered in the window like Spotify. The group itself
          is pointer-events-none so its empty padding/gaps drag the window;
          the Home button and the search bar re-enable pointer events. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2">
        <button
          type="button"
          onClick={onHome}
          aria-label="Home"
          title="Home"
          className={`relative pointer-events-auto h-9 w-9 shrink-0 grid place-items-center rounded-full transition ${
            homeActive
              ? 'bg-white/10 text-neutral-100'
              : 'text-neutral-300 hover:text-neutral-100 hover:bg-white/10'
          }`}
        >
          {homeBadge && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-white ring-2 ring-neutral-950" />
          )}
          <svg
            width={19}
            height={19}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 11.5 12 4l9 7.5" />
            <path d="M5 10v10h14V10" />
          </svg>
        </button>
        {/* The search bar portals in here. `[&>div]:mb-0` kills the inline-page
            bottom margin so the input centres in the bar. */}
        <div
          ref={barSlotRef}
          className="pointer-events-auto w-[28rem] max-w-[44vw] [&>div]:mb-0"
        />
      </div>

      {/* Account menu (avatar only, like Spotify). Not a drag pass-through: it's
          tiny, and its dropdown/backdrop need pointer events. */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2">
        <AccountMenu
          profile={profile}
          profiles={profiles}
          onSettings={onSettings}
          onOpenStats={onOpenStats}
          onSwitchProfile={onSwitchProfile}
        />
      </div>
    </header>
  );
}

function NavArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: 'back' | 'forward';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'back' ? 'Back' : 'Forward'}
      className={`pointer-events-auto h-8 w-8 grid place-items-center rounded-full transition ${
        disabled
          ? 'text-neutral-700 cursor-default'
          : 'text-neutral-300 hover:text-neutral-100 hover:bg-neutral-900'
      }`}
    >
      <svg
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {dir === 'back' ? (
          <path d="m15 18-6-6 6-6" />
        ) : (
          <path d="m9 18 6-6-6-6" />
        )}
      </svg>
    </button>
  );
}

function AccountMenu({
  profile,
  profiles,
  onSettings,
  onOpenStats,
  onSwitchProfile,
}: {
  profile: Profile | null;
  profiles: Profile[];
  onSettings: () => void;
  onOpenStats: () => void;
  onSwitchProfile: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  // Inline profile switch: no PIN → set active directly; PIN-locked → route to
  // the full picker (which owns PIN entry) so the hash never touches this menu.
  const switchTo = (p: Profile) => {
    setOpen(false);
    if (p.id === profile?.id) return;
    if (p.has_pin) onSwitchProfile();
    else setActiveProfile(p.id);
  };
  // Close on an outside click or Escape. A `fixed inset-0` backdrop can't be
  // used here: the top bar's backdrop-blur makes it the containing block for
  // fixed descendants, so the backdrop would only cover the bar and clicks
  // below it would miss. A document listener is stacking-context-proof.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={profile ? `${profile.name} — account` : 'Account'}
        aria-label="Account menu"
        aria-expanded={open}
        className="h-8 w-8 shrink-0 rounded-full overflow-hidden grid place-items-center text-xs font-bold text-neutral-950 ring-0 hover:ring-2 hover:ring-neutral-700 transition"
      >
        {profile?.avatar_path ? (
          <img
            src={convertFileSrc(profile.avatar_path)}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className="h-full w-full grid place-items-center"
            style={{ backgroundColor: profile?.avatar_color ?? '#3f3f46' }}
          >
            {profile?.name.trim().charAt(0).toUpperCase() || '?'}
          </span>
        )}
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-2 z-50 w-60 rounded-xl border border-neutral-800 bg-neutral-900 shadow-xl py-1.5 text-sm">
          {profiles.length > 0 && (
            <>
              {profiles.map((p) => {
                const current = p.id === profile?.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => switchTo(p)}
                    className="flex w-full items-center gap-3 px-2.5 py-1.5 text-left hover:bg-neutral-800 transition"
                  >
                    <ProfileAvatar profile={p} />
                    <span className="flex-1 min-w-0 truncate text-neutral-100">
                      {p.name}
                    </span>
                    {current ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-emerald-400" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : p.has_pin ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-500" aria-hidden>
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}
              <div className="my-1 mx-2 h-px bg-neutral-800" />
            </>
          )}
          <MenuRow
            icon={
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            }
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            Settings
          </MenuRow>
          <MenuRow
            icon={
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="20" x2="12" y2="10" />
                <line x1="18" y1="20" x2="18" y2="4" />
                <line x1="6" y1="20" x2="6" y2="16" />
              </svg>
            }
            onClick={() => {
              setOpen(false);
              onOpenStats();
            }}
          >
            Listening stats
          </MenuRow>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({
  children,
  icon,
  onClick,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-2.5 py-1.5 text-left text-neutral-200 hover:bg-neutral-800 transition"
    >
      {icon ? (
        <span className="grid h-7 w-7 shrink-0 place-items-center text-neutral-400" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </button>
  );
}

/** Small round profile avatar (photo, or colour + initial) — matches the sidebar. */
function ProfileAvatar({ profile }: { profile: Profile }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full text-[11px] font-bold text-neutral-950">
      {profile.avatar_path ? (
        <img
          src={convertFileSrc(profile.avatar_path)}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <span
          className="grid h-full w-full place-items-center"
          style={{ backgroundColor: profile.avatar_color }}
        >
          {profile.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
      )}
    </span>
  );
}
