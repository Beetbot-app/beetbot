import { useCallback, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useProfileStore } from '@/lib/profile';
import { ipc } from '@/lib/tauri';

interface Props {
  /** Called when the user dismisses or finishes the wizard. */
  onDone: () => void;
}

type Step = 'welcome' | 'getmusic' | 'done';

/**
 * One-time onboarding overlay, shown on a truly fresh library (no playlists).
 * Local-first: import a playlist (Exportify zip, or an Apple Music / SoundCloud
 * link) right here to seed your library, or skip ahead and add your own audio
 * files. Connecting
 * Spotify is an optional, power-user step that lives in Settings — deliberately
 * kept out of onboarding.
 *
 * The "seen" flag is persisted in the settings table so a restart doesn't
 * re-show it. Skipping never blocks the rest of the UI.
 */
export function FirstRunWizard({ onDone }: Props) {
  const activeProfileId = useProfileStore((s) => s.activeProfileId) ?? 1;
  const [step, setStep] = useState<Step>('welcome');
  const [importing, setImporting] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkImporting, setLinkImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleImportZip = useCallback(async () => {
    setError(null);
    setImporting(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Exportify archive', extensions: ['zip'] }],
        title: 'Select the Exportify zip',
      });
      if (typeof selected !== 'string') return;
      const summary = await ipc.importExportifyArchive(selected);
      setNotice(
        `Imported ${summary.playlists_imported} playlist${
          summary.playlists_imported === 1 ? '' : 's'
        } · ${summary.tracks_added} songs.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }, []);

  // Accept either an Apple Music or a SoundCloud link — pick the importer by
  // host. Anything else is rejected with a friendly hint.
  const handleLinkImport = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setError(null);
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      setError('That doesn’t look like a link. Paste a full https:// URL.');
      return;
    }
    const importer = host.includes('music.apple.com')
      ? ipc.importAppleMusicPlaylist
      : host.includes('soundcloud.com')
        ? ipc.importSoundcloudPlaylist
        : null;
    if (!importer) {
      setError('Paste an Apple Music or SoundCloud playlist link.');
      return;
    }
    setLinkImporting(true);
    try {
      const summary = await importer(activeProfileId, url);
      setNotice(
        `Imported “${summary.playlist_name}” · ${summary.tracks_added} songs.`,
      );
      setLinkUrl('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLinkImporting(false);
    }
  }, [linkUrl, activeProfileId]);

  const next = useCallback(() => {
    setError(null);
    setNotice(null);
    setStep((s) => (s === 'welcome' ? 'getmusic' : 'done'));
  }, []);

  const back = useCallback(() => {
    setError(null);
    setNotice(null);
    setStep((s) => (s === 'done' ? 'getmusic' : 'welcome'));
  }, []);

  const finish = useCallback(() => {
    onDone();
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/80 backdrop-blur p-6">
      <div className="w-full max-w-lg rounded-xl bg-neutral-900 border border-neutral-800 shadow-2xl">
        <div className="px-6 py-4 border-b border-neutral-800 flex items-baseline justify-between">
          <div className="text-sm uppercase tracking-wide text-neutral-500">
            Welcome to Beetbot
          </div>
          <button
            type="button"
            onClick={finish}
            className="text-xs text-neutral-500 hover:text-neutral-200"
          >
            Skip
          </button>
        </div>

        <div className="px-6 py-6 min-h-[320px]">
          {step === 'welcome' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-bold tracking-tight">Your music, your files.</h1>
              <p className="text-sm text-neutral-300 leading-relaxed">
                Beetbot is a local music player. Add audio files you own and it
                organizes them into a clean library, plays them on your Mac, and
                streams them to your phone over Wi-Fi. No account required.
              </p>
              <ul className="text-sm text-neutral-400 space-y-2 pt-2">
                <li>1. Add your own audio files — or import a playlist to start from</li>
                <li>2. Everything lands in a tidy library, tagged with cover art</li>
                <li>3. Play on your Mac, or stream to your phone over Wi-Fi</li>
              </ul>
            </div>
          )}

          {step === 'getmusic' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Get your music in</h2>
              <p className="text-sm text-neutral-300 leading-relaxed">
                Import a playlist to seed your library, then add the audio files
                you own to each track. You can also skip this and add music
                anytime from your library.
              </p>

              <div className="space-y-4">
                <div>
                  <button
                    type="button"
                    onClick={handleImportZip}
                    disabled={importing}
                    className="rounded-lg px-3 py-2 text-sm bg-neutral-100 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400 text-neutral-950 font-medium"
                  >
                    {importing ? 'Importing…' : 'Import Exportify zip'}
                  </button>
                  <p className="text-xs text-neutral-500 mt-1.5">
                    An{' '}
                    <button
                      type="button"
                      onClick={() => void openUrl('https://exportify.net')}
                      className="text-neutral-100 hover:text-neutral-200 underline underline-offset-2"
                    >
                      Exportify
                    </button>{' '}
                    export of your Spotify playlists.
                  </p>
                </div>

                <div>
                  <label className="text-xs text-neutral-500">
                    Or paste an{' '}
                    <strong className="text-neutral-300">Apple Music</strong> or{' '}
                    <strong className="text-neutral-300">SoundCloud</strong>{' '}
                    playlist link — no account needed:
                  </label>
                  <div className="flex gap-2 mt-1.5">
                    <input
                      type="text"
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !linkImporting)
                          void handleLinkImport();
                      }}
                      placeholder="Paste playlist link here"
                      className="flex-1 rounded-lg bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void handleLinkImport()}
                      disabled={!linkUrl.trim() || linkImporting}
                      className="rounded-lg px-3 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 disabled:bg-neutral-900 disabled:text-neutral-500 font-medium"
                    >
                      {linkImporting ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">You&apos;re set.</h2>
              <p className="text-sm text-neutral-300">
                Open a playlist and use <strong>Add audio file</strong> on a
                track to make it playable. To listen on your phone, turn on
                streaming in Settings.
              </p>
              <p className="text-sm text-neutral-500">
                Everything else — library folder, devices, optional accounts
                like Spotify and Last.fm — lives in Settings.
              </p>
            </div>
          )}

          {(error || notice) && (
            <div
              className={`mt-4 rounded-lg p-2.5 text-xs ${
                error
                  ? 'border border-red-900 bg-red-950/40 text-red-200'
                  : 'border border-neutral-700 bg-neutral-900/50 text-neutral-100'
              }`}
            >
              {error ?? notice}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-neutral-800 flex justify-between items-center">
          <div className="flex gap-1.5">
            {(['welcome', 'getmusic', 'done'] as Step[]).map((s) => (
              <span
                key={s}
                className={`h-1.5 w-6 rounded-full ${
                  s === step ? 'bg-white' : 'bg-neutral-700'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step !== 'welcome' && (
              <button
                type="button"
                onClick={back}
                className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
              >
                Back
              </button>
            )}
            {step === 'done' ? (
              <button
                type="button"
                onClick={finish}
                className="rounded-lg px-4 py-2 text-sm bg-neutral-100 hover:bg-white text-neutral-950 font-medium"
              >
                Get started
              </button>
            ) : (
              <button
                type="button"
                onClick={next}
                className="rounded-lg px-4 py-2 text-sm bg-neutral-800 hover:bg-neutral-700"
              >
                {step === 'welcome' ? 'Begin' : 'Next'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
