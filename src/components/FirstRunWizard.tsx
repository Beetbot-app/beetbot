import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { QRCodeSVG } from 'qrcode.react';
import { useProfileStore } from '@/lib/profile';
import { followArtists, followGenres } from '@/lib/saved';
import {
  ipc,
  type ExternalSharingStatus,
  type PairingInfo,
  type Profile,
  type StreamingStatus,
} from '@/lib/tauri';
import { ProfileDraftFields, useProfileDraft } from '@/components/ProfileGate';
import { playOnDesktop } from '@/pages/Search';
import {
  OnboardingShell,
  StepDots,
} from '@shared/components/onboarding/OnboardingShell';
import { GenresStep } from '@shared/components/onboarding/GenresStep';
import {
  ArtistGridSkeleton,
  ArtistsStep,
} from '@shared/components/onboarding/ArtistsStep';
import { MIN_GENRES, useTastePicks } from '@shared/components/onboarding/useTastePicks';
import {
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CALLOUT_ERROR,
  CALLOUT_INFO,
  CARD,
  EYEBROW_ON_ART,
  INPUT,
  cn,
} from '@shared/ui';

interface Props {
  /** Called when the user dismisses or finishes the wizard. */
  onDone: () => void;
  /** When true, the flow opens with a profile-creation step and creates the
   *  profile itself (the gate's "Add profile" path). Omitted for the ordinary
   *  first-run of an already-selected profile. */
  newProfile?: boolean;
  /** Back-out from the very first (profile) step, before anything is created —
   *  returns to the gate. Only meaningful with `newProfile`. */
  onCancel?: () => void;
}

type Step = 'profile' | 'genres' | 'artists' | 'getmusic' | 'phone' | 'done';

/**
 * First-run onboarding — a full-bleed moment, not a dialog.
 *
 * The app's whole premise is that the room glows in the color of your music
 * (`HeroWash` / `ambientGradient`), so onboarding leads with that: the backdrop
 * blooms into the artwork of whichever artist you're hovering or have picked.
 * The one thing we ask for IS the demo. Chrome comes from the shared recipe
 * sheet (`shared/ui.ts`) so this matches every other surface.
 *
 * Two variants, chosen at runtime from `ipc.appCapabilities()`:
 *  - **Streaming build**: "Who do you love?" — pick artists (or Surprise me).
 *  - **Local-first build** (open core): import a playlist, then attach your own
 *    audio files.
 *
 * Both end with an **opt-in** phone step; nothing is enabled unless asked. The
 * picks are followed (and the server feed warmed) mid-flow, but playback starts
 * only on finish — never mid-wizard.
 *
 * Shown once per profile (flag in localStorage, keyed by profile id — see
 * ONBOARDING_KEY in App.tsx). Skipping never blocks the UI.
 */
