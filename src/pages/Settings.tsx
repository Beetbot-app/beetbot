import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { QRCodeSVG } from 'qrcode.react';
import { useProfileStore } from '@/lib/profile';
import { usePlayerStore } from '@/lib/store';
import {
  ipc,
  type AcmeStatus,
  type BulkImportSummary,
  type DdnsStatus,
  type ExternalSharingStatus,
  type ImportSummary,
  type NetworkProbe,
  type NgrokStatus,
  type PairingInfo,
  type Profile,
  type StorageUsage,
  type StreamingSession,
  type StreamingStatus,
  type UpnpStatus,
} from '@/lib/tauri';
import { AvatarSurface, ProfileForm } from '@/components/ProfileGate';
import { SharingPeoplePanel } from '@shared/components/SharingPeoplePanel';
import {
  cn,
  CARD,
  EYEBROW,
  INPUT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_GHOST,
  BTN_DANGER,
  BTN_GHOST_DANGER,
  CALLOUT_INFO,
  CALLOUT_WARN,
  CALLOUT_ERROR,
  CODE_CHIP,
  SLIDER,
  navPill,
} from '@shared/ui';
import { Group, Row, Toggle, Slider, Segmented, Picker } from '@shared/components/SettingsKit';
import { notifyProfilesChanged } from '@shared/profilesChanged';
import { useCanDownload } from '@/lib/capabilities';
import {
  useAppearanceStore,
  ZOOM_CHOICES,
  zoomChoiceOf,
  type ZoomChoice,
} from '@/lib/appearance';
import {
  useAudioFxStore,
  EQ_BANDS,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  type EqPreset,
  type Loudness,
} from '@/lib/audiofx';

type Banner = { kind: 'error' | 'info'; text: string } | null;

// The DuckDNS "connect without a relay" path (DuckDNS + Let's Encrypt cert +
// router port-forward + network check) is shown again.
//
// It was hidden on the reasoning that "ngrok already covers trusted remote
// access". That turned out to be false for a music app specifically: ngrok's free
// tier allows 1 GB a month, which is roughly seven hours of 320kbps listening — or
// under three of FLAC. Every listener runs out, every month, and the way they find
// out is their music stopping. Worse, it fails silently: the tunnel stays connected
// and the agent logs nothing while ngrok's edge turns every visitor away (see the
// edge probe in `ngrok/mod.rs`, added after exactly that went unnoticed).
//
// So this route is the honest recommendation for anyone actually listening —
// unlimited, no third party in the audio path — and ngrok is the five-minute option
// for trying remote access out. Both stay: an app whose only remote path is a paid
// service isn't much of a free one.
const SHOW_DUCKDNS = true;

/**
 * Settings page — every knob that used to live in the Library header now
 * lives here. Library should be just music; configuration is a separate
 * surface you only visit when you need to.
 */
type SettingsTab =
  | 'account'
  | 'playback'
  | 'appearance'
  | 'library'
  | 'sharing'
  | 'advanced';

// Category glyphs — the app's own stroke idiom (viewBox 0 0 24 24,
// strokeWidth 1.8, round caps; see svgProps in Sidebar.tsx). Inline SVG, never
// emoji.
const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function AccountIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </svg>
  );
}
function PlaybackIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}
function AppearanceIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function LibraryIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
    </svg>
  );
}
function SharingIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="6" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="M8.4 10.8l7.2-3.6M8.4 13.2l7.2 3.6" />
    </svg>
  );
}
function AdvancedIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M5 8l4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  );
}

const CATEGORIES: {
  id: SettingsTab;
  label: string;
  Icon: (props: { className?: string }) => ReactElement;
}[] = [
  { id: 'account', label: 'Account', Icon: AccountIcon },
  { id: 'playback', label: 'Playback', Icon: PlaybackIcon },
  { id: 'appearance', label: 'Appearance', Icon: AppearanceIcon },
  { id: 'library', label: 'Library', Icon: LibraryIcon },
  { id: 'sharing', label: 'Sharing', Icon: SharingIcon },
  { id: 'advanced', label: 'Advanced', Icon: AdvancedIcon },
];

// Every section declares its home category + the words search matches against,
// so one search field can filter rows across every category at once.
// `ownerOnly` sections are house-wide or destructive (streaming/pairing, clear
// cache, factory reset, logs) — only the house owner sees them. See `isOwner`.
type SectionMeta = { cat: SettingsTab; terms: string[]; ownerOnly?: true };
const SECTIONS = {
  account: { cat: 'account', terms: ['account', 'profile', 'switch profile', 'user', 'avatar'] },
  appbehaviour: { cat: 'account', terms: ['app behaviour', 'app behavior', 'startup', 'open at login', 'login', 'launch', 'start up'] },
  personalize: { cat: 'account', terms: ['personalize', 'personalise', 'onboarding', 'setup', 'set up', 'welcome', 'suggestions', 'recommendations', 'taste', 'genres', 'artists', 're-run', 'redo', 'discover'] },
  crossfade: { cat: 'playback', terms: ['crossfade', 'playback', 'fade', 'overlap', 'autoplay', 'radio', 'keep playing', 'continuous'] },
  sound: { cat: 'playback', terms: ['sound', 'equalizer', 'eq', 'normalize', 'loudness', 'mono', 'audio', 'bass', 'treble', 'effects'] },
  zoom: { cat: 'appearance', terms: ['appearance', 'zoom', 'scale', 'text size', 'bigger', 'smaller', 'dense', 'spacious', 'display'] },
  nowplaying: { cat: 'appearance', terms: ['appearance', 'now playing', 'nowplaying', 'full screen', 'open on play', 'player'] },
  imports: { cat: 'library', terms: ['imports', 'import', 'spotify', 'apple music', 'soundcloud', 'playlist', 'csv', 'exportify'] },
  folder: { cat: 'library', terms: ['library folder', 'music folder', 'download', 'folder', 'disk'] },
  storage: { cat: 'library', terms: ['storage', 'cache', 'clear cache', 'space', 'streaming cache', 'disk', 'downloads'], ownerOnly: true },
  backup: { cat: 'library', terms: ['backup', 'restore', 'export', 'library backup', 'snapshot', 'portable', 'move', 'migrate', 'zip', 'new server'] },
  remote: { cat: 'sharing', terms: ['sharing', 'remote', 'listen', 'another device', 'stream', 'streaming', 'pairing', 'ngrok', 'link', 'qr', 'phone'], ownerOnly: true },
  people: { cat: 'sharing', terms: ['people', 'invite', 'share with', 'friends', 'family', 'guests', 'access', 'remove access', 'who can'], ownerOnly: true },
  logs: { cat: 'advanced', terms: ['logs', 'log', 'security', 'debug', 'diagnostics'], ownerOnly: true },
  nativeengine: { cat: 'playback', terms: ['native', 'audio engine', 'beta', 'engine', 'experimental playback'] },
  reset: { cat: 'advanced', terms: ['reset', 'defaults', 'restore', 'clear settings', 'factory'], ownerOnly: true },
} satisfies Record<string, SectionMeta>;

