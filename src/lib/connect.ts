import { create } from 'zustand';
import type { CastDevice, RemoteDevice } from '@shared/api';

/**
 * Bridge store for the Connect panel (RightBar 'connect' tab).
 *
 * All cast/handoff state and the handlers that act on it live inside
 * PlayerBar — it owns the polling, the session token, the warm-then-cast
 * flow and the handoff payload. The docked RightBar renders elsewhere in the
 * tree, so PlayerBar PUBLISHES a snapshot here each time it changes and the
 * panel just reads it (same pattern as likes/pins: one owner, many readers).
 */
export interface ConnectState {
  castDevices: CastDevice[];
  castActive: { id: string; name: string } | null;
  handoffDevices: RemoteDevice[];
  /** A remote Beetbot device playing its OWN session (awareness badge only —
   *  sessions are independent; it is never "this session's output"). */
  remotePlayingId: string | null;
  error: string | null;
  preparing: boolean;
  onPickCast: ((d: CastDevice) => void) | null;
  onStopCast: (() => void) | null;
  onPickHandoff: ((d: RemoteDevice) => void) | null;
}

export const useConnectStore = create<ConnectState>(() => ({
  castDevices: [],
  castActive: null,
  handoffDevices: [],
  remotePlayingId: null,
  error: null,
  preparing: false,
  onPickCast: null,
  onStopCast: null,
  onPickHandoff: null,
}));
