import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { formatDuration } from '@/lib/format';
import { ipc, type PlaylistTrack } from '@/lib/tauri';
import { cn, CALLOUT_ERROR, SCRIM, SHEET } from '@shared/ui';

const AUDIO_EXTS = [
  'm4a',
  'aac',
  'mp3',
  'flac',
  'wav',
  'ogg',
  'opus',
  'aiff',
  'm4b',
];

interface Props {
  track: PlaylistTrack;
  onClose: () => void;
  /// Fires after the user imports a file — the parent should re-fetch tracks
  /// so the row flips to its playable (downloaded) state.
  onResolved?: () => void;
}

/**
 * "Add audio file" modal — the only way to give a track playable audio.
 * The user picks (or drag-drops) an audio file they own; it's copied into the
 * library and the track becomes playable.
 */
export function CandidatesModal({ track, onClose, onResolved }: Props) {
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importPath(path: string) {
    setError(null);
    setImporting(true);
    try {
      await ipc.importLocalFile(track.id, path);
      onResolved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  async function chooseFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: AUDIO_EXTS }],
      });
      if (typeof selected !== 'string') return; // cancelled
      await importPath(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  // Tauri intercepts OS file drops at the window level (HTML5 drop can't read
  // real paths), so we listen to its drag-drop event while this modal is open.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'over') {
          setDragOver(true);
        } else if (p.type === 'drop') {
          setDragOver(false);
          const path = p.paths.find((f) =>
            AUDIO_EXTS.some((ext) => f.toLowerCase().endsWith(`.${ext}`)),
          );
          if (!path) {
            setError('That isn’t a supported audio file (m4a, mp3, flac, …).');
            return;
          }
          void importPath(path);
        } else {
          setDragOver(false);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={cn(SCRIM, 'z-50 grid place-items-center p-6')}
      onClick={onClose}
    >
      <div
        className={cn(SHEET, 'w-full max-w-lg')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 p-5 border-b border-neutral-900">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
              Add audio file
            </div>
            <h2 className="text-lg font-semibold truncate" title={track.title}>
              {track.title}
            </h2>
            <p
              className="text-sm text-neutral-400 truncate"
              title={track.artists.join(', ')}
            >
              {track.artists.join(', ') || '—'} ·{' '}
              {formatDuration(track.duration_ms)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg w-8 h-8 grid place-items-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="p-6 space-y-4">
          <p className="text-sm text-neutral-400">
            Pick an audio file you own for this track. It’s copied into your
            library and the song becomes playable.
          </p>
          <button
            type="button"
            onClick={() => void chooseFile()}
            disabled={importing}
            className={`w-full rounded-lg border-2 border-dashed px-4 py-12 text-base font-medium transition disabled:opacity-60 ${
              dragOver
                ? 'border-white/30 bg-neutral-900/60 text-neutral-200'
                : 'border-neutral-700 bg-neutral-900/40 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
            }`}
          >
            {importing
              ? 'Importing…'
              : dragOver
                ? 'Drop to import'
                : 'Drop a file here — or click to choose'}
          </button>
          {error && (
            <div className={CALLOUT_ERROR}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
