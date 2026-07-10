//! Real-time DSP for the native engine: a 6-band EQ, mono downmix, and a safety
//! limiter, applied as a rodio `Source` adapter (`FxChain`). Parameters are
//! shared lock-free via atomics (`FxShared`); biquad coefficients are recomputed
//! only when a gain actually changes (`generation` counter), never per sample.
//!
//! The chain buffers one frame (all channels) at a time so per-channel EQ and
//! the mono downmix are clean without needing the inner source to be
//! frame-aligned. It runs on the audio callback thread, so everything here is
//! allocation-free on the hot path (the frame buffer is reused) and panic-free.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, Hertz, Type};
use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

/// The six EQ band centre frequencies (Hz), matching the UI's EQ_BANDS.
const BAND_HZ: [f32; 6] = [60.0, 230.0, 910.0, 3600.0, 8000.0, 14000.0];

/// Shared, lock-free FX parameters. The engine thread updates these on
/// engine_set_fx; each deck's `FxChain` reads them.
pub struct FxShared {
    eq_enabled: AtomicBool,
    mono: AtomicBool,
    gains_db: [AtomicU32; 6], // f32 bits
    normalize: AtomicBool,
    target_lufs: AtomicU32,   // f32 bits — loudness target for Normalize
    generation: AtomicU64,    // bumped on any change → FxChain recomputes coeffs
}

impl FxShared {
    pub fn new() -> Self {
        FxShared {
            eq_enabled: AtomicBool::new(false),
            mono: AtomicBool::new(false),
            gains_db: std::array::from_fn(|_| AtomicU32::new(0)),
            normalize: AtomicBool::new(false),
            target_lufs: AtomicU32::new((-14.0f32).to_bits()),
            generation: AtomicU64::new(0),
        }
    }

