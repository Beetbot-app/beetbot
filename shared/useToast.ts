import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Transient status message with auto-dismiss. Re-showing (even the same
 * message) resets the timer, so a rapid burst never truncates the last one —
 * the bug that lived in three copied inline versions of this. Pass a duration
 * to override the 1.6s default. Pair with the shared `<Toast>` component.
 */
export function useToast(durationMs = 1600): {
  toast: string | null;
  showToast: (msg: string) => void;
} {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback(
    (msg: string) => {
      setToast(msg);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), durationMs);
    },
    [durationMs],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { toast, showToast };
}
