import { useCallback, useEffect, useState } from 'react';
import {
  getCachedTrackIds,
  getProfiles,
  getStorageEstimate,
  offlineCacheAvailable,
  profileAvatarUrl,
  type Profile,
} from '@shared/api';
import { cn, BAR } from '@shared/ui';
import { ChevronRight, Group, Row, Toggle } from '@shared/components/SettingsKit';
import { SharingPeoplePanel } from '@shared/components/SharingPeoplePanel';
import { getSharedPeople, getSharingStatus } from '@shared/sharing';
import { InstallSheet } from './InstallSheet';
import { EditProfileScreen } from './EditProfileScreen';
import { OfflineSongsScreen } from './OfflineSongsScreen';
import { isStandalone } from '../lib/install';
import { usePlayerStore } from '../store';

/**
 * Phone Settings — an iOS-style grouped list, built from the same shared
 * primitives as the desktop page (`@shared/components/SettingsKit`), so a
 * setting looks native in either shell. Only phone-relevant rows live here:
 * the account (who you're listening as), the one playback preference the web
 * player supports, offline storage for this device, and disconnecting it.
 * Everything else (library, sharing, host config) stays in the desktop app.
 *
 * Storage lives HERE rather than on the library screen, where it used to sit
 * as a banner above the content: it is maintenance, not something to browse,
 * and "Clear all" is a destructive control that has no business one tap from
 * a list you scroll every day. The songs it counts are browsable instead, via
 * the library's Offline chip. This mirrors the desktop, which has always kept
 * its Storage section in Settings and its Downloaded tab in the library.
 */
/** Byte formatter for the storage row. Moved here with the row it serves —
 *  it was in LibraryScreen, which no longer reports storage. */
