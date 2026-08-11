import { useEffect, useRef, useState } from 'react';
import {
  clearProfileAvatar,
  deleteProfile,
  profileAvatarUrl,
  renameProfile,
  setProfileAvatar,
  type Profile,
} from '@shared/api';
import { cn, BAR } from '@shared/ui';
import { notifyProfilesChanged } from '@shared/profilesChanged';

/**
 * Edit your own profile from the phone: the name, and the photo.
 *
 * Until now the phone could *delete* a profile but not rename it — everything
 * else lived in desktop-only Tauri commands. The hub grew `PATCH
 * /api/profiles/{id}` and `POST|DELETE /api/profiles/{id}/avatar` for this,
 * authorized the same way the self-serve delete is: the desktop owner may edit
 * any profile, a paired device only the one its session is bound to.
 *
 * The colour is deliberately not editable here. It is picked when the profile
 * is created, it only shows when there is no photo, and a picker for it would
 * be a third control on a screen whose whole point is that it has two.
 *
 * Deleting the profile lives here too, at the bottom: it belongs to this
 * profile rather than to the app's settings, and putting it on the screen that
 * shows the name and face makes it obvious *which* profile is about to go.
 */
export function EditProfileScreen({
  profile,
  token,
  onBack,
  onDeleted,
  onSaved,
}: {
  profile: Profile;
  token: string;
  onBack: () => void;
  /** The profile was deleted — the session it was bound to is gone with it, so
   *  the caller sends the user back to "Who's listening?". */
  onDeleted: () => void;
  /** What changed, applied by the caller to the profile it is already showing.
   *  Deliberately NOT "go re-read it": `/api/profiles` is a read-only GET and
   *  the service worker serves those stale-while-revalidate, so a refetch
   *  right after a save reads back the name you just replaced. */
  onSaved: (change: { name?: string; hasPhoto?: boolean }) => void;
}) {
  const [name, setName] = useState(profile.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a photo change so the <img> refetches: the URL is stable per
  // profile, so without it the browser would keep showing the old file.
  const [photoNonce, setPhotoNonce] = useState(0);
  const [hasPhoto, setHasPhoto] = useState(!!profile.avatar_path);
  const fileRef = useRef<HTMLInputElement>(null);
  // Two-step delete, armed then confirmed. The consequence appears with the
  // armed state rather than sitting on the screen permanently — it describes
  // something you have not asked for until you tap.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    [],
  );

  const remove = async () => {
    if (deleting) return;
    setError(null);
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 6_000);
      return;
    }
    setDeleting(true);
    try {
      await deleteProfile(profile.id, token);
      // Purges the cached list before anything reads it — otherwise the
      // "Who's listening?" gate we are about to land on shows the profile
      // that was just deleted.
      notifyProfilesChanged();
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleteArmed(false);
    } finally {
      setDeleting(false);
    }
  };

  const trimmed = name.trim();
  const dirty = trimmed !== profile.name && trimmed.length > 0;

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameProfile(profile.id, trimmed, token);
      notifyProfilesChanged();
      onSaved({ name: updated.name });
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickPhoto = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await setProfileAvatar(profile.id, file, token);
      notifyProfilesChanged();
      setHasPhoto(true);
      setPhotoNonce((n) => n + 1);
      onSaved({ hasPhoto: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearProfileAvatar(profile.id, token);
      notifyProfilesChanged();
      setHasPhoto(false);
      setPhotoNonce((n) => n + 1);
      onSaved({ hasPhoto: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full text-neutral-100">
      <header
        className={cn(BAR, 'sticky top-0 z-10 flex items-center gap-3 border-b px-3 py-3')}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-9 w-9 place-items-center rounded-full active:bg-neutral-800"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight">
          Edit profile
        </h1>
        {/* Always live. The photo commits the moment you pick it, so gating
            Done on a pending name change left it dimmed right after a visible
            edit — which reads as "that didn't take". It saves the name when
            there is one to save and closes either way. */}
        <button
          type="button"
          onClick={() => (dirty ? void save() : onBack())}
          disabled={busy}
          className="rounded-full px-3 py-1.5 text-sm font-medium text-neutral-100 active:bg-white/10 disabled:text-neutral-500"
        >
          {busy ? 'Saving…' : 'Done'}
        </button>
      </header>

      <div className="px-4 pt-6 pb-12">
        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="grid h-28 w-28 place-items-center overflow-hidden rounded-full shadow active:opacity-80 disabled:opacity-50"
            aria-label="Change photo"
          >
            {hasPhoto ? (
              <img
                // Same rule as the settings card: share the preloaded URL
                // until a photo change makes a fresh one necessary.
                src={
                  photoNonce > 0
                    ? `${profileAvatarUrl(profile.id, token)}&v=${photoNonce}`
                    : profileAvatarUrl(profile.id, token)
                }
                alt=""
                draggable={false}
                className="h-full w-full object-cover"
              />
            ) : (
              <span
                className="grid h-full w-full place-items-center text-4xl font-bold text-neutral-950"
                style={{ backgroundColor: profile.avatar_color }}
              >
                {(profile.name.trim()[0] ?? '?').toUpperCase()}
              </span>
            )}
          </button>
          {/* The system picker offers camera and library on a phone; `accept`
              keeps it to the formats the hub recognises from their bytes. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void pickPhoto(f);
            }}
          />
          <div className="mt-3 flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="text-sm font-medium text-neutral-300 active:opacity-70 disabled:opacity-50"
            >
              {hasPhoto ? 'Change photo' : 'Add photo'}
            </button>
            {hasPhoto && (
              <button
                type="button"
                onClick={() => void removePhoto()}
                disabled={busy}
                className="text-sm font-medium text-red-400 active:opacity-70 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        <label className="mt-8 block">
          <span className="px-1 text-xs uppercase tracking-wide text-neutral-500">
            Name
          </span>
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            className="mt-1.5 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-base text-neutral-100 focus:border-neutral-400 focus:outline-none"
          />
        </label>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="mt-10 border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={deleting || busy}
            className="w-full text-left text-sm font-medium text-red-400 active:opacity-70 disabled:opacity-50"
          >
            {deleting
              ? 'Deleting…'
              : deleteArmed
                ? `Tap again to delete ${profile.name}`
                : 'Delete this profile'}
          </button>
          {deleteArmed && !deleting && (
            <p className="mt-1 text-xs text-neutral-400">
              Removes this profile, its playlists and its listening history from
              the server — on every device, not just this one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
