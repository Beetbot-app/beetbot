import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Wordmark } from '@shared/components/Wordmark';
import { ipc, type Profile } from '@/lib/tauri';
import { useProfileStore } from '@/lib/profile';
import { ambientGradient, extractDominantColor, type Rgb } from '@shared/albumColor';
import {
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  EYEBROW,
  INPUT,
  SCRIM,
  SHEET,
  cn,
} from '@shared/ui';

const AVATAR_COLORS = [
  '#1db954', // green
  '#e22134', // red
  '#3b82f6', // blue
  '#a855f7', // purple
  '#f59e0b', // amber
  '#ec4899', // pink
  '#14b8a6', // teal
  '#6366f1', // indigo
];

function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0]!.toUpperCase() : '?';
}

/** `#rrggbb` → Rgb, so a profile with no photo can still tint the gate from its
 *  avatar colour (the photo path goes through extractDominantColor instead). */
function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Avatar surface: the custom photo when set, else a colour + initial tile.
 *  Fills its parent (the parent controls size + rounding + overflow). */
export function AvatarSurface({
  name,
  color,
  avatarPath,
}: {
  name: string;
  color: string;
  avatarPath: string | null;
}) {
  const [broken, setBroken] = useState(false);
  if (avatarPath && !broken) {
    return (
      <img
        src={convertFileSrc(avatarPath)}
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
      style={{ backgroundColor: color }}
    >
      {initialOf(name)}
    </div>
  );
}

/**
 * Netflix-style "Who's listening?" gate. Shown whenever no profile is active.
 * Lets the user pick a profile (entering a PIN if one is set) or add a new one.
 * Editing / removing existing profiles lives in Settings → Account (owner-only)
 * — the gate is pre-sign-in, so it doesn't expose that. Selecting a profile
 * sets it active in the store, which dismisses the gate.
 */
export function ProfileGate({ onNewProfile }: { onNewProfile: () => void }) {
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  // The gate glows in the colour of whoever you're pointing at — their photo if
  // they have one, else their avatar colour. Same wash the window and every
  // hero use, so the first screen already speaks the app's language.
  const [tint, setTint] = useState<Rgb | null>(null);

  const refresh = () =>
    ipc
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));

  useEffect(() => {
    refresh();
  }, []);

  const hoverTint = (p: Profile | null) => {
    if (!p) {
      setTint(null);
      return;
    }
    const fallback = hexToRgb(p.avatar_color);
    if (!p.avatar_path) {
      setTint(fallback);
      return;
    }
    void extractDominantColor(convertFileSrc(p.avatar_path)).then((c) =>
      setTint(c ?? fallback),
    );
  };

  const pick = (p: Profile) => {
    if (p.has_pin) {
      setPinFor(p);
    } else {
      setActiveProfile(p.id);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50"
      style={{
        background: ambientGradient(tint, { anchor: 'window' }),
        transition: 'background 700ms ease',
      }}
    >
      {/* Same placement as the first-run wizard's, so the mark holds still as
       *  you move gate → onboarding. */}
      <div className="absolute top-7 left-8">
        <Wordmark />
      </div>
      <div
        className="flex h-full flex-col items-center justify-center p-8"
        style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
      >
        <p className={cn(EYEBROW, 'mb-3 text-white/60')}>Welcome back</p>
        <h1 className="mb-10 text-3xl font-bold tracking-tight text-neutral-100">
          Who&rsquo;s listening?
        </h1>
        <div className="flex max-w-3xl flex-wrap items-start justify-center gap-6">
          {(profiles ?? []).map((p) => (
            <div key={p.id} className="flex w-28 flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => pick(p)}
                onMouseEnter={() => hoverTint(p)}
                onMouseLeave={() => hoverTint(null)}
                onFocus={() => hoverTint(p)}
                onBlur={() => hoverTint(null)}
                className="group relative h-28 w-28 overflow-hidden rounded-2xl text-4xl shadow-lg ring-2 ring-white/10 transition hover:scale-105 hover:ring-white/60"
              >
                <AvatarSurface
                  name={p.name}
                  color={p.avatar_color}
                  avatarPath={p.avatar_path}
                />
                {p.has_pin ? (
                  <span className="absolute right-2 bottom-2 text-neutral-950/70">
                    <LockIcon />
                  </span>
                ) : null}
              </button>
              <span className="max-w-full truncate text-sm text-neutral-300">
                {p.name}
              </span>
            </div>
          ))}
          {/* Add profile tile */}
          <div className="flex w-28 flex-col items-center gap-2">
            <button
              type="button"
              onClick={onNewProfile}
              className="grid h-28 w-28 place-items-center rounded-2xl border-2 border-dashed border-white/15 text-neutral-500 transition hover:border-white/40 hover:text-neutral-200"
              aria-label="Add profile"
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <span className="text-sm text-neutral-500">Add profile</span>
          </div>
        </div>
      </div>

      {pinFor ? (
        <PinPrompt
          profile={pinFor}
          onCancel={() => setPinFor(null)}
          onSuccess={() => {
            const id = pinFor.id;
            setPinFor(null);
            setActiveProfile(id);
          }}
        />
      ) : null}
    </div>
  );
}

