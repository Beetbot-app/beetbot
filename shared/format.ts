/**
 * Shared formatting helpers used by both the desktop bundle and the
 * phone web-player bundle.
 *
 * The two bundles used to ship near-duplicate format.ts files. They
 * both live here now; bundle-specific extras (`formatTotalDuration`,
 * `formatExpiry`) stay in the desktop's `@/lib/format.ts`.
 */

/** Format a duration in milliseconds as "M:SS" (or "H:MM:SS"). */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
