import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '@/lib/store';
import { useUiStore } from '@/lib/ui';
import { useLyrics } from '@/lib/useLyrics';
import { LyricsView } from '@shared/components/LyricsView';
import { TabBtn } from '@shared/components/TabBtn';
import { QueuePanel } from '@/components/QueuePanel';
import { ConnectPanel } from '@/components/ConnectPanel';

/**
 * Docked right bar — the quick, non-fullscreen surface. Opened by the player
 * bar's lyrics / queue buttons; shows the synced lyrics or the up-next queue
 * while the rest of the app stays put. (The fullscreen takeover lives in
 * NowPlayingView.) Frosted glass to match the chrome.
 *
 * Open/close animates like the left sidebar: the panel's WIDTH transitions
 * (so `main` smoothly gives/reclaims room) while a fixed-width content column
 * stays pinned to the RIGHT and gets clipped — the mirror of the sidebar's
 * left-pinned collapse. Always mounted here (App renders it unconditionally);
 * it self-manages an enter/exit so the close slide can finish before it
 * unmounts (which also keeps it out of the flex `gap` when fully closed).
 */
export function RightBar() {
  const rightBar = useUiStore((s) => s.rightBar);
  const open = rightBar !== 'closed';
  const tab: 'lyrics' | 'queue' | 'connect' =
    rightBar === 'closed' ? 'lyrics' : rightBar;
  // Freeze the tab while closing so a queue→closed slide doesn't flash to
  // Lyrics for the 200ms it's still on screen.
  const tabRef = useRef<'lyrics' | 'queue' | 'connect'>(tab);
  if (open) tabRef.current = tab;

  // `mounted` = node present (kept alive through the exit slide); `shown` =
  // at full width (drives the width class). Enter: mount at w-0, then flip to
  // full on the next frame so the transition actually runs. Exit: collapse to
  // w-0, then unmount after the transition.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  return (
    <aside
      aria-hidden={!open}
      className={`${
        shown ? 'w-[22rem] max-w-[34vw]' : 'w-0'
      } shrink-0 h-full overflow-hidden flex flex-col items-end bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 transition-[width] duration-200 ${
        // Border/rounding only while it has width, so a w-0 frame never shows a
        // 1px sliver — the floating card look.
        shown ? 'rounded-2xl border border-white/10' : ''
      }`}
    >
      {/* Fixed-width content column, pinned RIGHT (items-end above): as the
          aside's width animates, this stays put and the empty space collapses
          on the LEFT — the mirror of the sidebar's left-pinned collapse. */}
      <div className="w-[22rem] max-w-[34vw] flex-1 min-h-0 flex flex-col pt-3">
        <RightBarPanel tab={tabRef.current} />
      </div>
    </aside>
  );
}

/** The panel body. Split out so its data hooks (lyrics fetch, queue selectors,
 *  the per-tick currentTime re-render) only run while the bar is mounted. */
function RightBarPanel({ tab }: { tab: 'lyrics' | 'queue' | 'connect' }) {
  const setTab = useUiStore((s) => s.setRightBar);
  const close = useUiStore((s) => s.closeRightBar);

  const { lyrics, loading } = useLyrics();
  const currentTime = usePlayerStore((s) => s.currentTime);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);

  return (
    <>
      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between border-b border-white/5">
        <div className="flex items-center gap-1">
          <TabBtn active={tab === 'lyrics'} onClick={() => setTab('lyrics')}>
            Lyrics
          </TabBtn>
          <TabBtn active={tab === 'queue'} onClick={() => setTab('queue')}>
            Up next
          </TabBtn>
          <TabBtn active={tab === 'connect'} onClick={() => setTab('connect')}>
            Connect
          </TabBtn>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          title="Close"
          className="h-8 w-8 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 px-3 py-2 overflow-hidden">
        {tab === 'lyrics' ? (
          <LyricsView
            lyrics={lyrics}
            currentTime={currentTime}
            loading={loading}
            onSeekTo={(s) => setCurrentTime(s)}
            compact
          />
        ) : tab === 'queue' ? (
          <QueuePanel />
        ) : (
          <ConnectPanel />
        )}
      </div>
    </>
  );
}

