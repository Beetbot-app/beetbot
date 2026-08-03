import { create } from 'zustand';

/**
 * Desktop audio-effects SETTINGS (Equalizer, Normalize, Mono).
 *
 * The Web Audio implementation that used to live here was removed: on macOS
 * WebKit it silently bypasses streamed tracks (WebKit #180696), bypasses the
 * volume slider once an element is tapped, and glitches playback speed on
 * output-device sample-rate changes (WebKit #232728). This module is now
 * settings-only — the preferences, presets, and reset — kept intact so the
 * planned native Rust audio engine (~/Downloads/beetbot-native-audio-plan.md)
 * can drive them without rebuilding the UI. The Settings "Sound" group stays
 * hidden (SHOW_SOUND_FX in Settings.tsx) until that engine backs it.
 *
 * These are personal taste, so they persist PER PROFILE (a { [profileId]: fx }
 * map): one listener's EQ/normalize shouldn't reshape everyone's sound. The
 * active profile's slice is mirrored as reactive fields; `setProfile(id)` swaps
 * it and is wired from App.tsx alongside the pins/saved/appearance stores.
 */

export const EQ_BANDS = [
  { hz: 60, label: '60' },
  { hz: 230, label: '230' },
  { hz: 910, label: '910' },
  { hz: 3600, label: '3.6k' },
  { hz: 8000, label: '8k' },
  { hz: 14000, label: '14k' },
] as const;
export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;

export type EqPreset = 'flat' | 'bass' | 'vocal' | 'treble' | 'lounge' | 'custom';
export const EQ_PRESETS: Record<Exclude<EqPreset, 'custom'>, number[]> = {
  flat: [0, 0, 0, 0, 0, 0],
  bass: [6, 4, 1, 0, 0, 0],
  vocal: [-2, 0, 3, 3, 1, 0],
  treble: [0, 0, 0, 2, 4, 6],
  lounge: [4, 2, -1, -2, 1, 4],
};

export type Loudness = 'loud' | 'normal' | 'quiet';
/**
 * Integrated-loudness targets in LUFS for the native engine's Normalize. The
 * per-track gain moves each measured track toward its target (louder = closer to
 * 0), ceilinged by the track's true peak so it never clips.
 */
export const LOUDNESS_TARGET_LUFS: Record<Loudness, number> = {
  loud: -11,
  normal: -14,
  quiet: -19,
};

/** The per-profile slice — the effect settings that follow each profile. */
type FxPrefs = {
  eqEnabled: boolean;
  eqPreset: EqPreset;
  eqGains: number[];
  mono: boolean;
  normalize: boolean;
  loudness: Loudness;
};
const FX_DEFAULTS: FxPrefs = {
  eqEnabled: false,
  eqPreset: 'flat',
  eqGains: [...EQ_PRESETS.flat],
  mono: false,
  normalize: false,
  loudness: 'normal',
};

// One localStorage key holds a { [profileId]: FxPrefs } map; LEGACY_KEY is the
// old global zustand-persist blob we migrate away from once.
const FX_KEY = 'beetbot.desktop.audiofx.byProfile';
const LEGACY_KEY = 'beetbot.desktop.audiofx';
type ByProfile = Record<string, FxPrefs>;

function loadMap(): ByProfile {
  try {
    return JSON.parse(localStorage.getItem(FX_KEY) || '{}') as ByProfile;
  } catch {
    return {};
  }
}
function saveMap(map: ByProfile): void {
  try {
    localStorage.setItem(FX_KEY, JSON.stringify(map));
  } catch {
    /* storage may be blocked; the effects just won't survive a relaunch */
  }
}

/** One-time upgrade: fold the old global effects blob into the owner's slot
 *  (profile 1) so an update keeps the existing sound. Runs until FX_KEY exists. */
function migrateLegacy(map: ByProfile): ByProfile {
  if (localStorage.getItem(FX_KEY) != null) return map;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as { state?: Partial<FxPrefs> };
      const st = (blob?.state ?? blob) as Partial<FxPrefs>;
      map = {
        ...map,
        '1': {
          eqEnabled: st.eqEnabled === true,
          eqPreset: st.eqPreset ?? 'flat',
          eqGains: Array.isArray(st.eqGains) ? [...st.eqGains] : [...EQ_PRESETS.flat],
          mono: st.mono === true,
          normalize: st.normalize === true,
          loudness: st.loudness ?? 'normal',
        },
      };
    }
  } catch {
    /* unreadable legacy blob → start clean */
  }
  saveMap(map);
  return map;
}

let map = migrateLegacy(loadMap());

function slice(id: number | null): FxPrefs {
  return id == null ? FX_DEFAULTS : (map[String(id)] ?? FX_DEFAULTS);
}

interface AudioFxState extends FxPrefs {
  /** Active profile whose effects are mirrored below (null before sign-in). */
  profileId: number | null;
  /** Load a profile's effect settings into the store. Called on every switch. */
  setProfile: (id: number | null) => void;
  setEqEnabled: (v: boolean) => void;
  setEqPreset: (p: EqPreset) => void;
  setEqGain: (i: number, dB: number) => void;
  setMono: (v: boolean) => void;
  setNormalize: (v: boolean) => void;
  setLoudness: (l: Loudness) => void;
  /** Turn every effect off and restore the flat/normal defaults (active profile). */
  reset: () => void;
}

export const useAudioFxStore = create<AudioFxState>()((set, get) => {
  /** Write the current effect fields back to the active profile's slot. */
  const persistActive = (next: FxPrefs) => {
    const { profileId } = get();
    if (profileId != null) {
      map = { ...map, [String(profileId)]: next };
      saveMap(map);
    }
  };
  const current = (): FxPrefs => {
    const s = get();
    return {
      eqEnabled: s.eqEnabled,
      eqPreset: s.eqPreset,
      eqGains: s.eqGains,
      mono: s.mono,
      normalize: s.normalize,
      loudness: s.loudness,
    };
  };
  return {
    ...FX_DEFAULTS,
    profileId: null,
    setProfile: (id) => set({ profileId: id, ...slice(id) }),
    setEqEnabled: (v) => {
      set({ eqEnabled: v });
      persistActive({ ...current(), eqEnabled: v });
    },
    setEqPreset: (p) => {
      const patch =
        p === 'custom'
          ? { eqPreset: 'custom' as EqPreset }
          : { eqPreset: p, eqGains: [...EQ_PRESETS[p]] };
      set(patch);
      persistActive({ ...current(), ...patch });
    },
    setEqGain: (i, dB) => {
      const eqGains = [...get().eqGains];
      eqGains[i] = dB;
      set({ eqGains, eqPreset: 'custom' });
      persistActive({ ...current(), eqGains, eqPreset: 'custom' });
    },
    setMono: (v) => {
      set({ mono: v });
      persistActive({ ...current(), mono: v });
    },
    setNormalize: (v) => {
      set({ normalize: v });
      persistActive({ ...current(), normalize: v });
    },
    setLoudness: (l) => {
      set({ loudness: l });
      persistActive({ ...current(), loudness: l });
    },
    reset: () => {
      const next = { ...FX_DEFAULTS, eqGains: [...EQ_PRESETS.flat] };
      set(next);
      persistActive(next);
    },
  };
});
