-- Phase 4 (Signal 2: "sounds-like"): per-downloaded-file audio feature vectors,
-- extracted by the numpy/scipy sidecar (src/audio/audio_features.py) which decodes
-- through ffmpeg. One row per analysed local track; the full vector lives in the
-- `features` JSON, with the key scalars promoted to columns for quick inspection.
CREATE TABLE track_features (
    track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    tempo        REAL,
    rms          REAL,
    zcr          REAL,
    centroid     REAL,
    bandwidth    REAL,
    rolloff      REAL,
    flatness     REAL,
    features     TEXT NOT NULL,
    extracted_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Files the extractor could not analyse (missing on disk / DRM / too short).
-- Tracked so the background sweep doesn't retry them every pass.
CREATE TABLE track_features_failed (
    track_id  INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    reason    TEXT,
    failed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