/** PIN entry overlay for a locked profile. */
function PinPrompt({
  profile,
  onCancel,
  onSuccess,
}: {
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
      const ok = await ipc.verifyProfilePin(profile.id, pin);
      if (ok) onSuccess();
      else {
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
    <div className={cn(SCRIM, 'z-[60] grid place-items-center p-6')} onClick={onCancel}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className={cn(SHEET, 'flex w-80 flex-col items-center gap-4 p-6')}
        style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
      >
        <div className="h-16 w-16 overflow-hidden rounded-xl text-2xl">
          <AvatarSurface
            name={profile.name}
            color={profile.avatar_color}
            avatarPath={profile.avatar_path}
          />
        </div>
        <div className="text-sm text-neutral-300">Enter PIN for {profile.name}</div>
        {/* A PIN wants the big tracked-out treatment, so it overrides INPUT's
         *  text-base with `!` (see the note on INPUT in shared/ui.ts). */}
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          placeholder="••••"
          className={cn(
            INPUT,
            'w-32 text-center text-lg! tracking-[0.5em]',
            error && 'border-red-600',
          )}
        />
        {error ? <div className="text-xs text-red-400">Wrong PIN</div> : null}
        <div className="flex w-full gap-2">
          <button type="button" onClick={onCancel} className={cn(BTN_GHOST, 'flex-1')}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={pin.length < 1 || checking}
            className={cn(BTN_PRIMARY, 'flex-1')}
          >
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Square avatar cropper: pan (drag) + zoom (slider) over a fixed square
 * frame, then render the visible region to a 512×512 canvas. Lets the user
 * pick which part of an oversized photo becomes the icon, and downsizes it.
 */
function CropModal({
  dataUrl,
  onCancel,
  onApply,
}: {
  dataUrl: string;
  onCancel: () => void;
  onApply: (base64Jpeg: string) => void;
}) {
  const D = 256; // viewport (display) size in px
  const OUT = 512; // output resolution
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ px: number; py: number; tx: number; ty: number } | null>(
    null,
  );

  useEffect(() => {
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = dataUrl;
  }, [dataUrl]);

  // Scale so the image at zoom=1 exactly covers the square (the smaller side
  // fits), then the zoom multiplier enlarges from there.
  const baseScale = img
    ? D / Math.min(img.naturalWidth, img.naturalHeight)
    : 1;
  const s = baseScale * zoom;
  const iw = img ? img.naturalWidth * s : D;
  const ih = img ? img.naturalHeight * s : D;

  const clamp = (x: number, y: number, w = iw, h = ih): [number, number] => [
    Math.min(0, Math.max(D - w, x)),
    Math.min(0, Math.max(D - h, y)),
  ];

  // Center the image once it loads.
  useEffect(() => {
    if (!img) return;
    const [cx, cy] = clamp((D - iw) / 2, (D - ih) / 2);
    setTx(cx);
    setTy(cy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { px: e.clientX, py: e.clientY, tx, ty };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [nx, ny] = clamp(d.tx + (e.clientX - d.px), d.ty + (e.clientY - d.py));
    setTx(nx);
    setTy(ny);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onZoom = (z: number) => {
    if (!img) {
      setZoom(z);
      return;
    }
    // Keep the frame center anchored to the same point of the photo.
    const ns = baseScale * z;
    const srcX = (D / 2 - tx) / s;
    const srcY = (D / 2 - ty) / s;
    const niw = img.naturalWidth * ns;
    const nih = img.naturalHeight * ns;
    const [nx, ny] = clamp(D / 2 - srcX * ns, D / 2 - srcY * ns, niw, nih);
    setZoom(z);
    setTx(nx);
    setTy(ny);
  };

  const apply = () => {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The frame (0..D) maps to this source rectangle.
    ctx.drawImage(img, -tx / s, -ty / s, D / s, D / s, 0, 0, OUT, OUT);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    onApply(url.split(',')[1] ?? '');
  };

  return (
    <div className={cn(SCRIM, 'z-[70] grid place-items-center p-6')}>
      <div className={cn(SHEET, 'flex flex-col items-center gap-4 p-5')}>
        <div className="text-sm font-medium text-neutral-200">
          Drag to reposition · slide to zoom
        </div>
        <div
          className="relative overflow-hidden rounded-2xl bg-neutral-950 touch-none cursor-grab active:cursor-grabbing"
          style={{ width: D, height: D }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {img ? (
            <img
              src={dataUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: tx,
                top: ty,
                width: iw,
                height: ih,
                maxWidth: 'none',
              }}
            />
          ) : (
            <div className="h-full w-full grid place-items-center text-xs text-neutral-600">
              Loading…
            </div>
          )}
          {/* Inner ring hinting the avatar shape. */}
          <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-white/20" />
        </div>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => onZoom(parseFloat(e.target.value))}
          className="w-full accent-neutral-200"
          aria-label="Zoom"
        />
        <div className="flex w-full gap-2">
          <button type="button" onClick={onCancel} className={cn(BTN_GHOST, 'flex-1')}>
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!img}
            className={cn(BTN_PRIMARY, 'flex-1')}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * All the create/edit state + persistence for one profile draft — name, colour,
 * optional PIN, and photo (with cropper). Lifted into a hook so both the Settings
 * modal (`ProfileForm`) and the onboarding wizard's first step can own the same
 * fields and wrap their own chrome (heading + footer + navigation) around them.
 */
export function useProfileDraft({
  profile,
  onSaved,
}: {
  profile: Profile | null;
  /** Called after a successful save. On a NEW profile the created row is passed
   *  so the caller can drop straight into it; on an edit it's `undefined`. */
  onSaved: (created?: Profile) => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.avatar_color ?? AVATAR_COLORS[0]!);
  // PIN field: empty = leave unchanged (edit) / no PIN (new). For an existing
  // profile with a PIN, typing replaces it; the "Remove PIN" button clears it.
  const [pin, setPin] = useState('');
  // Saved photo path for an existing profile (updated live as the user
  // uploads/removes); `pendingData` holds a cropped photo (base64 JPEG) for a
  // NEW profile, attached after createProfile (no id yet). `cropSrc` is the
  // data: URL currently open in the cropper.
  const [avatarPath, setAvatarPath] = useState<string | null>(
    profile?.avatar_path ?? null,
  );
  const [pendingData, setPendingData] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNew = profile === null;

  // Re-seed when the underlying profile IDENTITY changes — e.g. the onboarding
  // wizard creates the profile at step 0, then the user navigates BACK to it:
  // the draft should now edit that freshly-created row (name/colour/photo
  // prefilled), not offer a blank "new" form again. Keyed on the id so ordinary
  // typing (which never changes the id) can't clobber a field mid-edit.
  const profileId = profile?.id ?? null;
  useEffect(() => {
    setName(profile?.name ?? '');
    setColor(profile?.avatar_color ?? AVATAR_COLORS[0]!);
    setAvatarPath(profile?.avatar_path ?? null);
    setPendingData(null);
    setPin('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const pickPhoto = async () => {
    try {
      const sel = await open({
        multiple: false,
        filters: [
          {
            name: 'Image',
            extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'],
          },
        ],
      });
      if (!sel || typeof sel !== 'string') return;
      // Load the source into the cropper (the picked file is outside the
      // asset scope, so read it through the host as a data URL).
      const dataUrl = await ipc.readImageDataUrl(sel);
      setCropSrc(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCropApply = async (base64: string) => {
    setCropSrc(null);
    try {
      if (profile) {
        const updated = await ipc.setProfileAvatarData(profile.id, base64);
        setAvatarPath(updated.avatar_path);
      } else {
        setPendingData(base64);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removePhoto = async () => {
    if (profile) {
      try {
        const updated = await ipc.clearProfileAvatar(profile.id);
        setAvatarPath(updated.avatar_path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setPendingData(null);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let created: Profile | undefined;
      if (isNew) {
        created = await ipc.createProfile(n, color, pin.trim() || null);
        // Reassign so `created` carries the avatar path — the wizard re-seeds its
        // profile step from this row on Back, and would otherwise show no photo.
        if (pendingData) created = await ipc.setProfileAvatarData(created.id, pendingData);
      } else {
        await ipc.updateProfile(profile!.id, n, color);
        // Only touch the PIN when the user typed a new one here.
        if (pin.trim()) await ipc.setProfilePin(profile!.id, pin.trim());
      }
      onSaved(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removePin = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      await ipc.setProfilePin(profile.id, null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.deleteProfile(profile.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return {
    profile,
    isNew,
    name,
    setName,
    color,
    setColor,
    pin,
    setPin,
    avatarPath,
    pendingData,
    cropSrc,
    setCropSrc,
    busy,
    error,
    /** A name is the one hard requirement; everything else has a default. */
    canSave: name.trim().length > 0 && !busy,
    pickPhoto,
    handleCropApply,
    removePhoto,
    removePin,
    save,
    del,
  };
}

export type ProfileDraft = ReturnType<typeof useProfileDraft>;

/**
 * The name / photo / colour / PIN fields plus the photo cropper — chrome-free, so
 * `ProfileForm` (the Settings modal) and the onboarding wizard's first step can
 * each wrap their own heading + footer around the identical body.
 */
export function ProfileDraftFields({ draft }: { draft: ProfileDraft }) {
  const {
    profile,
    isNew,
    name,
    setName,
    color,
    setColor,
    pin,
    setPin,
    avatarPath,
    pendingData,
    cropSrc,
    setCropSrc,
    busy,
    error,
    pickPhoto,
    handleCropApply,
    removePhoto,
    removePin,
  } = draft;
  return (
    <>
      <div className="flex items-center gap-4">
        {/* Clickable avatar: shows the photo (existing) or colour tile;
            click to choose a new photo. The hover overlay hints at it. */}
        <button
          type="button"
          onClick={pickPhoto}
          title="Upload photo"
          className="group relative h-16 w-16 shrink-0 rounded-lg overflow-hidden text-2xl"
        >
          {pendingData ? (
            <img
              src={`data:image/jpeg;base64,${pendingData}`}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <AvatarSurface name={name || '?'} color={color} avatarPath={avatarPath} />
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/0 group-hover:bg-black/50 text-white opacity-0 group-hover:opacity-100 transition">
            <CameraIcon />
          </span>
        </button>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Profile name"
          maxLength={40}
          className={cn(INPUT, 'flex-1')}
        />
      </div>

      {/* Photo controls */}
      <div className="flex items-center gap-3 -mt-1">
        <button
          type="button"
          onClick={pickPhoto}
          className="text-xs font-medium text-neutral-100 hover:text-neutral-200"
        >
          {avatarPath || pendingData ? 'Change photo' : 'Upload photo'}
        </button>
        {avatarPath || pendingData ? (
          <button
            type="button"
            onClick={removePhoto}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            Remove photo
          </button>
        ) : null}
        {pendingData && !avatarPath ? (
          <span className="text-xs text-neutral-500">
            Photo will be added on save.
          </span>
        ) : null}
      </div>

      {/* The colour is the backdrop for the initial, and the initial only shows
          when there is no photo — so with one set, this row is a choice with
          nothing to show for it. It comes back if the photo is removed, and the
          stored value is left alone meanwhile: the picker is hidden, not
          reset. (One invisible exception: the "Who's listening?" gate tints on
          hover from the photo's own dominant colour and falls back to this if
          that fails.) */}
      {!(avatarPath || pendingData) && (
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Color</div>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-full transition ${
                  color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-neutral-900' : ''
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
          PIN {isNew ? '(optional)' : profile?.has_pin ? '(set — type to change)' : '(optional)'}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder={profile?.has_pin ? '••••' : 'No PIN'}
            className={cn(INPUT, 'flex-1 tracking-widest')}
          />
          {!isNew && profile?.has_pin ? (
            <button
              type="button"
              onClick={removePin}
              disabled={busy}
              className={cn(BTN_SECONDARY, 'text-xs')}
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="text-xs text-red-400">{error}</div> : null}

      {cropSrc ? (
        <CropModal
          dataUrl={cropSrc}
          onCancel={() => setCropSrc(null)}
          onApply={handleCropApply}
        />
      ) : null}
    </>
  );
}

/** Create / edit a profile in a centered modal card (Settings → Account). */
export function ProfileForm({
  profile,
  canDelete,
  onClose,
  onSaved,
}: {
  profile: Profile | null;
  canDelete: boolean;
  onClose: () => void;
  /** Called after a successful save. On a NEW profile the created row is passed
   *  so the caller can drop straight into it; on an edit it's `undefined`. */
  onSaved: (created?: Profile) => void;
}) {
  const draft = useProfileDraft({ profile, onSaved });
  const { isNew, busy, save, del } = draft;
  return (
    <div className={cn(SCRIM, 'z-50 grid place-items-center p-8')}>
      <form
        onSubmit={save}
        className={cn(SHEET, 'flex w-full max-w-sm flex-col gap-4 p-6')}
        style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
      >
        <h2 className="text-xl font-bold tracking-tight text-neutral-100">
          {isNew ? 'Add profile' : 'Edit profile'}
        </h2>

        <ProfileDraftFields draft={draft} />

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className={cn(BTN_GHOST, 'flex-1')}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={cn(BTN_PRIMARY, 'flex-1')}>
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>

        {!isNew && canDelete ? (
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="text-xs text-red-400 hover:text-red-300 self-center"
          >
            Delete this profile
          </button>
        ) : null}
      </form>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17 9V7a5 5 0 0 0-10 0v2a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3Zm-8-2a3 3 0 0 1 6 0v2H9V7Z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
