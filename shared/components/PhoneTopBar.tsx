// Shared building blocks for the phone screens' top bars, so the account
// avatar (→ Settings) sits in the exact same top-RIGHT spot on Home, Search and
// Library — matching the desktop, where it has always been the trailing item —
// and every pinned bar uses one frosted treatment.

import { useEffect, useState } from 'react';
import { getProfiles, profileAvatarUrl, type Profile } from '../api';
import { cn } from '../ui';

/** The resolved profile, held across screen mounts.
 *
 *  Home / Search / Library each call `useActiveProfile`, and switching tabs
 *  unmounts one screen and mounts the next. With per-hook state alone that meant
 *  a fresh `null` on every switch — so the avatar rendered its "?" placeholder
 *  for a frame before the (service-worker-cached) fetch resolved, and you'd see
 *  a green "?" blink on every tab change. The answer is the same for every
 *  screen and changes about never, so resolve it once and keep it. */
const activeProfileCache = new Map<number, Profile>();

/** Resolve the active profile object from just its id — the single source for
 *  the header avatar on Home / Search / Library (each screen only knows the
 *  active profile *id*). Falls back to null (a coloured initial) when offline
 *  or the host is asleep. */
export function useActiveProfile(
  token: string,
  activeProfileId: number | null,
): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(() =>
    activeProfileId == null ? null : activeProfileCache.get(activeProfileId) ?? null,
  );
  useEffect(() => {
    let cancelled = false;
    // Re-seed on an id change too: without this, switching profiles would keep
    // showing the previous person's face until the fetch came back.
    setProfile(
      activeProfileId == null ? null : activeProfileCache.get(activeProfileId) ?? null,
    );
    void getProfiles(token)
      .then((ps) => {
        const found = ps.find((p) => p.id === activeProfileId) ?? null;
        // Still refetch on every mount — a photo or name edited on the Mac should
        // land here — but now it corrects a right answer instead of replacing a
        // placeholder.
        if (found) activeProfileCache.set(found.id, found);
        if (!cancelled) setProfile(found);
      })
      .catch(() => {
        /* offline — the avatar just falls back to a coloured initial */
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId]);
  return profile;
}

/** Frosted background for a pinned (sticky) phone header row. Opaque enough
 *  that content scrolling underneath reads as muted, not cluttered. */
export const STICKY_FROST = 'bg-neutral-950/80 backdrop-blur-xl';

/** The account avatar that opens Settings — identical on every phone screen so
 *  Settings lives in the same top-right spot app-wide. Shows the profile photo,
 *  else a coloured initial.
 *
 *  The circle is sized against the h1 it sits beside (1.75rem to the title's
 *  1.25rem — about 1.4×) so it reads as chrome next to the heading rather than
 *  competing with it. That's smaller than a finger, so the BUTTON stays 44px via
 *  padding while the visible circle stays 28px; the negative margins hand the
 *  padding back to the layout, so the header lays out around the circle and the
 *  trailing edge lines up with the row's own px-4. */
export function SettingsAvatar({
  profile,
  token,
  onOpenSettings,
  className,
}: {
  profile: Profile | null;
  token: string;
  onOpenSettings: () => void;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpenSettings}
      aria-label="Settings"
      title={profile?.name ?? 'Account'}
      className={cn('-my-2 -mr-2 shrink-0 p-2 transition active:scale-95', className)}
    >
      <span className="relative grid h-7 w-7 place-items-center overflow-hidden rounded-full text-xs shadow">
        {/* The coloured initial is always the base layer, with the photo laid
            over it — so a photo that's still loading (or that fails) reveals
            this profile's own colour rather than a hole, instead of swapping one
            visual for another mid-load. */}
        <span
          className="grid h-full w-full place-items-center font-bold text-neutral-950"
          style={{ backgroundColor: profile?.avatar_color ?? '#10b981' }}
        >
          {(profile?.name?.trim()?.[0] ?? '?').toUpperCase()}
        </span>
        {profile?.avatar_path && !broken && (
          <img
            src={profileAvatarUrl(profile.id, token)}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </span>
    </button>
  );
}
