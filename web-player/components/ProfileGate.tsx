import { useEffect, useState } from 'react';
import {
  bindSessionProfile,
  getProfiles,
  profileAvatarUrl,
  verifyProfilePin,
  type Profile,
} from '@shared/api';
import { cn, SCRIM, SHEET, INPUT, BTN_PRIMARY, BTN_GHOST } from '@shared/ui';

function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0]!.toUpperCase() : '?';
}

/** Avatar surface: photo when set (via the avatar endpoint), else colour tile. */
function AvatarSurface({
  profile,
  token,
}: {
  profile: Profile;
  token: string;
}) {
  const [broken, setBroken] = useState(false);
  if (profile.avatar_path && !broken) {
    return (
      <img
        src={profileAvatarUrl(profile.id, token)}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div
      className="h-full w-full grid place-items-center font-bold text-neutral-950"
      style={{ backgroundColor: profile.avatar_color }}
    >
      {initialOf(profile.name)}
    </div>
  );
}

/**
 * Phone "Who's listening?" gate. Lets the user pick a profile (entering a PIN
 * if one is set). Creating/editing profiles happens in the desktop app — the
 * phone is a selector. Shown after the session is established and whenever no
 * profile is active on this device.
 */
export function ProfileGate({
  token,
  onSelect,
}: {
  token: string;
  onSelect: (id: number) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pinFor, setPinFor] = useState<Profile | null>(null);

  useEffect(() => {
    getProfiles(token)
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [token]);

  const pick = (p: Profile) => {
    if (p.has_pin) {
      setPinFor(p);
    } else {
      // Bind the session to this profile server-side (no PIN to send) so the
      // server can enforce per-profile ownership; best-effort.
      void bindSessionProfile(token, p.id);
      onSelect(p.id);
    }
  };

  return (
    <div
      className="h-full flex flex-col items-center justify-center p-6"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <h1 className="text-2xl font-bold tracking-tight mb-8 text-neutral-100">
        Who&rsquo;s listening?
      </h1>
      {profiles === null ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-5 max-w-md">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p)}
              className="flex flex-col items-center gap-2 active:scale-95 transition"
            >
              <span className="relative h-24 w-24 rounded-2xl overflow-hidden grid place-items-center text-4xl shadow-lg">
                <AvatarSurface profile={p} token={token} />
                {p.has_pin ? (
                  <span className="absolute bottom-2 right-2 text-neutral-950/70">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M17 9V7a5 5 0 0 0-10 0v2a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3Zm-8-2a3 3 0 0 1 6 0v2H9V7Z" />
                    </svg>
                  </span>
                ) : null}
              </span>
              <span className="text-sm text-neutral-300 truncate max-w-[6rem]">
                {p.name}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-10 text-xs text-neutral-600 text-center max-w-xs">
        Add or edit profiles in the Beetbot desktop app.
      </p>

      {pinFor ? (
        <PinPrompt
          token={token}
          profile={pinFor}
          onCancel={() => setPinFor(null)}
          onSuccess={() => {
            const id = pinFor.id;
            setPinFor(null);
            onSelect(id);
          }}
        />
      ) : null}
    </div>
  );
}

function PinPrompt({
  token,
  profile,
  onCancel,
  onSuccess,
}: {
  token: string;
  profile: Profile;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(false);
    try {
      const ok = await verifyProfilePin(profile.id, pin, token);
      if (ok) {
        // Bind the session to this profile server-side (re-checks the PIN) so
        // the server enforces ownership; best-effort, don't block unlock.
        void bindSessionProfile(token, profile.id, pin);
        onSuccess();
      } else {
        setError(true);
        setPin('');
      }
    } catch {
      setError(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className={cn(SCRIM, 'z-[60] grid place-items-center p-6')}
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className={cn(SHEET, 'w-full max-w-xs p-6 flex flex-col items-center gap-4')}
      >
        <div className="h-16 w-16 rounded-xl overflow-hidden text-2xl">
          <AvatarSurface profile={profile} token={token} />
        </div>
        <div className="text-sm text-neutral-300">
          Enter PIN for {profile.name}
        </div>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          placeholder="••••"
          className={cn(
            INPUT,
            'w-36 py-3 text-center text-xl! tracking-[0.5em]',
            error && 'border-red-600',
          )}
        />
        {error ? <div className="text-xs text-red-400">Wrong PIN</div> : null}
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onCancel}
            className={cn(BTN_GHOST, 'flex-1 py-3 text-center active:bg-neutral-800')}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pin.length < 1 || checking}
            className={cn(BTN_PRIMARY, 'flex-1 py-3')}
          >
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
