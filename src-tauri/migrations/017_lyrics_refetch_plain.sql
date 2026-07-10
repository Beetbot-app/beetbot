-- NetEase Cloud Music became the primary lyrics source: far faster (~1.5s vs
-- LRCLIB's 6-12s) and it usually carries a synced LRC where LRCLIB only had
-- plain text (e.g. "The Real Slim Shady"). Drop the plain-only and not-found
-- cache rows so they re-fetch through NetEase and can upgrade to synced. Keep
-- rows that already have synced lyrics, and keep instrumental rows (nothing to
-- gain by re-confirming them). The pre-warm pass + normal playback refill these.
DELETE FROM lyrics_cache WHERE synced IS NULL AND instrumental = 0;
