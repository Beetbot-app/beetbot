-- Rename the "Liked Songs" playlist to "Favorites".
--
-- The app standardizes on the Apple-style star = "Favorites" metaphor. This is a
-- DISPLAY-NAME change only: the playlist is identified everywhere by its stable
-- spotify_id (`csv:liked-songs` / `liked:<profile>`) and the derived
-- source='liked', neither of which is touched here — so every existing like is
-- preserved. Scoped to the stable id so a user's own playlist that happens to be
-- named "Liked Songs" is never renamed.
UPDATE playlists
SET name = 'Favorites'
WHERE lower(name) IN ('liked songs', 'liked_songs')
  AND (spotify_id = 'csv:liked-songs' OR spotify_id LIKE 'liked:%');
