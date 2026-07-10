/** Format a track duration in milliseconds as "M:SS" (or "H:MM:SS"). */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format a playlist's total duration as "X hr Y min" or "Y min". */
export function formatTotalDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/** "in 59m", "in 3h", "expired" — for the token countdown. */
export function formatExpiry(epoch: number | null): string {
  if (!epoch) return 'unknown';
  const diff = epoch * 1000 - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}
