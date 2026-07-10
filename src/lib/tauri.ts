import { invoke } from '@tauri-apps/api/core';

export interface DbHealth {
  migration_version: number;
  path: string;
}

export interface ImportSummary {
  playlist_id: number;
  playlist_name: string;
  tracks_added: number;
  tracks_existing: number;
  rows_skipped: number;
  /** When set, the source playlist had this many tracks total but only the
   *  first chunk was imported (import cap). */
  truncated_total: number | null;
}

export interface BulkImportFailure {
  file: string;
  error: string;
}

export interface BulkImportSummary {
  playlists_imported: number;
  tracks_added: number;
  tracks_existing: number;
  rows_skipped: number;
  failures: BulkImportFailure[];
}

export interface PlaylistSummary {
  id: number;
  name: string;
  track_count: number;
  /** How many of this playlist's tracks have a file on disk. */
  downloaded_count: number;
  /** How many tracks are stuck in 'needs-review' (no confident match). */
  needs_review_count: number;
  last_synced_at: number | null;
  source: PlaylistSource;
  cover_url: string | null;
  /** For album imports, the album artist (shown as "Album · Artist");
   *  for upstream playlists, the playlist owner. `null` for plain locals. */
  owner: string | null;
}

export type PlaylistSource =
  | 'csv'
  | 'spotify'
  | 'liked'
  | 'local'
  | 'album'
  | 'soundcloud'
  | 'apple';

/** A Netflix-style user profile. Owns playlists; the music library is shared. */
export interface Profile {
  id: number;
  name: string;
  avatar_color: string;
  /** Absolute path to a custom photo, or null for the colour + initial tile.
   *  Render with `convertFileSrc(avatar_path)`. */
  avatar_path: string | null;
  /** True if a PIN is set (the hash itself is never sent to the client). */
  has_pin: boolean;
  created_at: number;
}

export interface PlaylistDetail {
  id: number;
  name: string;
  description: string | null;
  cover_url: string | null;
  owner: string | null;
  last_synced_at: number | null;
  source: PlaylistSource;
  track_count: number;
  total_duration_ms: number;
}

export interface TrackSearchResult {
  id: number;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
  local_path: string | null;
  status: string;
  playlist_id: number | null;
  playlist_name: string | null;
}

export interface PlaylistTrack {
  id: number;
  spotify_id: string;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
  isrc: string | null;
  status: string;
  failure_reason: string | null;
  local_path: string | null;
  position: number;
  added_at: number | null;
}

/** One distinct album in the library (Daft-style Albums view). */
export interface LibraryAlbum {
  album: string;
  artist: string | null;
  album_art_url: string | null;
  track_count: number;
}

/** Result of a library backup export or restore. */
export interface BackupSummary {
  playlists: number;
  tracks: number;
}

/** One distinct primary artist in the library (Daft-style Artists view). */
export interface LibraryArtist {
  name: string;
  /** Normalized grouping key (matches the Rust `artist_key`). */
  key: string;
  album_art_url: string | null;
  track_count: number;
}

