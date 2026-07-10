export interface AudioController {
  load: (src: string) => void;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
}

export function createAudioController(el: HTMLAudioElement): AudioController {
  return {
    load: (src) => {
      el.src = src;
    },
    play: () => el.play(),
    pause: () => el.pause(),
    seek: (seconds) => {
      el.currentTime = seconds;
    },
    setVolume: (v) => {
      el.volume = Math.max(0, Math.min(1, v));
    },
  };
}
