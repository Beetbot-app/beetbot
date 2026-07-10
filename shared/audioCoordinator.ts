/**
 * App-wide "one audio source at a time" coordinator.
 *
 * The 30-second preview clips (usePreviewPlayer) and the full-track music
 * player (each bundle's player store) own separate <audio> elements in
 * separate React trees, so neither can see the other. Each registers a pause
 * callback and announces when it starts playing; starting one pauses the
 * others — so a preview and the music player never play over each other.
 */
type AudioSource = 'preview' | 'main';

const pausers = new Map<AudioSource, () => void>();

/** Register how to pause `source`. Returns an unregister fn. */
export function registerAudioPauser(
  source: AudioSource,
  pause: () => void,
): () => void {
  pausers.set(source, pause);
  return () => {
    if (pausers.get(source) === pause) pausers.delete(source);
  };
}

/** Announce that `source` just started; pause every other registered source. */
export function audioStarted(source: AudioSource): void {
  for (const [s, pause] of pausers) {
    if (s !== source) {
      try {
        pause();
      } catch {
        /* one pauser throwing shouldn't stop the others */
      }
    }
  }
}
