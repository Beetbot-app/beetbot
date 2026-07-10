-- Phase 3, step 13: full-text search across the track library.
--
-- Backed by SQLite FTS5 as an external content table -- tracks remains the
-- canonical row store; tracks_fts is a synchronised search index. Triggers
-- keep the two in lockstep, and the seed INSERT backfills any rows that
-- already exist when this migration runs.

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title,
  artists,
  album,
  content='tracks',
  content_rowid='id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artists, album)
  VALUES (new.id, new.title, new.artists, new.album);
END;

CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artists, album)
  VALUES ('delete', old.id, old.title, old.artists, old.album);
END;

CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artists, album)
  VALUES ('delete', old.id, old.title, old.artists, old.album);
  INSERT INTO tracks_fts(rowid, title, artists, album)
  VALUES (new.id, new.title, new.artists, new.album);
END;

-- Seed from existing rows (no-op on a fresh DB).
INSERT INTO tracks_fts(rowid, title, artists, album)
  SELECT id, title, artists, album FROM tracks;
