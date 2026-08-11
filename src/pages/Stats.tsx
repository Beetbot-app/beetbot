import { StatsScreen } from '@shared/components/StatsScreen';
import { setApiBase } from '@shared/api';
import { useProfileStore } from '@/lib/profile';
import { useSession } from '@/lib/session';

// The shared StatsScreen fetches over the loopback HTTP server (same as Home /
// Browse). Idempotent with their calls; safe to repeat.
setApiBase('http://127.0.0.1:47823');

/**
 * Desktop wrapper around the shared `StatsScreen` (listening "Wrapped").
 * Same shape as `HomePage`: bootstrap a session token, hand the shared
 * component the active profile. Reached from the TopBar account menu; `onBack`
 * routes through the global history so Back/Forward behave like every other
 * view.
 */
export function StatsPage({ onBack }: { onBack: () => void }) {
  const { token, error } = useSession();
  const activeProfileId = useProfileStore((s) => s.activeProfileId);

  if (error) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div>
          <h2 className="text-lg font-semibold mb-2">Stats unavailable</h2>
          <p className="text-sm text-neutral-400 break-all">{error}</p>
        </div>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="h-full grid place-items-center text-sm text-neutral-500">
        Connecting…
      </div>
    );
  }

  return (
    // No wrapping scroller: StatsScreen owns one, below its header, so the
    // scrollbar spans the numbers rather than the whole card.
    <>
      {/* Desktop hides the in-header back chevron — the global top-bar
          Back/Forward already covers it. */}
      <StatsScreen
        token={token}
        profileId={activeProfileId}
        onBack={onBack}
        showBack={false}
        ownScroller
      />
    </>
  );
}
