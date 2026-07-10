-- Phase 0 (discovery / Signal 4 prerequisite): capture HOW MUCH of each logged
-- play was listened to, so later phases can weight taste by completion and treat
-- skips as a negative signal. The row is still INSERTed at the ~20s threshold
-- (see log_play); these columns are filled in by a follow-up "finish" report on
-- track end/skip. Existing rows keep 0/0 ("completion unknown"), which callers
-- treat as neutral.
ALTER TABLE play_events ADD COLUMN ms_played INTEGER NOT NULL DEFAULT 0;
ALTER TABLE play_events ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
