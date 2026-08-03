import { useEffect } from 'react';
import { usePlayerStore } from '@/lib/store';

/** How far ← / → nudge playback, and how much ↑ / ↓ move the volume. */
const SEEK_SECONDS = 5;
const VOLUME_STEP = 0.05;

/** True when focus is in a field where the keystroke is text, not a command —
 *  so Space types a space in search and arrows move the caret / a slider. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  const tag = node.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable ||
    node.getAttribute?.('role') === 'textbox'
  );
}

/**
 * Global media keyboard shortcuts for the desktop player. Every action goes
 * through the player store — including seek via `setCurrentTime`, which the
 * PlayerBar already mirrors onto the <audio> element (the same path the macOS
 * Control Center scrubber uses), so it works regardless of the audio engine.
 *
 * Shortcuts (ignored while typing in a field):
 *   Space              play / pause
 *   → / ←              seek +5s / -5s
 *   Shift+→ / Shift+←  next / previous track
 *   ↑ / ↓              volume up / down
 *   S                  shuffle on / off
 *   R                  repeat off → all → one
 *   M                  mute / unmute (remembers the pre-mute level)
 *
 * `⌘`/`Ctrl` combos are left alone so the app's zoom (⌘ + / - / 0) and other
 * system shortcuts keep working.
 */
export function usePlayerHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't fight ⌘/Ctrl combos
      const s = usePlayerStore.getState();

      switch (e.key) {
        case ' ':
        case 'Spacebar': // older WebKit
          if (e.repeat) return; // holding Space must not rapid-toggle
          e.preventDefault(); // stops page scroll AND a focused button's own Space-activation
          s.playPause();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) s.next();
          else s.setCurrentTime(Math.min(s.duration || Number.MAX_SAFE_INTEGER, s.currentTime + SEEK_SECONDS));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) s.prev();
          else s.setCurrentTime(Math.max(0, s.currentTime - SEEK_SECONDS));
          break;
        case 'ArrowUp':
          if (e.shiftKey) return;
          e.preventDefault();
          s.setVolume(Math.min(1, s.volume + VOLUME_STEP));
          break;
        case 'ArrowDown':
          if (e.shiftKey) return;
          e.preventDefault();
          s.setVolume(Math.max(0, s.volume - VOLUME_STEP));
          break;
        case 's':
        case 'S':
          if (e.repeat) return;
          e.preventDefault();
          s.toggleShuffle();
          break;
        case 'r':
        case 'R':
          if (e.repeat) return;
          e.preventDefault();
          s.toggleRepeat();
          break;
        case 'm':
        case 'M':
          if (e.repeat) return;
          e.preventDefault();
          s.toggleMute();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
