import { useEffect, useState } from 'react';
import { getProfiles, profileAvatarUrl, type Profile } from '@shared/api';
import { cn, BAR } from '@shared/ui';
import { Group, Row, Toggle } from '@shared/components/SettingsKit';
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
  onDisconnect,
}: {
  token: string;
  profileId: number | null;
  onBack: () => void;
  onSwitchProfile: () => void;
  onDisconnect: () => void;
}) {
  // The active profile's name + avatar, so Settings shows who you are. Fetched
  // from the same list the "Who's listening?" gate uses; if it's offline the
  // action buttons below still work (they don't need this).
  const [active, setActive] = useState<Profile | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);

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
          <Row divider label="Switch profile" chevron onClick={onSwitchProfile} />
        </Group>

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

        {/* Device — destructive, set apart */}
        <Group footer="Profiles are created and edited in the Beetbot desktop app. Disconnecting asks for a pairing code next time.">
          <button
            type="button"
            onClick={onDisconnect}
            className="w-full text-left text-sm font-medium text-red-400 active:opacity-70"
          >
            Disconnect this device
          </button>
        </Group>
      </div>
    </div>
  );
}