export const ipc = {
  ping: () => invoke<string>('ping'),
  dbHealth: () => invoke<DbHealth>('db_health'),

  importCsv: (path: string, playlistName?: string) =>
    invoke<ImportSummary>('import_csv', { path, playlistName }),
  importExportifyArchive: (path: string) =>
    invoke<BulkImportSummary>('import_exportify_archive', { path }),
  /** Import a public Apple Music playlist by URL. Metadata only. */
  importAppleMusicPlaylist: (profileId: number, url: string) =>
    invoke<ImportSummary>('import_apple_music_playlist', { profileId, url }),
  /** Import a public SoundCloud playlist/set by URL. Metadata only. */
  importSoundcloudPlaylist: (profileId: number, url: string) =>
    invoke<ImportSummary>('import_soundcloud_playlist', { profileId, url }),
  openExportifyWindow: () => invoke<void>('open_exportify_window'),
  listPlaylists: (profileId: number) =>
    invoke<PlaylistSummary[]>('list_playlists', { profileId }),

  // ---- User profiles (Netflix-style) ----
  listProfiles: () => invoke<Profile[]>('list_profiles'),
  createProfile: (name: string, avatarColor: string, pin?: string | null) =>
    invoke<Profile>('create_profile', { name, avatarColor, pin: pin ?? null }),
  updateProfile: (id: number, name: string, avatarColor: string) =>
    invoke<Profile>('update_profile', { id, name, avatarColor }),
  setProfilePin: (id: number, pin?: string | null) =>
    invoke<void>('set_profile_pin', { id, pin: pin ?? null }),
  verifyProfilePin: (id: number, pin: string) =>
    invoke<boolean>('verify_profile_pin', { id, pin }),
  deleteProfile: (id: number) => invoke<void>('delete_profile', { id }),
  /** Copy a chosen image into the app and set it as the profile's photo. */
  setProfileAvatar: (id: number, sourcePath: string) =>
    invoke<Profile>('set_profile_avatar', { id, sourcePath }),
  /** Read a picked image as a data: URL so the in-app cropper can load it. */
  readImageDataUrl: (sourcePath: string) =>
    invoke<string>('read_image_data_url', { sourcePath }),
  /** Save a cropped avatar (base64 JPEG from the cropper canvas). */
  setProfileAvatarData: (id: number, dataBase64: string) =>
    invoke<Profile>('set_profile_avatar_data', { id, dataBase64 }),
  clearProfileAvatar: (id: number) =>
    invoke<Profile>('clear_profile_avatar', { id }),
  getPlaylist: (id: number) => invoke<PlaylistDetail>('get_playlist', { id }),
  /**
   * Delete a playlist by id. Returns `true` if a row was actually
   * removed, `false` if no row matched. FK cascade handles the
   * `playlist_tracks` rows; tracks themselves stay.
   */
  deletePlaylist: (id: number) => invoke<boolean>('delete_playlist', { id }),
  /** Rename a playlist (display name only). Returns `true` if a row was
   *  updated, `false` if no row matched. */
  renamePlaylist: (id: number, name: string, description?: string | null) =>
    invoke<boolean>('rename_playlist', { id, name, description: description ?? null }),
  listTracks: (playlistId: number) =>
    invoke<PlaylistTrack[]>('list_tracks', { playlistId }),
  /** Fetch one track row (with local_path) by id, no playlist needed. */
  getTrack: (trackId: number) =>
    invoke<PlaylistTrack | null>('get_track', { trackId }),
  searchTracks: (query: string, limit = 50) =>
    invoke<TrackSearchResult[]>('search_tracks', { query, limit }),

  // ---- Library views (Daft-style Artists / Albums / Songs) ----
  /** Every track in the active profile's saved library, flat. */
  listLibrarySongs: (profileId: number | null) =>
    invoke<PlaylistTrack[]>('list_library_songs', { profileId }),
  /** Distinct albums across the active profile's saved library. */
  listLibraryAlbums: (profileId: number | null) =>
    invoke<LibraryAlbum[]>('list_library_albums', { profileId }),
  /** Distinct primary artists across the active profile's saved library. */
  listLibraryArtists: (profileId: number | null) =>
    invoke<LibraryArtist[]>('list_library_artists', { profileId }),

  // ---- Library backup & restore ----
  /** Write this profile's playlists + tracks to `path` as a JSON backup. */
  exportLibrary: (profileId: number, path: string) =>
    invoke<BackupSummary>('export_library', { profileId, path }),
  /** Restore (merge) a JSON backup file into this profile. */
  importLibraryBackup: (profileId: number, path: string) =>
    invoke<BackupSummary>('import_library_backup', { profileId, path }),

  // Last.fm API key (free; powers genre-accurate Browse charts).
  lastfmGetKey: () => invoke<string | null>('lastfm_get_key'),
  lastfmSetKey: (key: string) => invoke<void>('lastfm_set_key', { key }),
  lastfmClearKey: () => invoke<void>('lastfm_clear_key'),

  /** Adopt a user-supplied audio file for a track. Copies/transcodes it into
   *  the library and marks it downloaded. Returns the stored file path.
   *  This is the primary way to give a track playable audio. */
  importLocalFile: (trackId: number, sourcePath: string) =>
    invoke<string>('import_local_file', { trackId, sourcePath }),

  streamingStatus: () => invoke<StreamingStatus>('streaming_status'),
  streamingSetEnabled: (enabled: boolean) =>
    invoke<void>('streaming_set_enabled', { enabled }),
  listStreamingSessions: () =>
    invoke<StreamingSession[]>('list_streaming_sessions'),
  revokeStreamingSession: (id: string) =>
    invoke<void>('revoke_streaming_session', { id }),

  mediaSetTrack: (
    title: string,
    artist: string,
    album: string | null,
    artUrl: string | null,
    durationS: number | null,
  ) =>
    invoke<void>('media_set_track', {
      title,
      artist,
      album,
      artUrl,
      durationS,
    }),
  mediaSetPlayback: (playing: boolean, positionS: number | null) =>
    invoke<void>('media_set_playback', { playing, positionS }),

  getDownloadDir: () => invoke<string>('get_download_dir'),
  setDownloadDir: (path: string) =>
    invoke<void>('set_download_dir', { path }),

  storageUsage: () => invoke<StorageUsage>('storage_usage'),
  clearLiveCache: () => invoke<number>('clear_live_cache'),

  // Open-on-login (tauri-plugin-autostart, wired in the app shell). These reach
  // the plugin's own commands; they reject on a build that predates the plugin.
  autostartIsEnabled: () => invoke<boolean>('plugin:autostart|is_enabled'),
  autostartEnable: () => invoke<void>('plugin:autostart|enable'),
  autostartDisable: () => invoke<void>('plugin:autostart|disable'),

  getLogDir: () => invoke<string>('get_log_dir'),

  probeNetwork: () => invoke<NetworkProbe>('probe_network'),

  ddnsGetStatus: () => invoke<DdnsStatus>('ddns_get_status'),
  ddnsSetConfig: (subdomain: string, token: string) =>
    invoke<void>('ddns_set_config', { subdomain, token }),
  ddnsClear: () => invoke<void>('ddns_clear'),
  ddnsUpdateNow: () => invoke<string>('ddns_update_now'),

  ngrokGetStatus: () => invoke<NgrokStatus>('ngrok_get_status'),
  ngrokSetConfig: (authtoken: string, domain: string) =>
    invoke<void>('ngrok_set_config', { authtoken, domain }),
  ngrokClear: () => invoke<void>('ngrok_clear'),

  /**
   * Optional external sharing provider (a pluggable service that can also make
   * this library reachable). This command exists ONLY in a build that ships a
   * provider; in the plain open-core build it is absent, so we resolve to
   * `null` and callers render nothing. All provider-specific copy (its name,
   * the URL) comes from the response at runtime.
   */
  externalSharingStatus: (): Promise<ExternalSharingStatus | null> =>
    invoke<ExternalSharingStatus>('external_sharing_status').catch(() => null),
  externalSharingEnable: () =>
    invoke<ExternalSharingStatus>('external_sharing_enable'),
  externalSharingDisable: () =>
    invoke<ExternalSharingStatus>('external_sharing_disable'),

  acmeGetStatus: () => invoke<AcmeStatus>('acme_get_status'),
  acmeIssue: (args: { contact_email: string | null; staging: boolean }) =>
    invoke<AcmeIssueOutcome>('acme_issue', { args }),
  acmeClear: () => invoke<void>('acme_clear'),

  pairingGetInfo: () => invoke<PairingInfo>('pairing_get_info'),
  pairingSetRequired: (enabled: boolean) =>
    invoke<void>('pairing_set_required', { enabled }),
  remoteStreamingSetEnabled: (enabled: boolean) =>
    invoke<void>('remote_streaming_set_enabled', { enabled }),
  upnpStatus: () => invoke<UpnpStatus>('upnp_status'),
  getSecurityLogPath: () => invoke<string>('get_security_log_path'),
};

