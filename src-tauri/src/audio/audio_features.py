#!/usr/bin/env python3
"""Beetbot Phase 4 audio feature extractor (Signal 2: "sounds-like").

Decodes each audio file via ffmpeg to mono PCM and computes a compact
timbral / rhythmic / harmonic feature vector using ONLY numpy + scipy
(deliberately no librosa, to avoid a heavy numba/llvmlite install — the hub
already ships ffmpeg and the user's Python has numpy+scipy).

BATCH MODE: one process handles many files so the ~1s numpy/scipy import cost
is amortised across the batch. Emits one JSON object per line (JSONL) to stdout:
  {"path": "...", "ok": true,  "features": { ... }}
  {"path": "...", "ok": false, "error": "..."}
A failure on one file never aborts the rest of the batch.

Usage: audio_features.py <ffmpeg_path> <file1> [<file2> ...]
"""
import sys
import json
import subprocess

import numpy as np
from scipy.fft import rfft, rfftfreq, dct

SR = 22050          # analysis sample rate
N_FFT = 2048
HOP = 512
N_MELS = 40
N_MFCC = 13
MAX_SECONDS = 90    # analyse up to 90s from the file's centre (representative + fast)

FEATURES_VERSION = 1


def decode(ffmpeg, path):
    """Decode `path` to a mono float64 waveform at SR via ffmpeg (central slice)."""
    cmd = [ffmpeg, "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(SR),
           "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True).stdout
    x = np.frombuffer(out, dtype=np.float32).astype(np.float64)
    if x.size == 0:
        raise RuntimeError("empty decode (missing/DRM/unsupported file?)")
    maxn = MAX_SECONDS * SR
    if x.size > maxn:
        s = (x.size - maxn) // 2
        x = x[s:s + maxn]
    return x


def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def _mel_filterbank(sr, n_fft, n_mels):
    mels = np.linspace(_hz_to_mel(0), _hz_to_mel(sr / 2), n_mels + 2)
    hz = _mel_to_hz(mels)
    bins = np.floor((n_fft + 1) * hz / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        c = max(c, l + 1)
        r = max(r, c + 1)
        for k in range(l, c):
            if 0 <= k < fb.shape[1]:
                fb[m - 1, k] = (k - l) / (c - l)
        for k in range(c, r):
            if 0 <= k < fb.shape[1]:
                fb[m - 1, k] = (r - k) / (r - c)
    return fb


# Built once and reused across every file in the batch.
_FB = _mel_filterbank(SR, N_FFT, N_MELS)
_FREQS = rfftfreq(N_FFT, 1.0 / SR)
_WIN = np.hanning(N_FFT)


def features_for(ffmpeg, path):
    x = decode(ffmpeg, path)
    peak = np.max(np.abs(x))
    # Reject effectively-silent input: with no signal the spectral/tempo features
    # collapse to a degenerate constant vector (e.g. a phantom 215 BPM from the
    # autocorrelation argmax landing at lag 0), which would form a fake "cluster"
    # in the similarity space. Better to fail it out than to store junk.
    if peak < 1e-4:
        raise RuntimeError("silent/near-silent audio")
    x = x / peak
    nf = 1 + (len(x) - N_FFT) // HOP
    if nf < 4:
        raise RuntimeError("clip too short to analyse")
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(nf)[:, None]
    fr = x[idx] * _WIN
    mag = np.abs(rfft(fr, axis=1))
    power = mag ** 2
    freqs = _FREQS

    rms = float(np.sqrt(np.mean(x ** 2)))
    zcr = float(np.mean((np.abs(np.diff(np.sign(x))) > 0).astype(np.float64)))

    msum = np.sum(mag, axis=1) + 1e-9
    centroid = np.sum(freqs[None, :] * mag, axis=1) / msum
    bandwidth = np.sqrt(np.sum(((freqs[None, :] - centroid[:, None]) ** 2) * mag, axis=1) / msum)
    cum = np.cumsum(mag, axis=1)
    roll_idx = np.argmax(cum >= 0.85 * cum[:, -1:], axis=1)
    rolloff = freqs[roll_idx]
    gmean = np.exp(np.mean(np.log(mag + 1e-9), axis=1))
    flatness = gmean / (np.mean(mag, axis=1) + 1e-9)

    logmel = np.log(power @ _FB.T + 1e-9)
    mfcc = dct(logmel, type=2, axis=1, norm="ortho")[:, :N_MFCC]
    mfcc_mean = np.mean(mfcc, axis=0)

    valid = freqs > 0
    midi = np.zeros_like(freqs)
    midi[valid] = 69 + 12 * np.log2(freqs[valid] / 440.0)
    pc = np.mod(np.round(midi).astype(int), 12)
    ebin = np.mean(mag, axis=0)
    chroma = np.zeros(12)
    np.add.at(chroma, pc[valid], ebin[valid])
    if chroma.sum() > 0:
        chroma = chroma / chroma.sum()

    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
    flux = flux - np.mean(flux)
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    fps = SR / HOP
    lo, hi = int(fps * 60 / 200), int(fps * 60 / 60)
    tempo = 0.0
    if len(ac) > hi > lo:
        seg = ac[lo:hi]
        if seg.size:
            lag = lo + int(np.argmax(seg))
            if lag > 0:
                tempo = float(60 * fps / lag)

    return {
        "version": FEATURES_VERSION,
        "duration": round(float(len(x) / SR), 1),
        "tempo": round(tempo, 1),
        "rms": round(rms, 5),
        "zcr": round(zcr, 5),
        "centroid": round(float(np.mean(centroid)), 2),
        "bandwidth": round(float(np.mean(bandwidth)), 2),
        "rolloff": round(float(np.mean(rolloff)), 2),
        "flatness": round(float(np.mean(flatness)), 5),
        "mfcc": [round(float(v), 4) for v in mfcc_mean],
        "chroma": [round(float(v), 5) for v in chroma],
    }


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: audio_features.py <ffmpeg> <file...>\n")
        sys.exit(2)
    ffmpeg = sys.argv[1]
    for path in sys.argv[2:]:
        try:
            feats = features_for(ffmpeg, path)
            line = {"path": path, "ok": True, "features": feats}
        except Exception as e:  # noqa: BLE001 — one bad file must not kill the batch
            line = {"path": path, "ok": False, "error": str(e)[:200]}
        sys.stdout.write(json.dumps(line) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
