import { useEffect, useRef, useState } from 'react';
import { isHubReachable, onHubReachability, pingHub } from '@shared/api';

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
 *   - `reconnected`    — a transient success pulse shown once when the server
 *     comes back after either kind of outage (the user's explicit ask).
 *   - `online`         — everything reachable; no banner.
 */
export type ConnPhase =
  | 'online'
  | 'device-offline'
  | 'hub-offline'
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

  // 3. Re-probe when the tab returns to the foreground — interval timers are
  //    throttled/frozen while backgrounded, so the flag can be stale on return.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && token) void pingHub(token);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
  if (!hubOnline) return 'hub-offline';
  if (reconnected) return 'reconnected';
  return 'online';
}