export function FirstRunWizard({ onDone, newProfile = false, onCancel }: Props) {
  const activeProfileId = useProfileStore((s) => s.activeProfileId) ?? 1;
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);

  // The profile this flow creates at step 0 (newProfile mode). Kept so that
  // navigating BACK to the profile step edits that row instead of offering a
  // blank "new" form — `useProfileDraft` re-seeds from it (keyed on its id).
  const [createdProfile, setCreatedProfile] = useState<Profile | null>(null);
  const profileDraft = useProfileDraft({
    profile: createdProfile,
    onSaved: (created) => {
      if (created) {
        setCreatedProfile(created);
        // Make it the active profile now, so the taste steps' follows + feed
        // warm land on the right profile (the flow stays mounted regardless —
        // App keeps rendering us while `newProfileFlow` is set).
        setActiveProfile(created.id);
      }
      next();
    },
  });

  // null while we resolve the build's capability, so the first paint doesn't
  // flash the wrong variant.
  const [streaming, setStreaming] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc
      .appCapabilities()
      .then((c) => {
        if (!cancelled) setStreaming(c.streamingPlayback);
      })
      .catch(() => {
        if (!cancelled) setStreaming(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The "Listen on your phone" step configures THIS MAC's streaming — an owner
  // concern set up once, not something a guest profile should (or can) redo. So
  // it's offered only to the owner: the first-created profile (lowest id). Any
  // additional profile skips straight from taste picks to Home. `null` while we
  // resolve it (like `streaming`), defaulting to owner so a lookup failure never
  // hides the step from a genuine first-run. A lone profile is always the owner.
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc
      .listProfiles()
      .then((ps) => {
        if (cancelled) return;
        // Adding a profile from the gate, before it's created: it's the owner
        // only on a truly fresh install (no profiles yet → this becomes the
        // first). Otherwise it's a guest. Judging by `activeProfileId` here would
        // be wrong — it defaults to 1, which usually IS the owner's id.
        if (newProfile && createdProfile == null) {
          setIsOwner(ps.length === 0);
          return;
        }
        const minId = ps.reduce((m, p) => Math.min(m, p.id), Infinity);
        const id = createdProfile?.id ?? activeProfileId;
        setIsOwner(ps.length <= 1 || id === minId);
      })
      .catch(() => {
        if (!cancelled) setIsOwner(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, newProfile, createdProfile]);

  // The welcome screen is gone: the wordmark + the artwork bloom introduce the
  // app better than a paragraph did, and it was a decision-free wall between
  // the user and the one thing we actually want from them.
  const steps = useMemo<Step[]>(() => {
    // The gate's "Add profile" flow owns creating the profile, so it leads with a
    // name/photo step; ordinary first-run (profile already chosen) skips it.
    const lead: Step[] = newProfile ? ['profile'] : [];
    const taste: Step[] = streaming ? ['genres', 'artists'] : ['getmusic'];
    // Include the networking step unless we KNOW this is a guest (isOwner false).
    const network: Step[] = isOwner === false ? [] : ['phone'];
    return [...lead, ...taste, ...network, 'done'];
  }, [newProfile, streaming, isOwner]);
  const [stepIdx, setStepIdx] = useState(0);
  const step = steps[Math.min(stepIdx, steps.length - 1)];

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // --- Import (both variants) ------------------------------------------------
  const [importing, setImporting] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkImporting, setLinkImporting] = useState(false);

  const handleImportZip = useCallback(async () => {
    setError(null);
    setImporting(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Exportify archive', extensions: ['zip'] }],
        title: 'Select the Exportify zip',
      });
      if (typeof selected !== 'string') return;
      const summary = await ipc.importExportifyArchive(selected);
      setNotice(
        `Imported ${summary.playlists_imported} playlist${
          summary.playlists_imported === 1 ? '' : 's'
        } · ${summary.tracks_added} songs.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }, []);

  const handleLinkImport = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setError(null);
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      setError('That doesn’t look like a link. Paste a full https:// URL.');
      return;
    }
    const importer = host.includes('music.apple.com')
      ? ipc.importAppleMusicPlaylist
      : host.includes('soundcloud.com')
        ? ipc.importSoundcloudPlaylist
        : null;
    if (!importer) {
      setError('Paste an Apple Music or SoundCloud playlist link.');
      return;
    }
    setLinkImporting(true);
    try {
      const summary = await importer(activeProfileId, url);
      setNotice(
        `Imported “${summary.playlist_name}” · ${summary.tracks_added} songs.`,
      );
      setLinkUrl('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLinkImporting(false);
    }
  }, [linkUrl, activeProfileId]);

  // --- Taste primer (streaming variant) --------------------------------------
  // The two steps the phone shares (genres → artists), so they live in shared/.
  // The hook stays HERE (not inside the step components) because the footer below
  // needs to gate on picks, and the shell blooms from `taste.activeArt`.
  const taste = useTastePicks({
    activeProfileId,
    onPlayTracks: (queue) => playOnDesktop(queue[0], queue, 0),
    followArtists,
    followGenres,
  });

  // --- Phone step (opt-in) ---------------------------------------------------
  const [phoneStatus, setPhoneStatus] = useState<StreamingStatus | null>(null);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [enablingPhone, setEnablingPhone] = useState(false);
  // The optional "reach it from anywhere" provider — supplied by the host build
  // (the plain open core has none). Brand-neutral: its display name and public
  // URL arrive at runtime via `external_sharing_status`. Null while unknown.
  const [sharing, setSharing] = useState<ExternalSharingStatus | null>(null);

  // Learn the provider's state the moment the phone step shows, so the copy can
  // promise "anywhere" (not just this Wi-Fi) when it's actually live, and the QR
  // can point at the public address instead of the LAN one.
  useEffect(() => {
    if (step !== 'phone') return;
    void ipc.externalSharingStatus().then(setSharing).catch(() => {});
  }, [step]);

  const handleEnablePhone = useCallback(async () => {
    setError(null);
    setEnablingPhone(true);
    try {
      await ipc.streamingSetEnabled(true);
      setPhoneStatus(await ipc.streamingStatus());
      setPairing(await ipc.pairingGetInfo().catch(() => null));
      // Re-check: enabling streaming is what gives the provider something to
      // reach, so its public URL can appear right after this.
      setSharing(await ipc.externalSharingStatus().catch(() => null));
    } catch (e) {
      setError(String(e));
    } finally {
      setEnablingPhone(false);
    }
  }, []);

  // The provider's public URL works from anywhere; the LAN/hostname URLs only
  // resolve on the same Wi-Fi. Prefer the public one whenever it's live — it's
  // the link you can actually send someone.
  const remoteUrl = sharing?.state === 'live' ? sharing.url : null;
  const phoneUrl =
    remoteUrl ??
    phoneStatus?.https_url ??
    phoneStatus?.hostname_url ??
    phoneStatus?.lan_url ??
    null;
  // The pairing code only applies to the LAN path: a request arriving through the
  // provider reaches the server as local, so pairing is never prompted there.
  // The `&&` chain narrows `pairing` so `.code` is a plain string below.
  const pairCode =
    !remoteUrl && pairing?.pairing_required && pairing.code ? pairing.code : null;
  const qrValue = phoneUrl
    ? pairCode
      ? `${phoneUrl}${phoneUrl.includes('?') ? '&' : '?'}pair=${pairCode}`
      : phoneUrl
    : null;

  // --- Navigation ------------------------------------------------------------
  // The in-flight (or settled) promise of `followPicks` — the artist step kicks
  // it off, and `finish` awaits it before refetching Home so the feed is built
  // from picks that have actually landed. Null until the artist step runs (e.g.
  // a top-right Skip that bails before any picks are written).
  const picksWritten = useRef<Promise<void> | null>(null);
  // Memoised: it now reaches into the taste step's own error, so leaving it a
  // plain closure would make every nav callback below depend on a fresh identity
  // each render.
  const clearBanners = useCallback(() => {
    setError(null);
    setNotice(null);
    taste.clearError();
  }, [taste]);
  const next = useCallback(() => {
    clearBanners();
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  }, [clearBanners, steps.length]);
  const back = useCallback(() => {
    clearBanners();
    setStepIdx((i) => Math.max(i - 1, 0));
  }, [clearBanners]);
  const finish = useCallback(async () => {
    // Land the user on a filled Home. The picks are written by `followPicks` at
    // the artist step, but that's async — if we refetched Home before those KV
    // writes landed, the server would build a feed for a profile with no picks
    // AND no history, return zero shelves, and Home would flash its "add music"
    // empty state until the real (picks-seeded) feed arrived seconds later.
    //
    // So wait for the writes to complete first (they're quick, and usually
    // already done by the time the user reaches this step), THEN fire the
    // refresh. Firing it before `onDone` means the cache is cleared and the
    // refetch is in flight as Home is revealed, so the user sees a loading
    // skeleton that fills with their genre shelves — never the empty state.
    try {
      await picksWritten.current;
    } catch {
      // A failed write still lands the user on Home; the refetch just won't be
      // seeded. Better than hanging on the wizard.
    }
    window.dispatchEvent(new Event('beetbot:home-refresh'));
    // Then start the picks playing — after the wizard, on the user's finish,
    // never mid-flow.
    void taste.startPicksPlayback();
    onDone();
  }, [taste, onDone]);

  // Genre "Continue": derive the artist grid from the picked genres (usually
  // instant — each genre's artists were fetched on tap), then advance. Nothing
  // is persisted yet; the writes happen when leaving the artist step.
  const genresContinue = useCallback(() => {
    clearBanners();
    void taste.deriveArtistsFromGenres();
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  }, [clearBanners, taste, steps.length]);

  // Artist "Continue" follows the picks (the KV writes happen inside — genres
  // AND artists) and advances immediately. We keep the write's promise so
  // `finish` can await it before refetching Home; the user isn't blocked here.
  // Playback is deferred to `finish`.
  const artistsContinue = useCallback(() => {
    clearBanners();
    picksWritten.current = taste.followPicks();
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  }, [clearBanners, taste, steps.length]);

  // --- Chrome ----------------------------------------------------------------
  const shell = (children: ReactNode, footer?: ReactNode) => (
    <OnboardingShell
      coverUrl={taste.activeArt}
      // No "Skip" on the profile step — you either name the profile or cancel
      // back to the gate; there's nothing to skip past yet.
      onSkip={step === 'profile' ? undefined : finish}
      footer={footer}
    >
      {children}
    </OnboardingShell>
  );

  // The taste step keeps its own error (a vibe that wouldn't resolve); the host
  // owns the import errors and notices. Either one shows in the same banner.
  const shownError = error ?? taste.error;
  const banners =
    shownError || notice ? (
      <div className={cn(shownError ? CALLOUT_ERROR : CALLOUT_INFO, 'mt-5')}>
        {shownError ?? notice}
      </div>
    ) : null;

  const dots = <StepDots steps={steps} step={step} />;

  // Capability / owner still resolving — hold the real shell (wordmark + wash)
  // with a grid-shaped skeleton, so the step list doesn't flash and the wait
  // looks intentional. The profile step needs neither, so it renders straight
  // away (it's always step 0 in the newProfile flow).
  if (step !== 'profile' && (streaming === null || isOwner === null))
    return shell(<ArtistGridSkeleton />);

  return shell(
    <div
      key={step}
      style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
    >
      {step === 'profile' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (profileDraft.canSave) void profileDraft.save();
          }}
          className="space-y-5"
        >
          <div>
            <p className={EYEBROW_ON_ART}>New profile</p>
            <h1 className="text-3xl font-bold tracking-tight">
              Who&rsquo;s listening?
            </h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-neutral-300">
              Give this profile a name — you&rsquo;ll pick its music next.
            </p>
          </div>
          <ProfileDraftFields draft={profileDraft} />
          {/* Present (not display:none) so Enter in a field still submits. */}
          <button type="submit" className="sr-only" aria-hidden tabIndex={-1}>
            Continue
          </button>
        </form>
      )}

      {step === 'genres' && <GenresStep taste={taste} banners={banners} />}

      {step === 'artists' && (
        <ArtistsStep
          taste={taste}
          banners={banners}
          // Desktop only: importing a playlist needs Tauri IPC. The phone omits
          // this slot, so the row simply isn't there.
          importSlot={
            <details className="text-xs text-neutral-500">
              <summary className="cursor-pointer hover:text-neutral-300">
                Or bring your playlists
              </summary>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !linkImporting) void handleLinkImport();
                  }}
                  placeholder="Apple Music or SoundCloud link"
                  className={cn(INPUT, 'flex-1')}
                />
                <button
                  type="button"
                  onClick={() => void handleLinkImport()}
                  disabled={!linkUrl.trim() || linkImporting}
                  className={BTN_SECONDARY}
                >
                  {linkImporting ? 'Importing…' : 'Import'}
                </button>
              </div>
            </details>
          }
        />
      )}

      {step === 'getmusic' && (
        <div className="space-y-5">
          <p className={EYEBROW_ON_ART}>Get started</p>
          <h1 className="text-3xl font-bold tracking-tight">
            Your music, your files.
          </h1>
          <p className="max-w-lg text-sm leading-relaxed text-neutral-300">
            Beetbot plays audio you own. Import a playlist to start from, then
            add your files to each track — or skip and add music anytime from
            your library.
          </p>

          <div className={cn(CARD, 'space-y-5 p-5')}>
            <div>
              <button
                type="button"
                onClick={handleImportZip}
                disabled={importing}
                className={BTN_PRIMARY}
              >
                {importing ? 'Importing…' : 'Import Exportify zip'}
              </button>
              <p className="mt-2 text-xs text-neutral-500">
                An{' '}
                <button
                  type="button"
                  onClick={() => void openUrl('https://exportify.net')}
                  className="text-neutral-100 underline underline-offset-2 hover:text-white"
                >
                  Exportify
                </button>{' '}
                export of your Spotify playlists.
              </p>
            </div>
            <div>
              <label className="text-xs text-neutral-500">
                Or paste an <strong className="text-neutral-300">Apple Music</strong>{' '}
                or <strong className="text-neutral-300">SoundCloud</strong>{' '}
                playlist link — no account needed:
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !linkImporting) void handleLinkImport();
                  }}
                  placeholder="Paste playlist link here"
                  className={cn(INPUT, 'flex-1')}
                />
                <button
                  type="button"
                  onClick={() => void handleLinkImport()}
                  disabled={!linkUrl.trim() || linkImporting}
                  className={BTN_SECONDARY}
                >
                  {linkImporting ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
          {banners}
        </div>
      )}

      {step === 'phone' && (
        <div className="space-y-5">
          <p className={EYEBROW_ON_ART}>Optional</p>
          <h1 className="text-3xl font-bold tracking-tight">
            Listen on your phone
          </h1>
          {!phoneStatus?.enabled ? (
            <>
              <p className="max-w-lg text-sm leading-relaxed text-neutral-300">
                {remoteUrl && sharing
                  ? `Open Beetbot on your phone from anywhere through ${sharing.providerName}, as long as your Mac is on. Set it up now, or anytime in Settings.`
                  : 'Stream everything to your phone over Wi-Fi while your Mac is on. Set it up now, or anytime in Settings.'}
              </p>
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleEnablePhone()}
                  disabled={enablingPhone}
                  className={BTN_PRIMARY}
                >
                  {enablingPhone ? 'Turning on…' : 'Set up now'}
                </button>
                <button type="button" onClick={next} className={BTN_GHOST}>
                  Maybe later
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-neutral-300">
                {remoteUrl
                  ? 'Scan this with your phone’s camera — it opens Beetbot from anywhere, not just this Wi-Fi.'
                  : 'Scan this with your phone’s camera to open Beetbot there.'}
              </p>
              <div className={cn(CARD, 'flex items-start gap-5 p-5')}>
                {qrValue && (
                  <div className="shrink-0 rounded-lg bg-white p-2">
                    <QRCodeSVG value={qrValue} size={132} level="M" />
                  </div>
                )}
                <div className="space-y-3">
                  {phoneUrl && (
                    <div>
                      <div className="text-xs text-neutral-500">
                        Or open this address:
                      </div>
                      <code className="text-xs break-all text-neutral-200">
                        {phoneUrl}
                      </code>
                    </div>
                  )}
                  {pairCode && (
                    <div>
                      <div className="text-xs text-neutral-500">Pairing code</div>
                      <div className="text-lg font-semibold tracking-widest text-neutral-100">
                        {pairCode}
                      </div>
                    </div>
                  )}
                  {phoneStatus.cert_install_url && !remoteUrl && (
                    <p className="text-xs leading-relaxed text-neutral-500">
                      On iPhone, if it won’t load, you’ll trust a quick
                      certificate first — the full steps are in Settings ›
                      Listen on another device.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
          {banners}
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-5">
          <p className={EYEBROW_ON_ART}>All set</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {streaming ? 'Enjoy the music.' : 'You’re set.'}
          </h1>
          <p className="max-w-lg text-sm leading-relaxed text-neutral-300">
            {streaming
              ? 'Press play and we’ll start with what you picked. The more you listen, the more Home, your mixes, and stations tune to your taste.'
              : 'Open a playlist and use Add audio file on a track to make it playable. To listen on your phone, turn on streaming in Settings.'}
          </p>
          <p className="text-sm text-neutral-500">
            Everything else — library folder and devices — lives in Settings.
          </p>
          {banners}
        </div>
      )}
    </div>,
    <>
      {dots}
      <div className="flex items-center gap-2">
        {stepIdx > 0 && (
          <button type="button" onClick={back} className={BTN_GHOST}>
            Back
          </button>
        )}
        {step === 'profile' && !createdProfile && onCancel ? (
          <button type="button" onClick={onCancel} className={BTN_GHOST}>
            Cancel
          </button>
        ) : null}
        {step === 'profile' ? (
          <button
            type="button"
            onClick={() => void profileDraft.save()}
            disabled={!profileDraft.canSave}
            className={profileDraft.canSave ? BTN_PRIMARY : BTN_SECONDARY}
          >
            {profileDraft.busy
              ? createdProfile
                ? 'Saving…'
                : 'Creating…'
              : 'Continue'}
          </button>
        ) : step === 'done' ? (
          <button type="button" onClick={finish} className={BTN_PRIMARY}>
            Get started
          </button>
        ) : step === 'genres' ? (
          <button
            type="button"
            onClick={genresContinue}
            disabled={!taste.enoughGenres}
            className={taste.enoughGenres ? BTN_PRIMARY : BTN_SECONDARY}
          >
            {taste.enoughGenres
              ? 'Continue'
              : `Pick ${MIN_GENRES - taste.pickedGenres.size} more`}
          </button>
        ) : step === 'artists' ? (
          <button
            type="button"
            onClick={artistsContinue}
            disabled={taste.seeding}
            className={BTN_PRIMARY}
          >
            {taste.seeding
              ? 'Saving…'
              : taste.hasArtistPicks
                ? 'Continue'
                : 'Skip for now'}
          </button>
        ) : (
          <button type="button" onClick={next} className={BTN_PRIMARY}>
            Next
          </button>
        )}
      </div>
    </>,
  );
}
