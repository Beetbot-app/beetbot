import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ipc, type Profile } from '@/lib/tauri';

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
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc
      .listProfiles()
      .then((ps) => {
        if (!cancelled) setProfile(ps.find((p) => p.id === profileId) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  return (
    <header className="absolute top-0 left-0 right-0 z-40 h-14">
      {/* Drag layer — lets you move the window by the bar's empty space. The
          control groups below are `pointer-events-none` so a click on their
          EMPTY area (around the search bar, gaps, etc.) falls through to this
          layer and drags the window; only the actual controls re-enable
          pointer events. The native traffic lights overlay the top-left
          (titleBarStyle: Overlay). */}
      <div data-tauri-drag-region className="absolute inset-0" />

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
  onSettings,
  onOpenStats,
  onSwitchProfile,
}: {
  profile: Profile | null;
  onSettings: () => void;
  onOpenStats: () => void;
  onSwitchProfile: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
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
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 top-full mt-2 z-50 w-48 rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl py-1">
            <MenuRow
              onClick={() => {
                setOpen(false);
                onOpenStats();
              }}
            >
              Listening stats
            </MenuRow>
            <MenuRow
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              Settings
            </MenuRow>
            <MenuRow
              onClick={() => {
                setOpen(false);
                onSwitchProfile();
              }}
            >
              Switch profile
            </MenuRow>
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuRow({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition"
    >
      {children}
    </button>
  );
}
