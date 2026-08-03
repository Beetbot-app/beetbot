/** A sleep-timer choice: 'off' clears it, 'track' stops after the current
 *  song, a number is minutes from now. Shared by the desktop SleepTimerButton
 *  and the phone TrackActionSheet so the option list can't drift. */
export type SleepOption = 'off' | 'track' | number;

export const SLEEP_OPTIONS: { label: string; value: SleepOption }[] = [
  { label: 'Off', value: 'off' },
  { label: 'End of track', value: 'track' },
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '45 minutes', value: 45 },
  { label: '1 hour', value: 60 },
];