function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

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
  // What this device is holding offline. Read on mount and after a clear —
  // the numbers come from Cache Storage itself, not from a running total, so
  // they cannot drift away from what is really there.
  const [cached, setCached] = useState(0);
  const [usage, setUsage] = useState<number | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  // Bumped when the photo changes, and appended to the card's image URL: the
  // avatar URL is stable per profile, so nothing would refetch it otherwise.
  const [avatarNonce, setAvatarNonce] = useState(0);
  // Apply what the editor changed, rather than re-reading it. `/api/profiles`
  // is a read-only GET and the service worker serves those
  // stale-while-revalidate — a refetch here hands back the name you just
  // replaced, which is exactly what it did before this was written down.
  const applyProfileChange = useCallback(
    (change: { name?: string; hasPhoto?: boolean }) => {
      setActive((prev) =>
        prev
          ? {
              ...prev,
              ...(change.name != null ? { name: change.name } : {}),
              ...(change.hasPhoto != null
                ? { avatar_path: change.hasPhoto ? (prev.avatar_path ?? 'set') : null }
                : {}),
            }
          : prev,
      );
      if (change.hasPhoto != null) {
        setAvatarBroken(false);
        setAvatarNonce((n) => n + 1);
      }
    },
    [],
  );
  // Whether sharing exists for this viewer at all, and how many people have
  // access — the row's own state line. Read here rather than lifted out of
  // SharingPeoplePanel so the panel stays a self-contained screen; both use
  // the same two endpoints, and the row simply does not render when the panel
  // would render nothing.
  const [canShare, setCanShare] = useState(false);
  const [sharedCount, setSharedCount] = useState<number | null>(null);
  const readSharing = useCallback(async () => {
    try {
      const status = await getSharingStatus(token);
      setCanShare(status.canManage);
      if (!status.canManage) return;
      const { people } = await getSharedPeople(token);
      setSharedCount(people.filter((x) => !x.isOwner).length);
    } catch {
      /* offline or no provider — the row just stays hidden */
    }
  }, [token]);
  useEffect(() => {
    void readSharing();
  }, [readSharing]);
  // Disconnecting costs a pairing code to undo, so it arms like the delete
  // below it rather than firing on one tap.
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const handleDisconnect = useCallback(async () => {
    if (!disconnectArmed) {
      setDisconnectArmed(true);
      window.setTimeout(() => setDisconnectArmed(false), 4000);
      return;
    }
    setDisconnectArmed(false);
    onDisconnect();
  }, [disconnectArmed, onDisconnect]);
  const readStorage = useCallback(async () => {
    if (!offlineCacheAvailable()) return;
    const [ids, est] = await Promise.all([getCachedTrackIds(), getStorageEstimate()]);
    setCached(ids.size);
    setUsage(est ? est.usage : null);
  }, []);
  useEffect(() => {
    void readStorage();
  }, [readStorage]);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  // Two-step delete: the first tap arms the button (with the real
  // consequences spelled out), the second tap within the window commits.
  // Steadier on a phone than a native confirm(), and impossible to trigger
  // with a single stray touch.

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

  // The offline collection takes over the whole screen, the way Stats does
  // from its own row — Back returns here, and the storage numbers are re-read
  // on the way out because a clear may have happened in there.
  if (showEdit && active) {
    return (
      <EditProfileScreen
        profile={active}
        token={token}
        onBack={() => setShowEdit(false)}
        onDeleted={onSwitchProfile}
        onSaved={applyProfileChange}
      />
    );
  }

  // Sharing gets its own screen: the panel explains itself at length, and that
  // explanation belongs where you are actually inviting somebody.
  if (showPeople) {
    return (
      <div className="min-h-full text-neutral-100">
        <header
          className={cn(
            BAR,
            'sticky top-0 z-10 flex items-center gap-3 border-b px-3 py-3',
          )}
        >
          <button
            type="button"
            onClick={() => {
              setShowPeople(false);
              void readSharing();
            }}
            aria-label="Back"
            className="grid h-9 w-9 place-items-center rounded-full active:bg-neutral-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1 className="text-xl font-bold tracking-tight">People</h1>
        </header>
        <div className="px-4 pt-5 pb-12">
          <SharingPeoplePanel />
        </div>
      </div>
    );
  }

  if (showOffline) {
    return (
      <OfflineSongsScreen
        token={token}
        profileId={profileId}
        onBack={() => {
          setShowOffline(false);
          void readStorage();
        }}
      />
    );
  }

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
        {/* Who you are — and the way to change it. */}
        <Group>
          <button
            type="button"
            onClick={() => setShowEdit(true)}
            disabled={!active}
            // `-mx-1 px-1` mirrors SettingsKit's own clickable Row wrapper: without
            // it this card's content sits 8px right of every row beneath it, and
            // the chevrons visibly fail to line up.
            className="-mx-1 flex w-full items-center gap-3 rounded-lg px-1 text-left active:opacity-70 disabled:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl text-lg shadow">
              {active?.avatar_path && !avatarBroken ? (
                <img
                  // The nonce is appended ONLY once a photo has changed. At
                  // rest the URL must match what the app preloads (App.tsx)
                  // and what the top bar and gate render — a distinct URL
                  // means a separate fetch for the largest avatar on screen,
                  // which is a visible wait over the tunnel and free to avoid.
                  src={
                    avatarNonce > 0
                      ? `${profileAvatarUrl(active.id, token)}&v=${avatarNonce}`
                      : profileAvatarUrl(active.id, token)
                  }
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
            {/* Just the name. "Listening on this device" was stating the
                obvious — it is your phone, and the profile is the one you are
                using. */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-100">
                {active?.name ?? 'Your profile'}
              </p>
            </div>
            {/* The shared chevron, not a text glyph: a "›" sits on the text
                baseline at a different size, so it read smaller than — and out
                of line with — the chevron on the row directly below. */}
            {active && <ChevronRight className="shrink-0 text-neutral-500" />}
          </button>
          {/* Switching sits with the face it switches away from — both are
              about who is listening, not about the app. */}
          <Row divider label="Switch profile" chevron onClick={onSwitchProfile} />
        </Group>

        {/* Places to go. Each row states what it is and what it holds; the
            explaining happens on the screen it opens, not here. */}
        <Group>
          <Row label="Listening stats" chevron onClick={onOpenStats} />
          {offlineCacheAvailable() && (
            <Row
              divider
              label="Saved offline"
              secondary={
                cached === 0
                  ? 'Nothing saved yet'
                  : `${cached} ${cached === 1 ? 'song' : 'songs'}${usage != null ? ` · ${formatBytes(usage)}` : ''}`
              }
              chevron
              onClick={() => setShowOffline(true)}
            />
          )}
          {/* Only for the owner of a build that can share at all — a guest's
              phone shows no trace of it, matching the panel behind it. */}
          {canShare && (
            <Row
              divider
              label="People"
              secondary={
                sharedCount == null
                  ? ' '
                  : sharedCount === 0
                    ? 'Nobody else yet'
                    : `${sharedCount} ${sharedCount === 1 ? 'person' : 'people'}`
              }
              chevron
              onClick={() => setShowPeople(true)}
            />
          )}
        </Group>

        <Group>
          <Row
            label="Autoplay"
            secondary="Keep playing similar music"
            control={
              <Toggle checked={autoplay} onChange={setAutoplay} ariaLabel="Autoplay" />
            }
          />
          {!isStandalone() && (
            <Row
              divider
              label="Add to home screen"
              secondary="Opens like an app"
              chevron
              onClick={() => setShowInstall(true)}
            />
          )}
        </Group>

        {/* Only what belongs to this handset. Deleting the profile moved onto
            the profile itself, where the name and face make it obvious which
            one is about to go. */}
        <Group>
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            className="w-full text-left text-sm font-medium text-red-400 active:opacity-70"
          >
            {disconnectArmed ? 'Tap again to disconnect' : 'Disconnect this device'}
          </button>
          {disconnectArmed && (
            <p className="mt-1 text-xs text-neutral-400">
              This phone will ask for a pairing code next time.
            </p>
          )}
        </Group>
      </div>
    </div>
  );
}
