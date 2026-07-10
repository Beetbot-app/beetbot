import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
/** Loudness targets — kept for the native engine's per-track gain. */
export const LOUDNESS_GAIN: Record<Loudness, number> = {
  loud: 0.95,
  normal: 0.8,
  quiet: 0.6,
};

interface AudioFxState {
  eqEnabled: boolean;
  eqPreset: EqPreset;
  eqGains: number[];
  mono: boolean;
  normalize: boolean;
  loudness: Loudness;
  setEqEnabled: (v: boolean) => void;
  setEqPreset: (p: EqPreset) => void;
  setEqGain: (i: number, dB: number) => void;
  setMono: (v: boolean) => void;
  setNormalize: (v: boolean) => void;
  setLoudness: (l: Loudness) => void;
  /** Turn every effect off and restore the flat/normal defaults. */
  reset: () => void;
}

export const useAudioFxStore = create<AudioFxState>()(
  persist(
    (set) => ({
      eqEnabled: false,
      eqPreset: 'flat',
      eqGains: [...EQ_PRESETS.flat],
      mono: false,
      normalize: false,
      loudness: 'normal',
      setEqEnabled: (v) => set({ eqEnabled: v }),
      setEqPreset: (p) =>
        set(p === 'custom' ? { eqPreset: 'custom' } : { eqPreset: p, eqGains: [...EQ_PRESETS[p]] }),
      setEqGain: (i, dB) =>
        set((s) => {
          const eqGains = [...s.eqGains];
          eqGains[i] = dB;
          return { eqGains, eqPreset: 'custom' };
        }),
      setMono: (v) => set({ mono: v }),
      setNormalize: (v) => set({ normalize: v }),
      setLoudness: (l) => set({ loudness: l }),
      reset: () =>
        set({
          eqEnabled: false,
          eqPreset: 'flat',
          eqGains: [...EQ_PRESETS.flat],
          mono: false,
          normalize: false,
          loudness: 'normal',
        }),
    }),
    {
      name: 'beetbot.desktop.audiofx',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