export interface UpnpStatus {
  mapped: boolean;
  external_ip: string | null;
  error: string | null;
}

export interface PairingInfo {
  code: string;
  seconds_until_rotation: number;
  pairing_required: boolean;
  remote_streaming_enabled: boolean;
}

export interface AcmeStatus {
  has_cert: boolean;
  hostname: string | null;
  not_after: number | null;
  last_error: string | null;
}

export interface AcmeIssueOutcome {
  hostname: string;
  cert_path: string;
  key_path: string;
  not_after: number;
}

export interface DdnsStatus {
  subdomain: string | null;
  has_token: boolean;
  hostname: string | null;
  last_ip: string | null;
  last_update_at: number | null;
  last_error: string | null;
}

export interface NgrokStatus {
  has_authtoken: boolean;
  domain: string | null;
  running: boolean;
  public_url: string | null;
  last_error: string | null;
}

/** Lifecycle of an optional external sharing route. */
export type ExternalSharingState = 'off' | 'pending' | 'live';

/**
 * Status of the optional external sharing provider. Every provider-specific
 * value is supplied by the host at runtime — the open core stays brand-neutral.
 */
export interface ExternalSharingStatus {
  /** Whether the provider is present and reachable, so enabling is possible. */
  available: boolean;
  state: ExternalSharingState;
  /** The provider's display name, used verbatim in generic copy. */
  providerName: string;
  /** The public URL once `live`, else null. */
  url: string | null;
}

export type NetworkVerdict =
  | 'remote-reachable'
  | 'needs-manual-port-forward'
  | 'blocked-by-cgnat'
  | 'no-internet';

export interface StorageUsage {
  /** Bytes in the temporary streaming cache (safe to clear). */
  cache_bytes: number;
  /** Bytes of imported / downloaded audio in the library folder. */
  downloads_bytes: number;
}

export interface NetworkProbe {
  lan_ip: string | null;
  public_ip: string | null;
  cgnat_likely: boolean;
  upnp_available: boolean;
  upnp_external_ip: string | null;
  verdict: NetworkVerdict;
  notes: string[];
}

export interface StreamingStatus {
  enabled: boolean;
  port: number;
  https_port: number;
  lan_url: string | null;
  hostname_url: string | null;
  https_url: string | null;
  cert_install_url: string | null;
  requires_restart: boolean;
}

export interface StreamingSession {
  id: string;
  device_label: string;
  ip_address: string;
  user_agent: string | null;
  paired_at: number;
  last_seen_at: number;
}

