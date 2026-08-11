import { useEffect, useRef, useState } from 'react';
import {
  getSignInUrl,
  isHubReachable,
  onHubReachability,
  onSignInRequired,
  pingHub,
} from '@shared/api';

/**
 * The connection banner's state machine.
 *
 * The phone is a *client* of the user's home server (the desktop app), so there
 * are two independent things that can be down, and the banner has to tell them
 * apart:
 *   - `device-offline` — this phone has no internet at all (airplane mode, no
 *     signal). navigator.onLine drives it.
 *   - `hub-offline`    — the phone is online, but the home server isn't
 *     answering (desktop asleep / powered off / off the LAN / tunnel down).
 *     Browsing still works via the metadata fallback; playing your library and
 *     saving don't.
 *   - `signed-out`     — the phone reached the far end and was turned back for
 *     want of a session. NOT the same as the server being down, and the
 *     difference matters: the computer is fine and the fix is on this phone.
 *     Reported as `hub-offline` before 30 Jul 2026, which sent the owner to
 *     debug a working machine.
 *   - `reconnected`    — a transient success pulse shown once when the server
 *     comes back after either kind of outage (the user's explicit ask).
 *   - `online`         — everything reachable; no banner.
 */
export type ConnPhase =
  | 'online'
  | 'device-offline'
  | 'hub-offline'
  | 'signed-out'
  | 'reconnected';

/** How long the "Back online" pulse stays up before it fades on its own. */
const RECONNECT_PULSE_MS = 3200;

function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/**
 * Derive the connection phase from two live signals:
 *   1. navigator.onLine (+ its online/offline events) → device internet.
 *   2. the shared hub-reachability flag, which the Player's 2s heartbeat and
 *      every catalog read keep fresh (see sendHeartbeat / hubFirst). That flag
 *      is already debounced at the source (HUB_DOWN_GRACE_MS) so a single slow
 *      beat can't flap it — the hook trusts it directly, no second grace layer.
 * plus an on-demand re-probe when the tab refocuses or the device reconnects,
 * so we don't wait a whole beat to notice recovery.
 *
 * The reconnect pulse is gated on the hub *actually* being reachable again
 * (`!deviceOnline || !hubOnline`), not on a device-only signal — so a phone
 * that regains internet while the desktop is still asleep shows "can't reach
 * your library", never a false "back online".
 */
export function useConnectivity(token: string | null): ConnPhase {
  const [deviceOnline, setDeviceOnline] = useState(readOnline);
  const [hubOnline, setHubOnline] = useState(isHubReachable);
  const [reconnected, setReconnected] = useState(false);
  const [signInAt, setSignInAt] = useState<string | null>(getSignInUrl);

  // The gate's own answer, surfaced by pingHub / the heartbeat.
  useEffect(() => onSignInRequired(setSignInAt), []);

  // Did the user actually see an offline banner this cycle? Gates the reconnect
  // pulse so it never fires on the first successful connect at launch.
  const wasOffline = useRef(false);
  const pulseTimer = useRef<number | null>(null);

  // 1. Device internet. On regaining it, re-probe the hub at once instead of
  //    waiting for the next heartbeat; the probe flows back through the shared
  //    flag → onHubReachability below.
  useEffect(() => {
    const goOnline = () => {
      setDeviceOnline(true);
      if (token) void pingHub(token);
    };
    const goOffline = () => setDeviceOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [token]);

  // 2. Hub reachability, pushed from the shared (debounced) flag.
  useEffect(() => onHubReachability(setHubOnline), []);

  // 3. Re-probe when the app comes back to the foreground — interval timers are
  //    throttled/frozen while backgrounded, so the flag can be stale on return.
  //
  //    visibilitychange alone is not enough on a home-screen PWA. iOS restores
  //    a standalone app from a snapshot: the page was FROZEN, not hidden, so no
  //    visibilitychange fires, and the network never dropped so no `online`
  //    fires either. Nothing re-probed, the reachability flag stayed latched at
  //    false, and the "can't reach your library" banner survived until a full
  //    relaunch — reported from a phone doing exactly that. `pageshow` is the
  //    event that restore does fire; `focus` covers the desktop equivalent.
  useEffect(() => {
    const reprobe = () => {
      if (token) void pingHub(token);
    };
    const onVisible = () => {
      if (!document.hidden) reprobe();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', reprobe);
    window.addEventListener('focus', reprobe);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', reprobe);
      window.removeEventListener('focus', reprobe);
    };
  }, [token]);

  // Fire the reconnect pulse when we return to fully-reachable from any outage
  // the user saw; cancel a pending pulse if we drop offline again.
  const offline = !deviceOnline || !hubOnline;
  useEffect(() => {
    if (offline) {
      wasOffline.current = true;
      setReconnected(false);
      if (pulseTimer.current != null) {
        clearTimeout(pulseTimer.current);
        pulseTimer.current = null;
      }
    } else if (wasOffline.current) {
      wasOffline.current = false;
      setReconnected(true);
      pulseTimer.current = window.setTimeout(
        () => setReconnected(false),
        RECONNECT_PULSE_MS,
      );
    }
  }, [offline]);

  // Tidy the pulse timer on unmount.
  useEffect(
    () => () => {
      if (pulseTimer.current != null) clearTimeout(pulseTimer.current);
    },
    [],
  );

  if (!deviceOnline) return 'device-offline';
  // Ranked ABOVE hub-offline on purpose: a gate that answers 401 has proved the
  // far end is up, so "can't reach your library" would be actively misleading.
  if (signInAt) return 'signed-out';
  if (!hubOnline) return 'hub-offline';
  if (reconnected) return 'reconnected';
  return 'online';
}
