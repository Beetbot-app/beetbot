import { useEffect, useRef, useState } from 'react';
import {
  deleteProfile,
  getProfiles,
  profileAvatarUrl,
  type Profile,
} from '@shared/api';
import { cn, BAR } from '@shared/ui';
import { Group, Row, Toggle } from '@shared/components/SettingsKit';
import { SharingPeoplePanel } from '@shared/components/SharingPeoplePanel';
import { InstallSheet } from './InstallSheet';
import { isStandalone } from '../lib/install';
import { usePlayerStore } from '../store';

/**
 * Phone Settings — an iOS-style grouped list, built from the same shared
 * primitives as the desktop page (`@shared/components/SettingsKit`), so a
 * setting looks native in either shell. Only phone-relevant rows live here:
 * the account (who you're listening as), the one playback preference the web
 * player supports, and disconnecting this device. Everything else (library,
 * sharing, host config) stays in the desktop app.
 */
export function SettingsScreen({
  token,
  profileId,
  onBack,
  onSwitchProfile,
  onOpenStats,
  onDisconnect,
}: {
  token: string;
  profileId: number | null;
  onBack: () => void;
  onSwitchProfile: () => void;
  /** Open the listening-stats ("Wrapped") screen. */
  onOpenStats: () => void;
  onDisconnect: () => void;
}) {
  // The active profile's name + avatar, so Settings shows who you are. Fetched
  // from the same list the "Who's listening?" gate uses; if it's offline the
  // action buttons below still work (they don't need this).
  const [active, setActive] = useState<Profile | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  // Re-opening the home-screen instructions on demand, after the first-visit
  // sheet has been dismissed.
  const [showInstall, setShowInstall] = useState(false);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  // Two-step delete: the first tap arms the button (with the real
  // consequences spelled out), the second tap within the window commits.
  // Steadier on a phone than a native confirm(), and impossible to trigger
  // with a single stray touch.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    [],
  );

  const handleDeleteProfile = async () => {
    if (profileId == null || deleteBusy) return;
    setDeleteError(null);
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 6_000);
      return;
    }
    setDeleteBusy(true);
    try {
      await deleteProfile(profileId, token);
      // The profile is gone and the server unbound this session — hand the
      // user back to "Who's listening?".
      onSwitchProfile();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleteArmed(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  useEffect(() => {
    let on = true;
    getProfiles(token)
      .then((ps) => {
        if (on) setActive(ps.find((p) => p.id === profileId) ?? null);
      })
      .catch(() => {
        /* offline / host asleep — nothing to show, buttons still work */
      });
    return () => {
      on = false;
    };
  }, [token, profileId]);

  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <header
        className={cn(BAR, 'sticky top-0 z-10 flex items-center gap-3 border-b px-3 py-3')}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-9 w-9 place-items-center rounded-full active:bg-neutral-800"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
      </header>

      {showInstall && <InstallSheet forced onClose={() => setShowInstall(false)} />}

      <div className="px-4 pt-5 pb-12">
        {/* Account — identity + switch profile */}
        <Group label="Account">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl text-lg shadow">
              {active?.avatar_path && !avatarBroken ? (
                <img
                  src={profileAvatarUrl(active.id, token)}
                  alt=""
                  draggable={false}
                  onError={() => setAvatarBroken(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span
                  className="grid h-full w-full place-items-center font-bold text-neutral-950"
                  style={{ backgroundColor: active?.avatar_color ?? '#10b981' }}
                >
                  {(active?.name?.trim()?.[0] ?? '?').toUpperCase()}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-100">
                {active?.name ?? 'Your profile'}
              </p>
              <p className="text-xs text-neutral-500">Listening on this device</p>
            </div>
          </div>
          <Row divider label="Listening stats" chevron onClick={onOpenStats} />
          <Row divider label="Switch profile" chevron onClick={onSwitchProfile} />
        </Group>

        {/* Add to home screen. Hidden once it already is — there is nothing left
            to suggest, and offering it would read as "this didn't work". */}
        {!isStandalone() && (
          <Group
            label="This device"
            footer="Opens like an app, and keeps playing when your screen locks."
          >
            <Row
              label="Add to home screen"
              chevron
              onClick={() => setShowInstall(true)}
            />
          </Group>
        )}

        {/* Playback — the one preference the web player carries */}
        <Group
          label="Playback"
          footer="When a playlist or song ends, keep going with similar music."
        >
          <Row
            label="Autoplay"
            control={
              <Toggle checked={autoplay} onChange={setAutoplay} ariaLabel="Autoplay" />
            }
          />
        </Group>

        {/* Who else can open this server. Renders nothing unless the person
            looking at it is the owner AND the host build supplies a sharing
            provider — so a guest's phone shows no trace of it. Same panel the
            desktop shows. */}
        <SharingPeoplePanel />

        {/* Destructive actions — set apart */}
        <Group
          footer={
            deleteError ??
            'Deleting removes this profile, its playlists and listening history from the Beetbot server — for every device. Profiles can also be managed in the desktop app. Disconnecting asks for a pairing code next time.'
          }
        >
          <button
            type="button"
            disabled={deleteBusy || profileId == null}
            onClick={() => void handleDeleteProfile()}
            className="w-full text-left text-sm font-medium text-red-400 active:opacity-70 disabled:opacity-50"
          >
            {deleteBusy
              ? 'Deleting…'
              : deleteArmed
                ? `Really delete ${active?.name ?? 'this profile'}? Tap again`
                : 'Delete this profile'}
          </button>
          <div className="mt-3 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={onDisconnect}
              className="w-full text-left text-sm font-medium text-red-400 active:opacity-70"
            >
              Disconnect this device
            </button>
          </div>
        </Group>
      </div>
    </div>
  );
}
