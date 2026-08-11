-- Which shelf last showed an impressed item. The table records exposure per
-- item (N0) but never said WHERE — so "is Under the radar ever played from?"
-- was unanswerable, and per-shelf play-through (docs/home-feed.md, build order
-- phase 1) had nothing to group by. Last-writer-wins is deliberate: an item
-- migrating between shelves is rare, and the current shelf is the one whose
-- effectiveness the report is judging.
ALTER TABLE home_impressions ADD COLUMN shelf TEXT;