/** Human-readable byte size ("1.2 GB", "340 MB"); em-dash when unknown. */
function fmtBytes(n?: number | null): string {
  if (n == null) return '—';
  if (n === 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function SettingsPage() {
  // Imports (Apple Music / SoundCloud) target the active profile.
  const activeProfileId = useProfileStore((s) => s.activeProfileId) ?? 1;
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  // Audio effects (desktop, opt-in — see src/lib/audiofx.ts).
  const eqEnabled = useAudioFxStore((s) => s.eqEnabled);
  const setEqEnabled = useAudioFxStore((s) => s.setEqEnabled);
  const eqPreset = useAudioFxStore((s) => s.eqPreset);
  const setEqPreset = useAudioFxStore((s) => s.setEqPreset);
  const eqGains = useAudioFxStore((s) => s.eqGains);
  const setEqGain = useAudioFxStore((s) => s.setEqGain);
  const mono = useAudioFxStore((s) => s.mono);
  const setMono = useAudioFxStore((s) => s.setMono);
  const normalize = useAudioFxStore((s) => s.normalize);
  const setNormalize = useAudioFxStore((s) => s.setNormalize);
  const loudness = useAudioFxStore((s) => s.loudness);
  const setLoudness = useAudioFxStore((s) => s.setLoudness);
  const resetAppearance = useAppearanceStore((s) => s.reset);
  const resetAudioFx = useAudioFxStore((s) => s.reset);
  const [resetArmed, setResetArmed] = useState(false);
  // Open-on-login. null = plugin unavailable (build predates it) or not loaded.
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  // Left-rail category that's currently shown; the search field filters rows
  // across every category, ignoring the selection while it has text.
  const [tab, setTab] = useState<SettingsTab>('account');
  const [search, setSearch] = useState('');
  // Account — the active profile + "switch profile" (existing capability), plus
  // full profile management (edit / add / delete) moved here from the picker.
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [editingProfile, setEditingProfile] = useState<Profile | 'new' | null>(
    null,
  );
  // Switch to another profile (no-PIN → directly; PIN-locked → via the picker,
  // which owns the PIN entry). A member manages only their own profile, so
  // getting into another means switching to it first; the owner can manage all.
  const switchTo = useCallback(
    (p: Profile) => {
      if (p.has_pin) setActiveProfile(null);
      else setActiveProfile(p.id);
    },
    [setActiveProfile],
  );
  // House "owner" = the oldest profile on this Mac (the seeded account). Only the
  // owner sees house-wide + destructive settings (Sharing, clear cache, factory
  // reset, logs) and can add / remove / edit every profile; everyone else manages
  // just their own. This is a UX guardrail on a shared device — profiles are
  // picked, not logged into — not a security boundary.
  const ownerId = profiles.length
    ? Math.min(...profiles.map((p) => p.id))
    : 1;
  const isOwner = activeProfileId === ownerId;
  // Sharing + Advanced are owner-only categories; if a member ever lands on one
  // (e.g. after switching out of the owner profile), fall back to Account so the
  // panel is never blank.
  useEffect(() => {
    if (!isOwner && (tab === 'sharing' || tab === 'advanced')) setTab('account');
  }, [isOwner, tab]);
  // Appearance — the desktop look, persisted per install (not per profile).
  const zoom = useAppearanceStore((s) => s.zoom);
  const setZoom = useAppearanceStore((s) => s.setZoom);
  const openNowPlayingOnPlay = useAppearanceStore((s) => s.openNowPlayingOnPlay);
  const setOpenNowPlayingOnPlay = useAppearanceStore(
    (s) => s.setOpenNowPlayingOnPlay,
  );
  const nativeEngine = useAppearanceStore((s) => s.nativeEngine);
  const setNativeEngine = useAppearanceStore((s) => s.setNativeEngine);


  // Streaming
  const [streamingStatus, setStreamingStatus] = useState<StreamingStatus | null>(
    null,
  );
  const [streamingSessions, setStreamingSessions] = useState<StreamingSession[]>(
    [],
  );

  // Library folder
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  // Auto-download (full build only). Load the current value once the capability
  // resolves; the OSS build never shows the control.
  const canDownloadCap = useCanDownload();
  const [autoDownload, setAutoDownloadState] = useState(false);
  useEffect(() => {
    if (!canDownloadCap) return;
    ipc.getAutoDownload().then(setAutoDownloadState).catch(() => {});
  }, [canDownloadCap]);
  const handleToggleAutoDownload = useCallback(async (next: boolean) => {
    setAutoDownloadState(next); // optimistic
    try {
      await ipc.setAutoDownload(next);
    } catch {
      setAutoDownloadState(!next); // revert on failure
    }
  }, []);

  // Storage (streaming cache + downloads size)
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  // Logs
  const [logDir, setLogDir] = useState<string | null>(null);

  // Network probe (off-LAN reachability)
  const [networkProbe, setNetworkProbe] = useState<NetworkProbe | null>(null);
  const [probing, setProbing] = useState(false);

  // DDNS
  const [ddns, setDdns] = useState<DdnsStatus | null>(null);
  const [ddnsSubdomainInput, setDdnsSubdomainInput] = useState('');
  const [ddnsTokenInput, setDdnsTokenInput] = useState('');
  const [ddnsBusy, setDdnsBusy] = useState(false);

  // ngrok tunnel (alternative to DuckDNS + port-forwarding)
  const [ngrok, setNgrok] = useState<NgrokStatus | null>(null);
  const [ngrokTokenInput, setNgrokTokenInput] = useState('');
  const [ngrokDomainInput, setNgrokDomainInput] = useState('');
  const [ngrokBusy, setNgrokBusy] = useState(false);
  const [ngrokNotice, setNgrokNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null,
  );

  // ACME / Let's Encrypt. "Go live anywhere" issues + auto-renews the cert, so
  // the manual controls live behind an "Advanced" disclosure.
  const [acme, setAcme] = useState<AcmeStatus | null>(null);
  const [acmeContact, setAcmeContact] = useState('');
  const [acmeStaging, setAcmeStaging] = useState(false);
  const [acmeBusy, setAcmeBusy] = useState(false);
  const [showAdvancedRemote, setShowAdvancedRemote] = useState(false);

  // Pairing / public-mode auth
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [securityLogPath, setSecurityLogPath] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);

  // UPnP auto port-forward status (live while remote streaming is enabled).
  const [upnp, setUpnp] = useState<UpnpStatus | null>(null);
  // "Go live anywhere" one-button flow.
  const [goingLive, setGoingLive] = useState(false);
  // Lets the Go-live flow scroll/focus the DuckDNS subdomain field when the
  // user still needs to fill it in (the one unavoidable external step).
  const ddnsSubdomainRef = useRef<HTMLInputElement | null>(null);

  // Portable full-server backup (all profiles, one zip)
  const [portableBusy, setPortableBusy] = useState(false);
  const [portableAudio, setPortableAudio] = useState(true);
  const [restartReady, setRestartReady] = useState(false);

  // Imports
  const [openingExportify, setOpeningExportify] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkImporting, setLinkImporting] = useState(false);
  const [lastBulk, setLastBulk] = useState<BulkImportSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [
        streamStatus,
        streamSessions,
        dlDir,
        lgDir,
        ddnsStatus,
        ngrokStatus,
        acmeStatus,
        pairingInfo,
        secLogPath,
        profileList,
        storageInfo,
      ] = await Promise.all([
        ipc.streamingStatus(),
        ipc.listStreamingSessions(),
        ipc.getDownloadDir().catch(() => null),
        ipc.getLogDir().catch(() => null),
        ipc.ddnsGetStatus().catch(() => null),
        ipc.ngrokGetStatus().catch(() => null),
        ipc.acmeGetStatus().catch(() => null),
        ipc.pairingGetInfo().catch(() => null),
        ipc.getSecurityLogPath().catch(() => null),
        ipc.listProfiles().catch(() => [] as Profile[]),
        ipc.storageUsage().catch(() => null),
      ]);
      setProfiles(profileList);
      setStorage(storageInfo);
      setStreamingStatus(streamStatus);
      setStreamingSessions(streamSessions);
      setDownloadDir(dlDir);
      setLogDir(lgDir);
      setDdns(ddnsStatus);
      if (ddnsStatus?.subdomain) setDdnsSubdomainInput(ddnsStatus.subdomain);
      setNgrok(ngrokStatus);
      if (ngrokStatus?.domain) setNgrokDomainInput(ngrokStatus.domain);
      setAcme(acmeStatus);
      setPairing(pairingInfo);
      setSecurityLogPath(secLogPath);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, [activeProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load the open-on-login state once (separate from refresh — it lives in the
  // autostart plugin, not the core, and is absent on older builds).
  useEffect(() => {
    ipc
      .autostartIsEnabled()
      .then(setAutostartEnabled)
      .catch(() => setAutostartEnabled(null));
  }, []);

  // Poll the pairing code while the panel is open. The code rotates
  // every 5 min server-side; refreshing every 10 s keeps the countdown
  // honest without spamming the IPC. Stops automatically when pairing
  // isn't required.
  useEffect(() => {
    if (!pairing?.pairing_required) return;
    const id = setInterval(() => {
      void ipc.pairingGetInfo().then(setPairing).catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [pairing?.pairing_required]);

  // Poll the auto port-forward (UPnP) status while remote streaming is on, so
  // the user sees whether the router opened the ports for them. The backend
  // opens them when remote streaming is enabled; if UPnP isn't available it
  // surfaces an error we fall back to manual instructions for.
  useEffect(() => {
    if (!pairing?.remote_streaming_enabled) {
      setUpnp(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void ipc
        .upnpStatus()
        .then((s) => {
          if (!cancelled) setUpnp(s);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pairing?.remote_streaming_enabled]);

  // Poll the ngrok tunnel status while remote streaming is on, so the live
  // public URL and any handshake error surface as the tunnel comes up. The
  // tunnel takes a second or two to connect after enabling.
  useEffect(() => {
    if (!pairing?.remote_streaming_enabled) return;
    let cancelled = false;
    const tick = () => {
      void ipc
        .ngrokGetStatus()
        .then((s) => {
          if (!cancelled) setNgrok(s);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pairing?.remote_streaming_enabled]);


  // -- Storage handlers ---------------------------------------------------

  const handleClearCache = useCallback(async () => {
    setBanner(null);
    setClearingCache(true);
    try {
      const freed = await ipc.clearLiveCache();
      const usage = await ipc.storageUsage().catch(() => null);
      setStorage(usage);
      setBanner({
        kind: 'info',
        text: freed > 0 ? `Cleared ${fmtBytes(freed)} of streaming cache.` : 'Streaming cache is already empty.',
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setClearingCache(false);
    }
  }, []);

  // -- Reset to defaults --------------------------------------------------

  const handleResetDefaults = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      window.setTimeout(() => setResetArmed(false), 4000);
      return;
    }
    setResetArmed(false);
    resetAppearance();
    resetAudioFx();
    setCrossfadeSeconds(0);
    setAutoplay(true);
    setBanner({ kind: 'info', text: 'Settings reset to defaults.' });
  }, [resetArmed, resetAppearance, resetAudioFx, setCrossfadeSeconds, setAutoplay]);

  const handleToggleAutostart = useCallback(async (next: boolean) => {
    setBanner(null);
    try {
      if (next) await ipc.autostartEnable();
      else await ipc.autostartDisable();
      setAutostartEnabled(next);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, []);

  // -- Streaming handlers -------------------------------------------------

  const handleToggleStreaming = useCallback(async (enabled: boolean) => {
    setBanner(null);
    try {
      await ipc.streamingSetEnabled(enabled);
      const fresh = await ipc.streamingStatus();
      setStreamingStatus(fresh);
      setBanner({
        kind: 'info',
        text: enabled
          ? 'Direct link turned on.'
          : 'Direct link turned off.',
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, []);

  const handleRevokeStreamingSession = useCallback(async (id: string) => {
    try {
      await ipc.revokeStreamingSession(id);
      setStreamingSessions(await ipc.listStreamingSessions());
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, []);

  // Sign out of every connected device at once. There's no bulk backend command,
  // so revoke each live session; each device then has to pair again to stream.
  const handleSignOutAllDevices = useCallback(async () => {
    if (
      !confirm(
        'Sign out of all connected devices? Each one will need to pair again before it can stream from this Mac.',
      )
    ) {
      return;
    }
    setBanner(null);
    try {
      const sessions = await ipc.listStreamingSessions();
      await Promise.all(sessions.map((s) => ipc.revokeStreamingSession(s.id)));
      setStreamingSessions(await ipc.listStreamingSessions());
      setBanner({ kind: 'info', text: 'Signed out of all devices.' });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, []);

  // -- Downloads handlers -------------------------------------------------

  const handleProbeNetwork = useCallback(async () => {
    setBanner(null);
    setProbing(true);
    try {
      const probe = await ipc.probeNetwork();
      setNetworkProbe(probe);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setProbing(false);
    }
  }, []);

  const [ddnsCardNotice, setDdnsCardNotice] = useState<
    { kind: 'info' | 'error'; text: string } | null
  >(null);

  const handleDdnsSave = useCallback(async () => {
    // The UI shows ".duckdns.org" as a suffix label, but users often paste
    // the full domain anyway. Normalize so either input works.
    const cleanedSubdomain = ddnsSubdomainInput
      .trim()
      .replace(/\.duckdns\.org$/i, '')
      .replace(/^https?:\/\//i, '')
      .toLowerCase();
    if (cleanedSubdomain !== ddnsSubdomainInput) {
      setDdnsSubdomainInput(cleanedSubdomain);
    }
    setBanner(null);
    setDdnsCardNotice(null);
    setDdnsBusy(true);
    try {
      await ipc.ddnsSetConfig(cleanedSubdomain, ddnsTokenInput.trim());
      setDdnsTokenInput('');
      const fresh = await ipc.ddnsGetStatus();
      setDdns(fresh);
      setDdnsCardNotice({
        kind: 'info',
        text: 'Saved. Click Update now to push your current IP to DuckDNS.',
      });
    } catch (e) {
      setDdnsCardNotice({ kind: 'error', text: String(e) });
    } finally {
      setDdnsBusy(false);
    }
  }, [ddnsSubdomainInput, ddnsTokenInput]);

  const handleDdnsUpdateNow = useCallback(async () => {
    setBanner(null);
    setDdnsCardNotice(null);
    setDdnsBusy(true);
    try {
      const summary = await ipc.ddnsUpdateNow();
      const fresh = await ipc.ddnsGetStatus();
      setDdns(fresh);
      setDdnsCardNotice({ kind: 'info', text: `Update OK: ${summary}` });
    } catch (e) {
      setDdnsCardNotice({
        kind: 'error',
        text: `Update failed: ${String(e)}`,
      });
      const fresh = await ipc.ddnsGetStatus().catch(() => null);
      if (fresh) setDdns(fresh);
    } finally {
      setDdnsBusy(false);
    }
  }, []);

  const handleDdnsClear = useCallback(async () => {
    setBanner(null);
    setDdnsCardNotice(null);
    setDdnsBusy(true);
    try {
      await ipc.ddnsClear();
      const fresh = await ipc.ddnsGetStatus();
      setDdns(fresh);
      setDdnsSubdomainInput('');
      setDdnsTokenInput('');
      setDdnsCardNotice({ kind: 'info', text: 'DDNS cleared.' });
    } catch (e) {
      setDdnsCardNotice({ kind: 'error', text: String(e) });
    } finally {
      setDdnsBusy(false);
    }
  }, []);

  const handleNgrokSave = useCallback(async () => {
    // Accept a pasted full URL or "https://" prefix for the domain field.
    const cleanedDomain = ngrokDomainInput
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (cleanedDomain !== ngrokDomainInput) setNgrokDomainInput(cleanedDomain);
    setBanner(null);
    setNgrokNotice(null);
    setNgrokBusy(true);
    try {
      await ipc.ngrokSetConfig(ngrokTokenInput.trim(), cleanedDomain);
      setNgrokTokenInput('');
      // Saving auto-enables remote access, so refresh pairing too (the Remote
      // streaming toggle + pairing code reflect the new state).
      const [fresh, freshPairing] = await Promise.all([
        ipc.ngrokGetStatus(),
        ipc.pairingGetInfo().catch(() => null),
      ]);
      setNgrok(fresh);
      if (freshPairing) setPairing(freshPairing);
      // Keep the setup open after the first save (it would otherwise auto-
      // collapse once `has_authtoken` flips true) so the confirmation + a Hide
      // control stay visible; the live link shows up in the connect block above.
      setShowAdvancedRemote(true);
      setNgrokNotice({
        kind: 'info',
        text: 'Saved — remote access is on and the tunnel is coming up.',
      });
    } catch (e) {
      setNgrokNotice({ kind: 'error', text: String(e) });
    } finally {
      setNgrokBusy(false);
    }
  }, [ngrokTokenInput, ngrokDomainInput]);

  const handleNgrokClear = useCallback(async () => {
    setBanner(null);
    setNgrokNotice(null);
    setNgrokBusy(true);
    try {
      await ipc.ngrokClear();
      const fresh = await ipc.ngrokGetStatus();
      setNgrok(fresh);
      setNgrokTokenInput('');
      setNgrokDomainInput('');
      setNgrokNotice({ kind: 'info', text: 'ngrok cleared.' });
    } catch (e) {
      setNgrokNotice({ kind: 'error', text: String(e) });
    } finally {
      setNgrokBusy(false);
    }
  }, []);

  const handleAcmeIssue = useCallback(async () => {
    setBanner(null);
    setAcmeBusy(true);
    try {
      const outcome = await ipc.acmeIssue({
        contact_email: acmeContact.trim() || null,
        staging: acmeStaging,
      });
      const fresh = await ipc.acmeGetStatus();
      setAcme(fresh);
      setBanner({
        kind: 'info',
        text: `Cert issued for ${outcome.hostname}. HTTPS is live now.`,
      });
    } catch (e) {
      const fresh = await ipc.acmeGetStatus().catch(() => null);
      if (fresh) setAcme(fresh);
      setBanner({ kind: 'error', text: `Let's Encrypt failed: ${String(e)}` });
    } finally {
      setAcmeBusy(false);
    }
  }, [acmeContact, acmeStaging]);

  const handleTogglePairingRequired = useCallback(
    async (enabled: boolean) => {
      setBanner(null);
      try {
        await ipc.pairingSetRequired(enabled);
        const fresh = await ipc.pairingGetInfo();
        setPairing(fresh);
      } catch (e) {
        setBanner({ kind: 'error', text: String(e) });
      }
    },
    [],
  );

  const handleToggleRemoteStreaming = useCallback(
    async (enabled: boolean) => {
      // Off is a one-tap action; ON deserves a confirm because it
      // changes the security posture for the whole LAN.
      if (
        enabled &&
        !confirm(
          'Turning Remote streaming on opens Beetbot to any IP that has a valid session token, and forces pairing on every device (even on Wi-Fi). Continue?',
        )
      ) {
        return;
      }
      setBanner(null);
      setRemoteBusy(true);
      try {
        // Remote implies LAN: turning remote on with the LAN server off would
        // leave nothing to connect to, so enable streaming first. The user
        // never has to flip two separate switches.
        if (enabled && !streamingStatus?.enabled) {
          await ipc.streamingSetEnabled(true);
          setStreamingStatus(await ipc.streamingStatus());
        }
        await ipc.remoteStreamingSetEnabled(enabled);
        const fresh = await ipc.pairingGetInfo();
        setPairing(fresh);
        setBanner({
          kind: 'info',
          text: enabled
            ? 'Remote streaming on. Pairing is now required on every device.'
            : 'Remote streaming off. LAN posture returned to default.',
        });
      } catch (e) {
        setBanner({ kind: 'error', text: String(e) });
      } finally {
        setRemoteBusy(false);
      }
    },
    [streamingStatus?.enabled],
  );

  // One-button "Go live anywhere": runs the whole remote-access setup in order,
  // surfacing each step in the banner. DuckDNS is the one unavoidable external
  // step — if it isn't configured we stop and point the user at the field.
  const handleGoLive = useCallback(async () => {
    setGoingLive(true);
    setBanner(null);
    try {
      // Step 1 — ensure DuckDNS is configured. Use the freshest saved status;
      // also accept just-typed-but-unsaved inputs and save them on the fly.
      let ddnsStatus = await ipc.ddnsGetStatus().catch(() => ddns);
      const savedConfigured = Boolean(
        ddnsStatus?.subdomain && ddnsStatus?.has_token,
      );
      const typedSubdomain = ddnsSubdomainInput.trim();
      const typedToken = ddnsTokenInput.trim();
      if (!savedConfigured && typedSubdomain && typedToken) {
        await ipc.ddnsSetConfig(
          typedSubdomain
            .replace(/\.duckdns\.org$/i, '')
            .replace(/^https?:\/\//i, '')
            .toLowerCase(),
          typedToken,
        );
        setDdnsTokenInput('');
        ddnsStatus = await ipc.ddnsGetStatus().catch(() => ddnsStatus);
        setDdns(ddnsStatus);
      }
      if (!(ddnsStatus?.subdomain && ddnsStatus?.has_token)) {
        setBanner({
          kind: 'info',
          text: 'To go live anywhere, add your DuckDNS subdomain + token below first, then tap “Go live anywhere” again.',
        });
        ddnsSubdomainRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        ddnsSubdomainRef.current?.focus();
        return;
      }

      // Step 2 — enable the LAN server (no restart needed).
      setBanner({ kind: 'info', text: 'Starting the streaming server…' });
      try {
        await ipc.streamingSetEnabled(true);
        setStreamingStatus(await ipc.streamingStatus());
      } catch (e) {
        setBanner({
          kind: 'error',
          text: `Couldn’t start the streaming server: ${String(e)}`,
        });
        return;
      }

      // Step 3 — push the current public IP to DuckDNS.
      setBanner({ kind: 'info', text: 'Pointing your DuckDNS hostname at this Mac…' });
      try {
        await ipc.ddnsUpdateNow();
        setDdns(await ipc.ddnsGetStatus().catch(() => ddnsStatus));
      } catch (e) {
        setBanner({
          kind: 'error',
          text: `DuckDNS update failed: ${String(e)}`,
        });
        return;
      }

      // Step 4 — issue a Let's Encrypt cert if we don't already have one.
      try {
        const acmeStatus = await ipc.acmeGetStatus().catch(() => acme);
        if (!acmeStatus?.has_cert) {
          setBanner({
            kind: 'info',
            text: 'Issuing HTTPS certificate… (up to 90s)',
          });
          await ipc.acmeIssue({ contact_email: null, staging: false });
          setAcme(await ipc.acmeGetStatus().catch(() => acmeStatus));
        }
      } catch (e) {
        setBanner({
          kind: 'error',
          text: `Couldn’t issue the HTTPS certificate: ${String(e)}`,
        });
        await ipc.acmeGetStatus().then(setAcme).catch(() => {});
        return;
      }

      // Step 5 — enable remote streaming (this triggers backend UPnP opening).
      setBanner({ kind: 'info', text: 'Opening your network for remote access…' });
      try {
        await ipc.remoteStreamingSetEnabled(true);
        setPairing(await ipc.pairingGetInfo());
      } catch (e) {
        setBanner({
          kind: 'error',
          text: `Couldn’t enable remote streaming: ${String(e)}`,
        });
        return;
      }

      // Step 6 — refresh status and report. If UPnP couldn't open the ports,
      // append the manual port-forward note.
      const upnpStatus = await ipc.upnpStatus().catch(() => null);
      setUpnp(upnpStatus);
      const manualNote =
        upnpStatus && !upnpStatus.mapped
          ? ' Note: your router didn’t open the ports automatically — forward 47823 and 47824 (TCP) to this Mac to finish.'
          : '';
      setBanner({
        kind: 'info',
        text: `You're live. Scan the QR on your phone to connect.${manualNote}`,
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setGoingLive(false);
    }
  }, [acme, ddns, ddnsSubdomainInput, ddnsTokenInput]);

  const handleOpenSecurityLog = useCallback(async () => {
    if (!securityLogPath) return;
    try {
      await revealItemInDir(securityLogPath);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, [securityLogPath]);

  const handleAcmeClear = useCallback(async () => {
    if (!confirm('Remove the Let’s Encrypt cert? HTTPS will fall back to the self-signed cert.')) return;
    setBanner(null);
    setAcmeBusy(true);
    try {
      await ipc.acmeClear();
      const fresh = await ipc.acmeGetStatus();
      setAcme(fresh);
      setBanner({ kind: 'info', text: 'Let’s Encrypt cert cleared.' });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setAcmeBusy(false);
    }
  }, []);

  const handleOpenLogDir = useCallback(async () => {
    if (!logDir) return;
    setBanner(null);
    try {
      // `revealItemInDir` works for a directory too — Finder pops open at it.
      // We pass the dir itself (not a file inside) so users land at the
      // beetbot.log rotation siblings.
      await revealItemInDir(logDir);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, [logDir]);

  const handlePickDownloadDir = useCallback(async () => {
    setBanner(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Pick a folder for your music library',
      });
      if (typeof selected !== 'string') return;
      await ipc.setDownloadDir(selected);
      setDownloadDir(selected);
      setBanner({ kind: 'info', text: `Imported music will be stored in ${selected}.` });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, []);

  const handleExportBackup = useCallback(async () => {
    setBanner(null);
    try {
      const path = await save({
        defaultPath: 'beetbot-backup.json',
        filters: [{ name: 'Beetbot backup', extensions: ['json'] }],
      });
      if (!path) return;
      const s = await ipc.exportLibrary(activeProfileId, path);
      setBanner({
        kind: 'info',
        text: `Backed up ${s.playlists} ${s.playlists === 1 ? 'playlist' : 'playlists'} · ${s.tracks} songs.`,
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, [activeProfileId]);

  const handleImportBackup = useCallback(async () => {
    setBanner(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Beetbot backup', extensions: ['json'] }],
      });
      if (typeof selected !== 'string') return;
      const s = await ipc.importLibraryBackup(activeProfileId, selected);
      setBanner({
        kind: 'info',
        text: `Restored ${s.playlists} ${s.playlists === 1 ? 'playlist' : 'playlists'} · ${s.tracks} songs. Reopen your library to see them.`,
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    }
  }, [activeProfileId]);

  // -- Portable full-server backup handlers -------------------------------

  const handlePortableExport = useCallback(async () => {
    setBanner(null);
    setPortableBusy(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `beetbot-portable-${date}.zip`,
        filters: [{ name: 'Beetbot portable backup', extensions: ['zip'] }],
      });
      if (!path) return;
      const s = await ipc.portableExport(path, portableAudio);
      setBanner({
        kind: 'info',
        text: `Exported ${s.profiles} ${s.profiles === 1 ? 'profile' : 'profiles'} · ${s.playlists} playlists · ${s.tracks} songs${
          s.audioIncluded ? ` · ${s.audioFiles} audio files` : ' (catalog only)'
        }.`,
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setPortableBusy(false);
    }
  }, [portableAudio]);

  const handlePortableImport = useCallback(async () => {
    setBanner(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Beetbot portable backup', extensions: ['zip'] }],
      });
      if (typeof selected !== 'string') return;
      // Show what the backup holds BEFORE anything is replaced.
      const m = await ipc.portablePeek(selected);
      const exported = new Date(m.exportedAt * 1000).toLocaleDateString();
      const ok = await ask(
        `This replaces everything on this server — every profile, playlist and setting — with the backup from ${exported}: ${m.profiles} ${
          m.profiles === 1 ? 'profile' : 'profiles'
        }, ${m.playlists} playlists, ${m.tracks} songs${
          m.audioIncluded ? `, ${m.audioFiles} audio files` : ' (catalog only)'
        }. The current library is kept on disk as a rescue copy.`,
        {
          title: 'Restore full backup?',
          kind: 'warning',
          okLabel: 'Replace & restore',
          cancelLabel: 'Cancel',
        },
      );
      if (!ok) return;
      setPortableBusy(true);
      const s = await ipc.portableImport(selected);
      setRestartReady(true);
      setBanner({
        kind: 'info',
        text: `Backup staged: ${s.profiles} ${s.profiles === 1 ? 'profile' : 'profiles'} · ${s.playlists} playlists · ${s.tracks} songs${
          s.audioMissing > 0 ? ` (${s.audioMissing} songs will re-download)` : ''
        }. Restart Beetbot to finish.`,
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setPortableBusy(false);
    }
  }, []);

  // -- Imports handlers ---------------------------------------------------

  const handleOpenExportify = useCallback(async () => {
    setBanner(null);
    setOpeningExportify(true);
    try {
      await ipc.openExportifyWindow();
      setBanner({
        kind: 'info',
        text: 'Exportify opened in your browser. Sign in, click "Export All", then come back and import the downloaded zip.',
      });
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setOpeningExportify(false);
    }
  }, []);

  const handleBulkImport = useCallback(async () => {
    setBanner(null);
    setBulkImporting(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Exportify archive', extensions: ['zip'] }],
        title: 'Select the Exportify zip',
      });
      if (typeof selected !== 'string') return;
      const summary = await ipc.importExportifyArchive(selected);
      setLastBulk(summary);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setBulkImporting(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setBanner(null);
    setImporting(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        title: 'Select an Exportify CSV',
      });
      if (typeof selected !== 'string') return;
      const inferredName = selected
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.csv$/i, '');
      const summary = await ipc.importCsv(selected, inferredName);
      setLastImport(summary);
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setImporting(false);
    }
  }, []);

  // One box for both Apple Music and SoundCloud — pick the importer by host.
  const handleLinkImport = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setBanner(null);
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      setBanner({ kind: 'error', text: 'Paste a full https:// playlist link.' });
      return;
    }
    const importer = host.includes('music.apple.com')
      ? ipc.importAppleMusicPlaylist
      : host.includes('soundcloud.com')
        ? ipc.importSoundcloudPlaylist
        : null;
    if (!importer) {
      setBanner({
        kind: 'error',
        text: 'Paste an Apple Music or SoundCloud playlist link.',
      });
      return;
    }
    setLinkImporting(true);
    try {
      const summary = await importer(activeProfileId, url);
      setLastImport(summary);
      setLinkUrl('');
    } catch (e) {
      setBanner({ kind: 'error', text: String(e) });
    } finally {
      setLinkImporting(false);
    }
  }, [linkUrl, activeProfileId]);

  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const show = (s: SectionMeta) => {
    // Sound effects (EQ / Mono) only work through the native engine, so only
    // surface the group when that beta is on.
    if (s === SECTIONS.sound && !nativeEngine) return false;
    // House-wide / destructive controls: owner only (also keeps them out of
    // search results for members).
    if (s.ownerOnly && !isOwner) return false;
    return searching ? s.terms.some((t) => t.includes(q)) : tab === s.cat;
  };
  const anyVisible = Object.values(SECTIONS).some(show);
  // A category shows in the rail only if it has at least one section this user is
  // allowed to see — so members simply don't get a Sharing or Advanced tab.
  const allSections = Object.values(SECTIONS) as SectionMeta[];
  const visibleCats = CATEGORIES.filter((c) =>
    allSections.some(
      (s) =>
        s.cat === c.id &&
        (!s.ownerOnly || isOwner) &&
        (s !== SECTIONS.sound || nativeEngine),
    ),
  );

  return (
    <div className="h-full flex">
      {/* Category rail — an iconed sidebar (macOS System Settings), with a
          search field that filters rows across every category at once. */}
      <nav className="w-52 shrink-0 overflow-auto border-r border-neutral-900 p-3">
        <h1 className="px-2 mb-3 text-lg font-bold tracking-tight">Settings</h1>
        <div className="mb-3 px-1">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search settings"
            className={cn(INPUT, 'w-full !py-1.5 !text-sm')}
          />
        </div>
        <div className="space-y-0.5">
          {visibleCats.map((c) => {
            const active = !searching && tab === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setTab(c.id);
                  setSearch('');
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition',
                  navPill(active),
                  active && 'font-medium',
                )}
              >
                <c.Icon className={cn('shrink-0', active ? 'text-neutral-200' : 'text-neutral-500')} />
                {c.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl">

      {banner && (
        <div
          className={
            banner.kind === 'error'
              ? cn(CALLOUT_ERROR, 'mb-6')
              : cn(CALLOUT_INFO, 'mb-6')
          }
        >
          {banner.text}
        </div>
      )}

      {/* -- Account ------------------------------------------------- */}
      {show(SECTIONS.account) && (
      <Group
        title="Account"
        description={
          isOwner
            ? 'Switch between profiles, edit or remove them, or add a new one.'
            : 'Switch profiles, or edit the one you’re signed into.'
        }
      >
        <div className="flex flex-col">
          {profiles.map((p, i) => {
            const current = p.id === activeProfileId;
            return (
              <div
                key={p.id}
                className={cn(
                  'flex items-center justify-between gap-3 py-2.5',
                  i > 0 && 'border-t border-white/10',
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 overflow-hidden rounded-lg text-base">
                    <AvatarSurface
                      name={p.name}
                      color={p.avatar_color}
                      avatarPath={p.avatar_path}
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {p.name}
                      {current && (
                        <span className="ml-2 text-xs font-normal text-neutral-500">
                          This profile
                        </span>
                      )}
                    </div>
                    {p.has_pin && (
                      <div className="text-xs text-neutral-500">
                        Protected with a PIN
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {current ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveProfile(null)}
                        className={BTN_GHOST}
                      >
                        Switch profile
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingProfile(p)}
                        className={BTN_SECONDARY}
                      >
                        Edit
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => switchTo(p)}
                        className={BTN_SECONDARY}
                      >
                        Switch
                      </button>
                      {/* Only the owner can manage other profiles; members see
                          a Switch and nothing else. */}
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => setEditingProfile(p)}
                          className={BTN_GHOST}
                        >
                          Edit
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {isOwner && (
            <button
              type="button"
              onClick={() => setEditingProfile('new')}
              className="flex items-center gap-3 border-t border-white/10 py-2.5 text-sm text-neutral-300 transition hover:text-neutral-100"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-dashed border-neutral-700 text-neutral-500">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              Add profile
            </button>
          )}
        </div>
      </Group>
      )}
      {editingProfile && (
        <ProfileForm
          profile={editingProfile === 'new' ? null : editingProfile}
          // Anyone may delete THEIR OWN profile; the owner may delete any.
          // Never the last one — the "who's listening?" gate needs an answer.
          canDelete={
            (isOwner ||
              (editingProfile !== 'new' &&
                editingProfile.id === activeProfileId)) &&
            profiles.length > 1
          }
          onClose={() => setEditingProfile(null)}
          onSaved={() => {
            setEditingProfile(null);
            // Tell the rest of the window (the top bar's avatar, chiefly) —
            // it holds its own copy and would otherwise wait for a focus
            // change to notice a rename or a new photo.
            notifyProfilesChanged();
            void ipc
              .listProfiles()
              .then((fresh) => {
                setProfiles(fresh);
                // The active profile no longer exists (someone deleted the
                // profile they were using) → back to "Who's listening?".
                if (
                  activeProfileId != null &&
                  !fresh.some((p) => p.id === activeProfileId)
                ) {
                  setActiveProfile(null);
                }
              })
              .catch(() => {});
          }}
        />
      )}

      {/* -- App behaviour ------------------------------------------- */}
      {show(SECTIONS.appbehaviour) && (
      <Group title="App behaviour">
        <Row
          label="Open at login"
          secondary="Start Beetbot automatically when you sign in to this Mac."
          control={
            autostartEnabled == null ? (
              <span className="text-xs text-neutral-500">Unavailable</span>
            ) : (
              <Toggle
                checked={autostartEnabled}
                onChange={(v) => void handleToggleAutostart(v)}
                ariaLabel="Open at login"
              />
            )
          }
        />
      </Group>
      )}

      {/* -- Personalize --------------------------------------------- */}
      {show(SECTIONS.personalize) && (
      <Group
        title="Personalize"
        footer="Your playlists, library, and downloads are left untouched — this only refreshes what Home suggests for this profile."
      >
        <Row
          label="Personalize home"
          secondary="Run the welcome setup again to refresh your music and what Home suggests."
          control={
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new Event('beetbot:rerun-onboarding'))
              }
              className={BTN_SECONDARY}
            >
              Start setup
            </button>
          }
        />
      </Group>
      )}

      {/* -- Playback ------------------------------------------------- */}
      {show(SECTIONS.crossfade) && (
      <Group title="Playback">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="crossfade" className="text-sm font-medium">
              Crossfade
            </label>
            <span className="text-sm text-neutral-400 tabular-nums">
              {crossfadeSeconds === 0 ? 'Off' : `${crossfadeSeconds}s`}
            </span>
          </div>
          <Slider
            id="crossfade"
            min={0}
            max={12}
            step={1}
            value={crossfadeSeconds}
            onChange={setCrossfadeSeconds}
          />
          <p className="text-xs text-neutral-500">
            Smoothly overlap the end of one song into the start of the next.
            Applies to local playback (not while casting).
          </p>
        </div>
        <Row
          divider
          label="Autoplay"
          secondary="When a playlist or song ends, keep going with similar music."
          control={
            <Toggle
              checked={autoplay}
              onChange={setAutoplay}
              ariaLabel="Autoplay"
            />
          }
        />
      </Group>
      )}

      {/* -- Native audio engine (beta) — powers the Sound effects --- */}
      {show(SECTIONS.nativeengine) && (
      <Group
        title="Native audio engine"
        footer="Turn this on to use the Equalizer, Normalize, and Mono sound effects. Still experimental."
      >
        <Row
          label="Use the native engine (beta)"
          secondary="Restart the current song after switching."
          control={
            <Toggle
              checked={nativeEngine}
              onChange={setNativeEngine}
              ariaLabel="Native audio engine (beta)"
            />
          }
        />
      </Group>
      )}

      {/* -- Sound (EQ / Normalize / Mono, opt-in) ------------------- */}
      {show(SECTIONS.sound) && (
      <Group
        title="Sound"
        footer="Audio effects are experimental. After turning one on, check that both downloaded and streamed songs still play."
      >
        <Row
          label="Normalize volume"
          secondary="Even out loud and quiet tracks."
          control={
            <Toggle
              checked={normalize}
              onChange={setNormalize}
              ariaLabel="Normalize volume"
            />
          }
        >
          {normalize && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-neutral-300">Loudness target</div>
              <Picker<Loudness>
                value={loudness}
                onChange={setLoudness}
                ariaLabel="Loudness target"
                options={[
                  { value: 'loud', label: 'Loud' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'quiet', label: 'Quiet' },
                ]}
              />
            </div>
          )}
        </Row>
        <Row
          divider
          label="Equalizer"
          secondary="Shape the tone across six bands."
          control={
            <Toggle checked={eqEnabled} onChange={setEqEnabled} ariaLabel="Equalizer" />
          }
        >
          {eqEnabled && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-neutral-300">Preset</div>
                <Picker<EqPreset>
                  value={eqPreset}
                  onChange={setEqPreset}
                  ariaLabel="Equalizer preset"
                  options={[
                    { value: 'flat', label: 'Flat' },
                    { value: 'bass', label: 'Bass boost' },
                    { value: 'vocal', label: 'Vocal' },
                    { value: 'treble', label: 'Treble' },
                    { value: 'lounge', label: 'Lounge' },
                    { value: 'custom', label: 'Custom' },
                  ]}
                />
              </div>
              <div className="space-y-2">
                {EQ_BANDS.map((b, i) => (
                  <div key={b.hz} className="flex items-center gap-3">
                    <span className="w-9 shrink-0 text-xs text-neutral-500 tabular-nums">
                      {b.label}
                    </span>
                    <input
                      type="range"
                      min={EQ_GAIN_MIN}
                      max={EQ_GAIN_MAX}
                      step={1}
                      value={eqGains[i] ?? 0}
                      onChange={(e) => setEqGain(i, Number(e.target.value))}
                      className={SLIDER}
                      aria-label={`${b.label} hertz band`}
                    />
                    <span className="w-9 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
                      {(eqGains[i] ?? 0) > 0 ? '+' : ''}
                      {eqGains[i] ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Row>
        <Row
          divider
          label="Mono audio"
          secondary="Play both channels through both speakers."
          control={<Toggle checked={mono} onChange={setMono} ariaLabel="Mono audio" />}
        />
      </Group>
      )}

      {/* -- Appearance: Zoom ---------------------------------------- */}
      {show(SECTIONS.zoom) && (
      <Group
        title="Zoom"
        description="Scale the whole interface. You can also use ⌘− / ⌘+ (⌘0 resets)."
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Interface zoom</div>
            <div className="mt-0.5 text-xs text-neutral-500 tabular-nums">
              Currently {Math.round(zoom * 100)}%
            </div>
          </div>
          <Segmented<ZoomChoice>
            value={zoomChoiceOf(zoom)}
            onChange={(v) => setZoom(ZOOM_CHOICES[v])}
            ariaLabel="Interface zoom"
            options={[
              { value: 'dense', label: 'Dense' },
              { value: 'default', label: 'Default' },
              { value: 'spacious', label: 'Spacious' },
            ]}
          />
        </div>
      </Group>
      )}

      {/* -- Appearance: Now Playing --------------------------------- */}
      {show(SECTIONS.nowplaying) && (
      <Group
        title="Now Playing"
        footer="When on, the full-window Now Playing view opens each time a new song starts."
      >
        <Row
          label="Open Now Playing on play"
          secondary="Jump to the full player when a song starts."
          control={
            <Toggle
              checked={openNowPlayingOnPlay}
              onChange={setOpenNowPlayingOnPlay}
              ariaLabel="Open Now Playing on play"
            />
          }
        />
      </Group>
      )}

      {/* -- Imports ------------------------------------------------- */}
      {show(SECTIONS.imports) && (
      <Group
        title="Imports"
        description="Bring your playlists in from Spotify, Apple Music, or SoundCloud."
      >
        {/* Spotify can't export itself — Exportify makes the zip in the
            browser; the numbered buttons carry the whole flow. */}
        <div className="text-sm font-medium text-neutral-200 mb-1">
          From Spotify
        </div>
        <p className="text-xs text-neutral-500 mb-3">
          Spotify can’t export on its own — Exportify does it in your browser,
          free and password-free.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenExportify}
            disabled={openingExportify}
            className={BTN_PRIMARY}
          >
            {openingExportify ? 'Opening…' : '1. Open Exportify'}
          </button>
          <span className="text-neutral-600">→</span>
          <button
            type="button"
            onClick={handleBulkImport}
            disabled={bulkImporting}
            className={BTN_SECONDARY}
          >
            {bulkImporting ? 'Importing…' : '2. Import the “Export All” zip'}
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          Just one playlist?{' '}
          <button
            type="button"
            onClick={handleImport}
            disabled={importing}
            className="text-neutral-300 underline hover:text-neutral-100 disabled:no-underline disabled:text-neutral-600"
          >
            {importing ? 'Importing…' : 'Import a single CSV'}
          </button>
          .
        </p>

        {/* Apple Music + SoundCloud share one box — routed by link host. */}
        <div className="mt-5 border-t border-neutral-900 pt-4">
          <div className="text-sm font-medium text-neutral-200 mb-1">
            From Apple Music or SoundCloud
          </div>
          <p className="text-xs text-neutral-500 mb-2">
            Paste a public playlist link (Share → Copy Link).
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !linkImporting) void handleLinkImport();
              }}
              placeholder="Paste playlist link here"
              className={cn(INPUT, 'flex-1 min-w-[16rem]')}
            />
            <button
              type="button"
              onClick={() => void handleLinkImport()}
              disabled={linkImporting || !linkUrl.trim()}
              className={BTN_SECONDARY}
            >
              {linkImporting ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
        {lastImport && (
          <div className={cn(CALLOUT_INFO, 'mt-3')}>
            Imported <strong>{lastImport.playlist_name}</strong>:{' '}
            {lastImport.tracks_added} new track
            {lastImport.tracks_added === 1 ? '' : 's'}, {lastImport.tracks_existing}{' '}
            already in library
            {lastImport.rows_skipped > 0
              ? `, ${lastImport.rows_skipped} row${
                  lastImport.rows_skipped === 1 ? '' : 's'
                } skipped`
              : ''}
            .
            {lastImport.truncated_total != null && (
              <div className="mt-2 text-amber-300">
                Heads up: the source playlist has {lastImport.truncated_total}{' '}
                songs but only the first{' '}
                {lastImport.tracks_added + lastImport.tracks_existing} were
                imported (import cap).
              </div>
            )}
          </div>
        )}
        {lastBulk && (
          <div className={cn(CALLOUT_INFO, 'mt-3')}>
            Imported <strong>{lastBulk.playlists_imported}</strong> playlist
            {lastBulk.playlists_imported === 1 ? '' : 's'} from zip ·{' '}
            {lastBulk.tracks_added} new songs, {lastBulk.tracks_existing} already
            in library.
            {lastBulk.failures.length > 0 && (
              <div className="mt-2 text-red-300">
                {lastBulk.failures.length} file
                {lastBulk.failures.length === 1 ? '' : 's'} failed:{' '}
                {lastBulk.failures.map((f) => f.file).join(', ')}
              </div>
            )}
          </div>
        )}
      </Group>
      )}


      {/* -- Library folder ------------------------------------------ */}
      {show(SECTIONS.folder) && (
      <Group
        title="Library folder"
        description="Where imported music is stored on disk."
      >
        <Row
          divider={canDownloadCap}
          label={
            downloadDir ?? (
              <span className="inline-block h-3.5 w-48 max-w-full rounded bg-neutral-800 animate-pulse align-middle" aria-label="Loading" />
            )
          }
          title={downloadDir ?? ''}
          secondary="Audio files you import are copied here."
          control={
            <button type="button" onClick={handlePickDownloadDir} className={BTN_GHOST}>
              Choose folder
            </button>
          }
        />
        {canDownloadCap && (
          <Row
            label="Auto-download songs in my playlists"
            secondary="Save songs to this folder as you add them, so they play without streaming."
            control={
              <Toggle
                checked={autoDownload}
                onChange={handleToggleAutoDownload}
                ariaLabel="Auto-download songs in my playlists"
              />
            }
          />
        )}
      </Group>
      )}

      {/* -- Storage ------------------------------------------------- */}
      {show(SECTIONS.storage) && (
      <Group
        title="Storage"
        description="Free up space used by streamed songs. Your downloaded library is never touched."
      >
        <Row
          label="Streaming cache"
          secondary="Temporary files from songs you streamed but didn’t download."
          control={
            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-400 tabular-nums">
                {fmtBytes(storage?.cache_bytes)}
              </span>
              <button
                type="button"
                onClick={handleClearCache}
                disabled={clearingCache || !storage?.cache_bytes}
                className={BTN_GHOST_DANGER}
              >
                {clearingCache ? 'Clearing…' : 'Clear'}
              </button>
            </div>
          }
        />
        <Row
          divider
          label="Downloaded library"
          secondary="Audio files stored on disk. Change where they live under Library folder."
          control={
            <span className="text-sm text-neutral-400 tabular-nums">
              {fmtBytes(storage?.downloads_bytes)}
            </span>
          }
        />
      </Group>
      )}

      {/* -- Backup & restore --------------------------------------- */}
      {show(SECTIONS.backup) && (
      <Group
        title="Backup & restore"
        description="Save your playlists to a file, restore them from one — or move the whole server, every profile and setting included, to a new machine."
      >
        <Row
          label="Library backup"
          secondary={
            <>
              A portable <code className={CODE_CHIP}>.json</code> snapshot.
              Restoring merges it in (nothing is overwritten).
            </>
          }
          control={
            <>
              <button
                type="button"
                onClick={handleImportBackup}
                className={BTN_GHOST}
              >
                Restore…
              </button>
              <button
                type="button"
                onClick={handleExportBackup}
                className={BTN_PRIMARY}
              >
                Back up…
              </button>
            </>
          }
        />
        <Row
          divider
          label="Move to a new server"
          secondary={
            <>
              The whole server — every profile, playlist, setting and listening
              history, optionally the audio — as one{' '}
              <code className={CODE_CHIP}>.zip</code>. Restoring replaces this
              server's library; the previous one is kept on disk as a rescue
              copy.
            </>
          }
          control={
            restartReady ? (
              <button
                type="button"
                onClick={() => void ipc.portableRestart()}
                className={BTN_PRIMARY}
              >
                Restart to finish
              </button>
            ) : (
              <>
                <label className="flex items-center gap-1.5 text-xs text-neutral-500 select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={portableAudio}
                    onChange={(e) => setPortableAudio(e.target.checked)}
                  />
                  Include audio
                </label>
                <button
                  type="button"
                  disabled={portableBusy}
                  onClick={handlePortableImport}
                  className={BTN_GHOST}
                >
                  Restore…
                </button>
                <button
                  type="button"
                  disabled={portableBusy}
                  onClick={handlePortableExport}
                  className={BTN_PRIMARY}
                >
                  {portableBusy ? 'Working…' : 'Export…'}
                </button>
              </>
            )
          }
        />
      </Group>
      )}

      {/* -- Listen on another device -------------------------------- */}
      {show(SECTIONS.remote) && (
      <Group
        title="Listen on another device"
        description="Open your library on your phone or laptop — at home or anywhere."
      >
        {/* The pluggable sharing provider is the recommended way to reach your
            library — it signs visitors in for you, so no code is needed. Its
            name and URL come from the host build at runtime; this core never
            names one. Rendered FIRST as the primary option. */}
        <ExternalSharingCard />
        {/* Beetbot's own direct link (an ngrok tunnel with a 6-digit code) is the
            fallback for people not using the provider above. Tucked into a
            disclosure so it isn't mistaken for a step the provider needs. */}
        <details className="mt-4">
          <summary className="cursor-pointer select-none text-xs text-neutral-500 hover:text-neutral-300">
            Other ways to connect — a direct link (needs a 6-digit code) →
          </summary>
        <div className="space-y-3 mt-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">
                {streamingStatus?.enabled ? 'Sharing is on' : 'Sharing is off'}
              </div>
              <div className="text-xs text-neutral-500 mt-0.5">
                {streamingStatus?.enabled
                  ? 'Scan the link below on your phone, then enter the pairing code.'
                  : 'Turn this on to play your library on another device.'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleToggleStreaming(!streamingStatus?.enabled)}
              className={streamingStatus?.enabled ? BTN_GHOST_DANGER : BTN_PRIMARY}
            >
              {streamingStatus?.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>
          {streamingStatus?.enabled && (
            ngrok?.running && ngrok.public_url ? (
              // ngrok connected: the primary "scan to connect" — trusted cert,
              // works on Wi-Fi AND from anywhere, no certificate install.
              <div className="flex gap-4 items-start pt-2">
                <div className="shrink-0 rounded-lg bg-white p-2">
                  <QRCodeSVG
                    value={
                      pairing?.pairing_required
                        ? `${ngrok.public_url}?pair=${pairing.code}`
                        : ngrok.public_url
                    }
                    size={160}
                    level="M"
                  />
                </div>
                <div className="space-y-2 text-sm">
                  <UrlRow label="Your link · works everywhere" url={ngrok.public_url} />
                  <p className="text-xs text-neutral-500 max-w-sm">
                    Scan on each device once — no certificate, no warnings. Then{' '}
                    <strong>Share → Add to Home Screen</strong> in Safari to install
                    it as an app (keeps audio playing when the screen locks).
                  </p>
                </div>
              </div>
            ) : ngrok?.has_authtoken ? (
              // Set up, but not connected this moment — show what's happening
              // right here instead of making them dig into setup.
              <div className="pt-2 text-sm">
                {ngrok.last_error ? (
                  <span className="text-red-300">{ngrok.last_error}</span>
                ) : (
                  <span className="text-neutral-400">Your link is connecting…</span>
                )}
              </div>
            ) : (
              <div className="text-xs text-neutral-500 pt-2">
                Set up your link in{' '}
                <strong className="text-neutral-300">Setup and advanced</strong> below
                to listen away from home — or use the local Wi-Fi option there.
              </div>
            )
          )}
          {pairing && pairing.pairing_required && (
            <PairingCodeBox pairing={pairing} />
          )}
          {streamingSessions.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-white/10">
              <div className={EYEBROW}>
                Connected devices
              </div>
              {streamingSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 text-sm py-1"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DeviceIcon label={s.device_label} />
                    <div className="min-w-0">
                      <div className="truncate">{s.device_label}</div>
                      <div className="text-xs text-neutral-500 truncate">
                        {s.ip_address} · last seen{' '}
                        {new Date(s.last_seen_at * 1000).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevokeStreamingSession(s.id)}
                    className="text-xs text-neutral-500 hover:text-red-400 shrink-0"
                  >
                    Revoke
                  </button>
                </div>
              ))}
              {streamingSessions.length > 1 && (
                <button
                  type="button"
                  onClick={handleSignOutAllDevices}
                  className="flex w-full items-center gap-2 pt-2 mt-1 border-t border-white/10 text-sm text-neutral-400 transition hover:text-red-400"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Sign out of all devices
                </button>
              )}
            </div>
          )}
          {/* Setup and advanced — phase-aware: the ngrok wizard is the hero
              until it's configured, then it collapses to one quiet row. Holds
              every "how it connects" control so the rest of the card stays
              about connecting a device, not configuring one. */}
          {streamingStatus?.enabled &&
            (!ngrok?.has_authtoken || showAdvancedRemote ? (
              <div className="pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className={EYEBROW}>
                    Setup and advanced
                  </div>
                  {ngrok?.has_authtoken && (
                    <button
                      type="button"
                      onClick={() => setShowAdvancedRemote(false)}
                      className={BTN_GHOST}
                    >
                      Hide
                    </button>
                  )}
                </div>
                {/* Paste an ngrok authtoken + domain and remote access turns on
                    by itself — the one setup most people need. */}
                <NgrokCard
                  status={ngrok}
                  tokenInput={ngrokTokenInput}
                  domainInput={ngrokDomainInput}
                  busy={ngrokBusy}
                  notice={ngrokNotice}
                  onTokenChange={setNgrokTokenInput}
                  onDomainChange={setNgrokDomainInput}
                  onSave={handleNgrokSave}
                  onClear={handleNgrokClear}
                />
                {/* Local Wi-Fi link (needs the one-time certificate) — the
                    fallback when the phone is on the same network as this Mac. */}
                <details className="text-xs">
                  <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-300">
                    On this Wi-Fi (local link, needs a certificate) →
                  </summary>
                  <div className="mt-2">
                    <DevicesUrls
                      streamingStatus={streamingStatus}
                      acmeHostname={SHOW_DUCKDNS ? (acme?.hostname ?? null) : null}
                      pairCode={pairing?.pairing_required ? pairing.code : null}
                    />
                  </div>
                </details>
                {/* Manual on/off (ngrok flips it for you) + LAN pairing. */}
                <RemoteStreamingCard
                  pairing={pairing}
                  busy={remoteBusy}
                  upnp={upnp}
                  goingLive={goingLive}
                  advanced
                  onGoLive={handleGoLive}
                  onToggleRemote={handleToggleRemoteStreaming}
                  onTogglePairing={handleTogglePairingRequired}
                />
                {SHOW_DUCKDNS && (
                  <>
                    <DdnsCard
                      status={ddns}
                      subdomainInput={ddnsSubdomainInput}
                      subdomainRef={ddnsSubdomainRef}
                      tokenInput={ddnsTokenInput}
                      busy={ddnsBusy}
                      notice={ddnsCardNotice}
                      onSubdomainChange={setDdnsSubdomainInput}
                      onTokenChange={setDdnsTokenInput}
                      onSave={handleDdnsSave}
                      onUpdateNow={handleDdnsUpdateNow}
                      onClear={handleDdnsClear}
                    />
                    <AcmeCard
                      status={acme}
                      ddnsConfigured={Boolean(ddns?.subdomain && ddns.has_token)}
                      contact={acmeContact}
                      staging={acmeStaging}
                      busy={acmeBusy}
                      onContactChange={setAcmeContact}
                      onStagingChange={setAcmeStaging}
                      onIssue={handleAcmeIssue}
                      onClear={handleAcmeClear}
                    />
                    <div className={cn(EYEBROW, 'mt-6 mb-2')}>
                      Network check
                    </div>
                    <div className={cn(CARD, 'p-4 space-y-3')}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-neutral-500">
                          Checks whether your home internet can accept connections
                          from outside — only needed for the self-hosting option
                          above. One quick test, and nothing is saved.
                        </div>
                        <button
                          type="button"
                          onClick={handleProbeNetwork}
                          disabled={probing}
                          className={cn(BTN_SECONDARY, 'shrink-0')}
                        >
                          {probing ? 'Probing…' : 'Check my network'}
                        </button>
                      </div>
                      {networkProbe && <NetworkProbeResult probe={networkProbe} />}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAdvancedRemote(true)}
                className="w-full text-left text-xs text-neutral-500 hover:text-neutral-300 pt-3 border-t border-white/10"
              >
                Setup and advanced — your link, local Wi-Fi, off switch →
              </button>
            ))}
        </div>
        </details>
      </Group>
      )}

      {/* Who else can open this server. Renders nothing unless the host build
          supplies a sharing provider AND it is connected, so the plain build is
          unchanged. Same panel the phone shows — see SharingPeoplePanel. */}
      {show(SECTIONS.people) && <SharingPeoplePanel />}

      {/* -- Logs ---------------------------------------------------- */}
      {show(SECTIONS.logs) && (
      <Group
        title="Logs"
        description="Rolling daily log file. Look here when something misbehaves."
      >
        <Row
          label={
            logDir ?? (
              <span className="inline-block h-3.5 w-48 max-w-full rounded bg-neutral-800 animate-pulse align-middle" aria-label="Loading" />
            )
          }
          title={logDir ?? ''}
          secondary="One file per day, oldest entries first."
          control={
            <button
              type="button"
              onClick={handleOpenLogDir}
              disabled={!logDir}
              className={BTN_GHOST}
            >
              Open in Finder
            </button>
          }
        />
        {securityLogPath && (
          <Row
            divider
            label="Security log"
            secondary={
              <>
                <div className="truncate" title={securityLogPath}>
                  {securityLogPath}
                </div>
                <div>Records rejected / forbidden remote-access attempts.</div>
              </>
            }
            control={
              <button
                type="button"
                onClick={handleOpenSecurityLog}
                className={BTN_GHOST}
              >
                Open in Finder
              </button>
            }
          />
        )}
      </Group>
      )}

      {/* -- Reset to defaults --------------------------------------- */}
      {show(SECTIONS.reset) && (
      <Group
        title="Reset"
        footer="Restores playback, sound, and appearance to their defaults. Your library, profiles, and connections are left untouched."
      >
        <Row
          label="Reset all settings"
          secondary="Crossfade, autoplay, sound effects, zoom, and now-playing."
          control={
            <button
              type="button"
              onClick={handleResetDefaults}
              className={resetArmed ? BTN_DANGER : BTN_GHOST_DANGER}
            >
              {resetArmed ? 'Confirm reset' : 'Reset'}
            </button>
          }
        />
      </Group>
      )}

      {searching && !anyVisible && (
        <div className={cn(CALLOUT_INFO, 'text-neutral-400')}>
          No settings match “{search.trim()}”.
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

function DevicesUrls({
  streamingStatus,
  acmeHostname,
  pairCode,
}: {
  streamingStatus: StreamingStatus;
  acmeHostname: string | null;
  /** Current 6-digit pairing code, or null when pairing isn't required.
   *  Folded into the connect-QR URL so one scan opens the app AND pairs. */
  pairCode: string | null;
}) {
  // If Let's Encrypt is configured, the DuckDNS hostname is the
  // best-of-all-worlds URL: trusted cert, works on LAN (via public DNS +
  // router hairpin) AND on cellular. Surface it as the primary QR.
  const lePublicUrl =
    acmeHostname && streamingStatus.https_port
      ? `https://${acmeHostname}:${streamingStatus.https_port}`
      : null;

  // When pairing is required, append the code to the QR target so scanning it
  // opens the web player and pairs in one step. The displayed/copyable URL
  // stays clean — only the QR image carries the code.
  const qrTarget = (url: string) =>
    pairCode ? `${url}?pair=${pairCode}` : url;

  return (
    <div className="space-y-4 pt-2">
      {lePublicUrl ? (
        <div className="flex gap-4 items-start">
          <div className="shrink-0 rounded-lg bg-white p-2">
            <QRCodeSVG value={qrTarget(lePublicUrl)} size={160} level="M" />
          </div>
          <div className="space-y-2 text-sm">
            <UrlRow label="Primary URL · works everywhere" url={lePublicUrl} />
            <p className="text-xs text-neutral-500 max-w-sm">
              Trusted Let&apos;s Encrypt cert, no warnings, no profile
              install. Scan it on each device once. Then{' '}
              <strong>Share → Add to Home Screen</strong> in iOS Safari to
              install as a PWA — keeps audio playing when the screen locks.
            </p>
          </div>
        </div>
      ) : (
        <>
          {streamingStatus.https_url && (
            <div className="flex gap-4 items-start">
              <div className="shrink-0 rounded-lg bg-white p-2">
                <QRCodeSVG value={qrTarget(streamingStatus.https_url)} size={144} level="M" />
              </div>
              <div className="space-y-2 text-sm">
                <UrlRow
                  label="HTTPS · LAN only"
                  url={streamingStatus.https_url}
                />
                <p className="text-xs text-neutral-500 max-w-sm">
                  This local link is for your home Wi-Fi only. On an iPhone,
                  install the certificate first (below) or Safari will block it.
                  For a no-warning link that also works away from home, set up{' '}
                  <strong className="text-neutral-300">Listen away from home</strong>{' '}
                  (ngrok) instead.
                </p>
              </div>
            </div>
          )}
          {streamingStatus.cert_install_url && (
            <details className="group">
              <summary className="cursor-pointer select-none text-xs text-neutral-400 hover:text-neutral-200">
                On iPhone (Wi-Fi)? Install the certificate first →
              </summary>
              <div className="flex gap-4 items-start mt-3 pl-1">
                <div className="shrink-0 rounded-lg bg-white p-2">
                  <QRCodeSVG
                    value={streamingStatus.cert_install_url}
                    size={120}
                    level="M"
                  />
                </div>
                <div className="space-y-2 text-sm">
                  <UrlRow label="Cert install" url={streamingStatus.cert_install_url} />
                  <p className="text-xs text-neutral-500 max-w-sm">
                    Walks an iPhone through trusting the self-signed certificate
                    so Safari stops blocking the LAN URL. Not needed if you set
                    up DuckDNS + Let&apos;s Encrypt.
                  </p>
                </div>
              </div>
            </details>
          )}
        </>
      )}

      {/* When LE *is* configured, keep the LAN fallback URLs around as a
          collapsed footnote -- useful when the public path is broken
          (e.g. router rebooting) and you just want to hit the box over
          Wi-Fi. */}
      {lePublicUrl && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">
            LAN fallback URLs
          </summary>
          <div className="mt-2 space-y-1 pl-4">
            {streamingStatus.https_url && (
              <div>
                HTTPS (cert warning):{' '}
                <code className={CODE_CHIP}>
                  {streamingStatus.https_url}
                </code>
              </div>
            )}
            {streamingStatus.hostname_url && (
              <div>
                HTTP:{' '}
                <code className={CODE_CHIP}>
                  {streamingStatus.hostname_url}
                </code>
              </div>
            )}
            {streamingStatus.lan_url && (
              <div>
                HTTP (IP):{' '}
                <code className={CODE_CHIP}>{streamingStatus.lan_url}</code>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function PairingCodeBox({ pairing }: { pairing: PairingInfo }) {
  // Tick the countdown locally every second so it's live, and re-sync whenever a
  // fresh poll arrives (new code or updated server countdown).
  const [remaining, setRemaining] = useState(pairing.seconds_until_rotation);
  useEffect(() => {
    setRemaining(pairing.seconds_until_rotation);
  }, [pairing.seconds_until_rotation, pairing.code]);
  useEffect(() => {
    const id = setInterval(() => setRemaining((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);
  // Copy the raw 6 digits (no display spacing) so it pastes cleanly on the phone.
  const [copied, setCopied] = useState(false);
  const copyCode = useCallback(() => {
    void navigator.clipboard?.writeText(pairing.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [pairing.code]);
  return (
    <div className="rounded-lg border border-white/10 bg-neutral-900/50 px-4 py-3">
      <div className={cn(EYEBROW, 'mb-1')}>
        Pairing code
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="font-mono text-3xl tracking-[0.4em] text-neutral-100 select-text"
            aria-label="6-digit pairing code"
          >
            {pairing.code}
          </div>
          <button
            type="button"
            onClick={copyCode}
            className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-white/5 hover:text-neutral-100"
            aria-label="Copy pairing code"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div className="text-[11px] text-neutral-400 tabular-nums whitespace-nowrap">
          rotates in {remaining}s
        </div>
      </div>
      <p className="text-[11px] text-neutral-400 mt-2">
        Enter this on your phone when prompted. The code rotates every 5
        minutes; old codes stop working immediately.
      </p>
    </div>
  );
}

function RemoteStreamingCard({
  pairing,
  busy,
  upnp,
  goingLive,
  advanced,
  onGoLive,
  onToggleRemote,
  onTogglePairing,
}: {
  pairing: PairingInfo | null;
  busy: boolean;
  upnp: UpnpStatus | null;
  goingLive: boolean;
  advanced: boolean;
  onGoLive: () => void;
  onToggleRemote: (v: boolean) => void;
  onTogglePairing: (v: boolean) => void;
}) {
  const remote = Boolean(pairing?.remote_streaming_enabled);
  const pairingRequired = Boolean(pairing?.pairing_required);
  // UPnP opened the ports for us only when remote is on AND the mapping took.
  const upnpMapped = remote && Boolean(upnp?.mapped);
  const upnpFailed = remote && upnp != null && !upnp.mapped;
  return (
    <div className="mt-4 rounded-lg border border-white/10 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Remote streaming</h3>
        <p className="text-xs text-neutral-500 mt-0.5">
          When this is on, your library can be reached from outside your home.
          Every device — even phones on your own Wi-Fi — has to enter your
          pairing code first. Setting up remote access below turns this on for
          you automatically.
        </p>
      </div>
      {/* The DuckDNS one-button setup + its port-forward status. This is the route
          to recommend for real listening: no monthly cap and nothing between the
          listener and the music. */}
      {advanced && SHOW_DUCKDNS && (
        <>
          <div className="rounded-lg border border-neutral-800 p-3 space-y-1">
            <h3 className="text-sm font-medium">
              Your own address (best for everyday listening)
            </h3>
            <p className="text-xs text-neutral-500">
              Your music travels straight from this Mac to your phone, with no
              service in between and nothing to run out. Beetbot claims a free
              address, gets a certificate for it, and opens the router port for you.
              It needs a router that allows this — most home routers do — so it takes
              a minute longer to set up than the quick link above, and then it keeps
              working.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoLive}
            disabled={goingLive || busy}
            className={cn(BTN_PRIMARY, 'w-full')}
          >
            {goingLive ? 'Going live…' : 'Set up my own address'}
          </button>
          {upnpMapped && (
            <div className={cn(CALLOUT_INFO, 'text-[11px]')}>
              Router ports opened automatically via UPnP
              {upnp?.external_ip ? ` · your address: ${upnp.external_ip}` : ''}.
            </div>
          )}
          {upnpFailed && (
            <div className={cn(CALLOUT_WARN, 'text-[11px]')}>
              UPnP couldn&apos;t open the ports automatically — forward{' '}
              <strong>47823</strong> and <strong>47824</strong> (TCP) to this Mac
              on your router.
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-sm">
          Remote streaming is{' '}
          <strong className={remote ? 'text-neutral-200' : 'text-neutral-400'}>
            {remote ? 'ON' : 'OFF'}
          </strong>
        </div>
        <button
          type="button"
          onClick={() => onToggleRemote(!remote)}
          disabled={busy}
          className={remote ? BTN_GHOST_DANGER : BTN_PRIMARY}
        >
          {remote ? 'Disable' : 'Enable'}
        </button>
      </div>
      {/* Only a real choice when remote streaming is OFF — when it's on, pairing
          on LAN is forced, so the toggle would just sit there disabled. */}
      {!remote && (
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/10">
          <div className="min-w-0">
            <div className="text-sm">Require pairing on LAN too</div>
            <p className="text-[11px] text-neutral-500">
              Forces phones on your Wi-Fi to enter the pairing code as well.
            </p>
          </div>
          <Toggle
            checked={pairingRequired}
            onChange={onTogglePairing}
            disabled={busy}
            ariaLabel="Require pairing on LAN too"
          />
        </div>
      )}
    </div>
  );
}

function AcmeCard({
  status,
  ddnsConfigured,
  contact,
  staging,
  busy,
  onContactChange,
  onStagingChange,
  onIssue,
  onClear,
}: {
  status: AcmeStatus | null;
  ddnsConfigured: boolean;
  contact: string;
  staging: boolean;
  busy: boolean;
  onContactChange: (v: string) => void;
  onStagingChange: (v: boolean) => void;
  onIssue: () => void;
  onClear: () => void;
}) {
  const hasCert = Boolean(status?.has_cert);
  return (
    <div className="mt-4 rounded-lg border border-white/10 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Let&apos;s Encrypt certificate</h3>
        <p className="text-xs text-neutral-500 mt-0.5">
          Browser-trusted HTTPS cert for the DuckDNS hostname. No more
          self-signed warnings on iPhone. Issuance takes 30–90 seconds
          (DNS-01 challenge via your DuckDNS token). The HTTPS server picks up
          the new cert right away.
        </p>
      </div>
      {!ddnsConfigured && (
        <div className={cn(CALLOUT_WARN, 'text-xs')}>
          Configure DuckDNS first — the cert is bound to that hostname.
        </div>
      )}
      <div className="flex gap-2 flex-wrap items-center">
        <input
          type="email"
          value={contact}
          onChange={(e) => onContactChange(e.target.value)}
          placeholder="contact email (optional)"
          disabled={busy}
          className={cn(INPUT, 'flex-1 min-w-[14rem] disabled:opacity-50')}
        />
        <label className="flex items-center gap-1.5 text-xs text-neutral-400 px-2">
          <input
            type="checkbox"
            checked={staging}
            onChange={(e) => onStagingChange(e.target.checked)}
            disabled={busy}
          />
          Staging (test, untrusted)
        </label>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={onIssue}
          disabled={!ddnsConfigured || busy}
          className={BTN_PRIMARY}
        >
          {busy ? 'Issuing…' : hasCert ? 'Re-issue cert' : 'Issue cert'}
        </button>
        {hasCert && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className={BTN_GHOST_DANGER}
          >
            Clear
          </button>
        )}
      </div>
      {status && hasCert && (
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs pt-2 border-t border-white/10">
          <dt className="text-neutral-500">Cert for</dt>
          <dd>
            {status.hostname ? (
              <code className={CODE_CHIP}>
                {status.hostname}
              </code>
            ) : (
              '—'
            )}
          </dd>
          <dt className="text-neutral-500">HTTPS URL</dt>
          <dd>
            <code className={CODE_CHIP}>
              https://{status.hostname ?? '<your-host>'}:47824
            </code>
          </dd>
        </dl>
      )}
      {status?.last_error && (
        <div className={cn(CALLOUT_ERROR, 'text-xs break-words')}>
          Last error: {status.last_error}
        </div>
      )}
    </div>
  );
}

function DdnsCard({
  status,
  subdomainInput,
  subdomainRef,
  tokenInput,
  busy,
  notice,
  onSubdomainChange,
  onTokenChange,
  onSave,
  onUpdateNow,
  onClear,
}: {
  status: DdnsStatus | null;
  subdomainInput: string;
  subdomainRef: React.RefObject<HTMLInputElement | null>;
  tokenInput: string;
  busy: boolean;
  notice: { kind: 'info' | 'error'; text: string } | null;
  onSubdomainChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onSave: () => void;
  onUpdateNow: () => void;
  onClear: () => void;
}) {
  const configured = Boolean(status?.subdomain && status.has_token);
  return (
    <div className="mt-4 rounded-lg border border-white/10 p-4 space-y-3">
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Advanced: connect without a relay (DuckDNS)</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            Most people should use the simple setup above. This is the technical
            route — your phone connects straight to your Mac with no middleman (a
            little faster), but it needs a free DuckDNS account and sometimes a
            router change. Skip it unless you know you want it.
          </p>
        </div>
        <ol className="text-xs text-neutral-400 space-y-1.5 list-decimal pl-4 leading-relaxed">
          <li>
            Sign in to DuckDNS with GitHub or Google.{' '}
            <button
              type="button"
              onClick={() => void openUrl('https://www.duckdns.org')}
              className="text-neutral-300 underline hover:text-neutral-100"
            >
              Open duckdns.org →
            </button>
          </li>
          <li>
            Type a subdomain (e.g.{' '}
            <code className={CODE_CHIP}>my-music</code>) and click{' '}
            <strong className="text-neutral-300">add domain</strong>.
          </li>
          <li>
            Copy the <strong className="text-neutral-300">token</strong> shown at
            the top of the DuckDNS page.
          </li>
          <li>
            Paste your subdomain + token below and{' '}
            <strong className="text-neutral-300">Save</strong>.
          </li>
          <li>
            Hit the green <strong className="text-neutral-300">Go live anywhere</strong>{' '}
            button above — it points the hostname here, opens your router ports,
            gets a trusted HTTPS certificate, and turns remote access on.
          </li>
        </ol>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
        <div className="relative">
          <input
            ref={subdomainRef}
            type="text"
            value={subdomainInput}
            onChange={(e) => onSubdomainChange(e.target.value)}
            placeholder="subdomain"
            className={cn(INPUT, 'w-full pr-28')}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500 pointer-events-none">
            .duckdns.org
          </span>
        </div>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder={status?.has_token ? 'token saved · paste to replace' : 'token'}
          className={cn(INPUT, 'w-56')}
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !subdomainInput.trim() || !tokenInput.trim()}
          className={BTN_PRIMARY}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onUpdateNow}
          disabled={busy || !configured}
          className={BTN_SECONDARY}
        >
          {busy ? 'Working…' : 'Update now'}
        </button>
        {configured && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className={BTN_GHOST_DANGER}
          >
            Clear
          </button>
        )}
      </div>
      {notice && (
        <div
          className={
            notice.kind === 'error'
              ? cn(CALLOUT_ERROR, 'text-xs')
              : cn(CALLOUT_INFO, 'text-xs')
          }
        >
          {notice.text}
        </div>
      )}
      {status && configured && (
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs pt-2 border-t border-white/10">
          <dt className="text-neutral-500">Hostname</dt>
          <dd>
            <code className={CODE_CHIP}>
              {status.hostname}
            </code>
          </dd>
          {status.last_ip && (
            <>
              <dt className="text-neutral-500">Last pushed IP</dt>
              <dd className="font-mono text-neutral-200">{status.last_ip}</dd>
            </>
          )}
          {status.last_update_at && (
            <>
              <dt className="text-neutral-500">Last update</dt>
              <dd className="text-neutral-200">
                {new Date(status.last_update_at * 1000).toLocaleString()}
              </dd>
            </>
          )}
          {status.last_error && (
            <>
              <dt className="text-red-400">Last error</dt>
              <dd className="text-red-200 break-words">{status.last_error}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function NgrokCard({
  status,
  tokenInput,
  domainInput,
  busy,
  notice,
  onTokenChange,
  onDomainChange,
  onSave,
  onClear,
}: {
  status: NgrokStatus | null;
  tokenInput: string;
  domainInput: string;
  busy: boolean;
  notice: { kind: 'info' | 'error'; text: string } | null;
  onTokenChange: (v: string) => void;
  onDomainChange: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const configured = Boolean(status?.has_authtoken);
  // Pure setup form. The connect block above owns the live status (QR / link /
  // "connecting" / problem), and the "Setup and advanced" disclosure owns the
  // collapse — so this card simply *is* the wizard whenever it's on screen.
  return (
    <div className="rounded-lg border border-white/10 p-4 space-y-3">
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">
            Quick link (good for trying it out)
          </h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            A private, secure link to this Mac — on your Wi-Fi and away from home,
            no router settings, nothing extra to install. Make a free account and
            paste in two things; Beetbot handles the rest.
          </p>
          <p className="text-xs text-amber-300/80 mt-1.5">
            Worth knowing before you set this up: ngrok’s free plan includes 1 GB a
            month, which is roughly <strong>seven hours of listening</strong> — under
            three if your music is lossless. When it runs out, ngrok turns visitors
            away and your music stops until the month resets. For everyday listening,
            use the router route below instead — it has no limit.
          </p>
        </div>
        <ol className="text-xs text-neutral-400 space-y-1.5 list-decimal pl-4 leading-relaxed">
          <li>
            Make a free account with ngrok (the service that powers the link).{' '}
            <button
              type="button"
              onClick={() => void openUrl('https://dashboard.ngrok.com/signup')}
              className="text-neutral-300 underline hover:text-neutral-100"
            >
              Open the sign-up page →
            </button>
          </li>
          <li>
            On the welcome screen, copy your{' '}
            <strong className="text-neutral-300">authtoken</strong> — a long code
            that’s your key for the link — and paste it in the first box below.
          </li>
          <li>
            Open <strong className="text-neutral-300">Domains</strong> in their menu
            and click to claim your free web address (it looks like{' '}
            <code className={CODE_CHIP}>yourname.ngrok-free.dev</code>). Paste
            it in the second box — this keeps your link the same every time.
          </li>
          <li>
            Press <strong className="text-neutral-300">Save</strong>. That’s it —
            remote access switches on by itself and your link appears above.
          </li>
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-2">
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder={configured ? 'saved · paste a new code to replace' : 'paste your authtoken (the long code)'}
          className={cn(INPUT, 'w-full')}
        />
        <input
          type="text"
          value={domainInput}
          onChange={(e) => onDomainChange(e.target.value)}
          placeholder="paste your web address (yourname.ngrok-free.dev)"
          className={cn(INPUT, 'w-full')}
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !domainInput.trim() || (!tokenInput.trim() && !configured)}
          className={BTN_PRIMARY}
        >
          {busy ? 'Working…' : 'Save'}
        </button>
        {configured && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className={BTN_GHOST_DANGER}
          >
            Clear
          </button>
        )}
      </div>
      {notice && (
        <div
          className={
            notice.kind === 'error'
              ? cn(CALLOUT_ERROR, 'text-xs')
              : cn(CALLOUT_INFO, 'text-xs')
          }
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}

function NetworkProbeResult({ probe }: { probe: NetworkProbe }) {
  const verdictCallout = (() => {
    switch (probe.verdict) {
      case 'remote-reachable':
        return CALLOUT_INFO;
      case 'needs-manual-port-forward':
        return CALLOUT_WARN;
      case 'blocked-by-cgnat':
      case 'no-internet':
        return CALLOUT_ERROR;
    }
  })();
  const verdictText = (() => {
    switch (probe.verdict) {
      case 'remote-reachable':
        return 'Remote streaming looks possible on this network.';
      case 'needs-manual-port-forward':
        return 'Public IP works, but UPnP didn’t answer. Manual router port-forwarding required.';
      case 'blocked-by-cgnat':
        return 'Your ISP uses carrier-grade NAT. Self-hosted remote streaming isn’t possible.';
      case 'no-internet':
        return 'Couldn’t reach the public-IP service. Offline or DNS-blocked?';
    }
  })();
  return (
    <div className="space-y-3 pt-2 border-t border-white/10">
      <div className={verdictCallout}>
        {verdictText}
      </div>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-xs">
        <dt className="text-neutral-500">LAN IP</dt>
        <dd className="font-mono text-neutral-200">{probe.lan_ip ?? '—'}</dd>
        <dt className="text-neutral-500">Public IP</dt>
        <dd className="font-mono text-neutral-200">{probe.public_ip ?? '—'}</dd>
        <dt className="text-neutral-500">CGNAT?</dt>
        <dd className="text-neutral-200">
          {probe.cgnat_likely ? 'Yes (100.64.0.0/10)' : 'No'}
        </dd>
        <dt className="text-neutral-500">UPnP available</dt>
        <dd className="text-neutral-200">{probe.upnp_available ? 'Yes' : 'No'}</dd>
        {probe.upnp_external_ip && (
          <>
            <dt className="text-neutral-500">Router WAN IP</dt>
            <dd className="font-mono text-neutral-200">{probe.upnp_external_ip}</dd>
          </>
        )}
      </dl>
      {probe.notes.length > 0 && (
        <ul className="text-xs text-neutral-400 space-y-1 list-disc pl-4">
          {probe.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Brand-neutral card for an optional pluggable sharing provider. It knows
 * nothing about any specific provider: it renders only when the host build
 * supplies the `external_sharing_status` command, and every provider-specific
 * string (its name, the URL) comes from that response at runtime. In the plain
 * open-core build the command is absent, so this renders nothing.
 */
function ExternalSharingCard() {
  // `undefined` = still loading; `null` = command absent (open-core build) so
  // the card renders nothing; otherwise the live provider status.
  const [status, setStatus] = useState<ExternalSharingStatus | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await ipc.externalSharingStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the card in sync with the provider's real state. It can change on the
  // provider side at any time — an approval landing, the owner revoking, or the
  // provider restarting and reloading its routes — so poll whenever the provider
  // is present, not only while we're waiting for approval. Otherwise the card
  // can drift: showing "off" while the provider is actually still sharing.
  const isPresent = Boolean(status);
  useEffect(() => {
    if (!isPresent) return;
    const id = setInterval(() => {
      void load();
    }, 4_000);
    return () => clearInterval(id);
  }, [isPresent, load]);

  const handleToggle = useCallback(async (enable: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const next = enable
        ? await ipc.externalSharingEnable()
        : await ipc.externalSharingDisable();
      setStatus(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  if (status === undefined || status === null) return null;

  const { available, state, providerName, url } = status;
  const isOn = state !== 'off';
  // In a conflict, name the contested address when we have it — a household can
  // have several devices sharing and the host says which one this fight is over.
  const conflictHost = (() => {
    if (!url) return 'your address';
    try {
      return new URL(url).host;
    } catch {
      return 'your address';
    }
  })();
  const statusLine =
    state === 'live'
      ? `Live through ${providerName}.`
      : state === 'pending'
        ? `Waiting for you to approve this in ${providerName}.`
        : state === 'conflict'
          ? `Another device on your account is serving ${conflictHost} — visitors reach that device's library, not this one. Turn off sharing there to move it here.`
          : available
            ? `Reach your library anywhere through ${providerName} — it signs visitors in for you, so there's no code to enter.`
            : `${providerName} isn't running right now.`;

  return (
    <div className="mt-3 rounded-lg border border-neutral-800 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            Share through {providerName}
          </div>
          <div
            className={
              state === 'conflict'
                ? 'text-xs text-amber-400 mt-0.5'
                : 'text-xs text-neutral-500 mt-0.5'
            }
          >
            {statusLine}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || (!isOn && !available)}
          onClick={() => handleToggle(!isOn)}
          className={
            'shrink-0 whitespace-nowrap ' +
            (isOn
              ? 'rounded-lg px-3 py-2 text-sm text-neutral-300 hover:text-red-400 border border-neutral-800 disabled:opacity-50'
              : 'rounded-lg px-4 py-2 bg-neutral-100 hover:bg-white text-neutral-950 font-medium transition disabled:opacity-50')
          }
        >
          {busy ? 'Working…' : isOn ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {state === 'live' && url && (
        <div className="flex gap-4 items-start pt-2">
          <div className="shrink-0 rounded-lg bg-white p-2">
            <QRCodeSVG value={url} size={160} level="M" />
          </div>
          <div className="space-y-2 text-sm">
            <UrlRow label={`Your link · via ${providerName}`} url={url} />
          </div>
        </div>
      )}
      {error && <div className="text-sm text-red-300 pt-1">{error}</div>}
    </div>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div>
      <div className={EYEBROW}>{label}</div>
      <div className="flex items-center gap-2">
        <code className={CODE_CHIP}>
          {url}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url);
          }}
          className="text-xs text-neutral-500 hover:text-neutral-200"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

// Outline glyph for a connected device, keyed off the session's device_label
// (iPhone / iPad / Android / Mac / Windows / Linux / fallback — produced by
// label_from_user_agent on the server). Lucide-style stroke; color inherits.
function DeviceIcon({ label }: { label: string }) {
  const lc = label.toLowerCase();
  const glyph =
    lc.includes('iphone') || lc.includes('android') ? (
      <>
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <path d="M12 18h.01" />
      </>
    ) : lc.includes('ipad') ? (
      <>
        <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
        <path d="M12 18h.01" />
      </>
    ) : lc.includes('mac') ? (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" ry="2" />
        <line x1="2" y1="20" x2="22" y2="20" />
      </>
    ) : lc.includes('windows') || lc.includes('linux') ? (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    ) : (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20" />
      </>
    );
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-neutral-400"
    >
      {glyph}
    </svg>
  );
}