    /// Update all FX parameters at once (called off the audio thread).
    pub fn set(&self, eq_enabled: bool, gains: [f32; 6], mono: bool, normalize: bool, target_lufs: f32) {
        self.eq_enabled.store(eq_enabled, Ordering::Relaxed);
        self.mono.store(mono, Ordering::Relaxed);
        for (i, g) in gains.iter().enumerate() {
            self.gains_db[i].store(g.to_bits(), Ordering::Relaxed);
        }
        self.normalize.store(normalize, Ordering::Relaxed);
        self.target_lufs.store(target_lufs.to_bits(), Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn gain(&self, i: usize) -> f32 {
        f32::from_bits(self.gains_db[i].load(Ordering::Relaxed))
    }

    fn normalize(&self) -> bool {
        self.normalize.load(Ordering::Relaxed)
    }

    fn target_lufs(&self) -> f32 {
        f32::from_bits(self.target_lufs.load(Ordering::Relaxed))
    }
}

fn make_coeffs(fs: f32, band: usize, gain_db: f32) -> Option<Coefficients<f32>> {
    let fsh = Hertz::<f32>::from_hz(fs).ok()?;
    let f0 = Hertz::<f32>::from_hz(BAND_HZ[band]).ok()?;
    let ty = if band == 0 {
        Type::LowShelf(gain_db)
    } else if band == BAND_HZ.len() - 1 {
        Type::HighShelf(gain_db)
    } else {
        Type::PeakingEQ(gain_db)
    };
    Coefficients::<f32>::from_params(ty, fsh, f0, 1.0).ok()
}

fn init_filters(fs: f32) -> [DirectForm1<f32>; 6] {
    std::array::from_fn(|i| {
        // 0 dB (flat) init; falls back to a benign 1 kHz peak if the rate is odd.
        let c = make_coeffs(fs, i, 0.0)
            .or_else(|| make_coeffs(44_100.0, i.min(4).max(1), 0.0))
            .unwrap_or_else(|| {
                Coefficients::<f32>::from_params(
                    Type::PeakingEQ(0.0),
                    Hertz::<f32>::from_hz(44_100.0).unwrap(),
                    Hertz::<f32>::from_hz(1_000.0).unwrap(),
                    1.0,
                )
                .unwrap()
            });
        DirectForm1::<f32>::new(c)
    })
}

/// EQ + mono + Normalize gain + limiter wrapped around an inner source.
pub struct FxChain<S> {
    inner: S,
    shared: Arc<FxShared>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    nchan: usize,
    fs: f32,
    filters: Vec<[DirectForm1<f32>; 6]>,
    seen_gen: u64,
    frame: Vec<f32>,
    pos: usize,
    // Per-track loudness (constant for this deck's lifetime); None = unmeasured,
    // so no Normalize gain is applied.
    track_lufs: Option<f32>,
    track_peak_db: Option<f32>,
    // Cached linear Normalize gain (recomputed with the coeffs on a gen change).
    norm_gain: f32,
}

impl<S: Source> FxChain<S> {
    pub fn new(
        inner: S,
        shared: Arc<FxShared>,
        track_lufs: Option<f32>,
        track_peak_db: Option<f32>,
    ) -> Self {
        let channels = inner.channels();
        let sample_rate = inner.sample_rate();
        let nchan = channels.get() as usize;
        let fs = sample_rate.get() as f32;
        let filters = (0..nchan).map(|_| init_filters(fs)).collect();
        FxChain {
            inner,
            shared,
            channels,
            sample_rate,
            nchan,
            fs,
            filters,
            seen_gen: u64::MAX, // force a first recompute
            frame: Vec::with_capacity(nchan),
            pos: 0,
            track_lufs,
            track_peak_db,
            norm_gain: 1.0,
        }
    }

    fn recompute(&mut self) {
        let gains: [f32; 6] = std::array::from_fn(|i| self.shared.gain(i));
        for filters in self.filters.iter_mut() {
            for (i, f) in filters.iter_mut().enumerate() {
                if let Some(c) = make_coeffs(self.fs, i, gains[i]) {
                    f.update_coefficients(c);
                }
            }
        }
        self.norm_gain = self.compute_norm_gain();
        self.seen_gen = self.shared.generation.load(Ordering::Acquire);
    }

    /// Static gain toward the loudness target, ceilinged by the track's true
    /// peak (never boost past -1 dBTP) and clamped to a sane range. 1.0 when
    /// Normalize is off or the track is unmeasured.
    fn compute_norm_gain(&self) -> f32 {
        let lufs = match self.track_lufs {
            Some(l) if l.is_finite() => l,
            _ => return 1.0,
        };
        if !self.shared.normalize() {
            return 1.0;
        }
        let mut gain_db = self.shared.target_lufs() - lufs;
        if let Some(peak) = self.track_peak_db {
            let headroom = -1.0 - peak; // largest boost that keeps peaks ≤ -1 dBTP
            if gain_db > headroom {
                gain_db = headroom;
            }
        }
        gain_db = gain_db.clamp(-15.0, 12.0);
        10f32.powf(gain_db / 20.0)
    }

    /// Read one frame from the inner source and apply DSP. Returns false at EOS.
    fn refill(&mut self) -> bool {
        self.frame.clear();
        for _ in 0..self.nchan {
            match self.inner.next() {
                Some(s) => self.frame.push(s),
                None => return false,
            }
        }
        if self.shared.generation.load(Ordering::Acquire) != self.seen_gen {
            self.recompute();
        }
        if self.shared.eq_enabled.load(Ordering::Relaxed) {
            for (s, filters) in self.frame.iter_mut().zip(self.filters.iter_mut()) {
                let mut x = *s;
                for f in filters.iter_mut() {
                    x = f.run(x);
                }
                *s = x;
            }
        }
        if self.shared.mono.load(Ordering::Relaxed) && self.nchan > 1 {
            let avg = self.frame.iter().sum::<f32>() / self.nchan as f32;
            for s in self.frame.iter_mut() {
                *s = avg;
            }
        }
        // Normalize: static per-track gain toward the loudness target.
        if self.norm_gain != 1.0 {
            for s in self.frame.iter_mut() {
                *s *= self.norm_gain;
            }
        }
        // Safety limiter: an EQ boost can push past ±1; hard-clamp to avoid wrap.
        for s in self.frame.iter_mut() {
            *s = s.clamp(-1.0, 1.0);
        }
        self.pos = 0;
        true
    }
}

impl<S: Source> Iterator for FxChain<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.pos >= self.frame.len() && !self.refill() {
            return None;
        }
        let s = self.frame[self.pos];
        self.pos += 1;
        Some(s)
    }
}

impl<S: Source> Source for FxChain<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.frame.clear();
        self.pos = 0;
        self.inner.try_seek(pos)
    }
}
