/**
 * "Add this to your home screen" — shown once, on a phone, to somebody who is
 * using Beetbot in a browser tab.
 *
 * Two platforms, two mechanisms, and only one of them is an API:
 *
 *   iOS Safari    no install API at all, ever. The only honest thing is to
 *                 describe the Share -> Add to Home Screen steps.
 *   Chromium      fires `beforeinstallprompt`; hold it and offer a real button.
 *
 * Shown once and remembered. A prompt that returns every visit is an advert.
 * The rule for whether to show it at all lives in ../lib/install.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  isIos,
  isMobile,
  isStandalone,
  rememberDismissed,
  shouldOffer,
  wasDismissed,
} from '../lib/install';

/** The Chromium install prompt. Not in lib.dom, so it is spelled out here. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallSheet({
  /** Force it open from Settings, ignoring the remembered dismissal. */
  forced = false,
  onClose,
}: {
  forced?: boolean;
  onClose?: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  // Catch the Chromium prompt whenever it fires — it may arrive before or after
  // this mounts, so the listener goes up regardless of whether we are open.
  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  useEffect(() => {
    if (forced) {
      setOpen(true);
      return;
    }
    setOpen(
      shouldOffer({
        mobile: isMobile(),
        standalone: isStandalone(),
        dismissed: wasDismissed(),
      }),
    );
  }, [forced]);

  const close = useCallback(() => {
    setOpen(false);
    rememberDismissed();
    onClose?.();
  }, [onClose]);

  const install = useCallback(async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
    close();
  }, [prompt, close]);

  if (!open) return null;

  const ios = isIos();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      onClick={close}
    >
      <div
        className="w-full max-w-sm rounded-3xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="install-title" className="text-lg font-semibold tracking-tight">
          Keep Beetbot on your home screen
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          It opens like an app, and the music keeps playing when your screen locks.
        </p>

        {ios || !prompt ? (
          <ol className="mt-4 space-y-2 text-sm text-neutral-300">
            <li>
              1. Tap <strong>Share</strong> in the browser bar.
            </li>
            <li>
              2. Choose <strong>Add to Home Screen</strong>.
            </li>
            <li>3. Open Beetbot from the icon.</li>
          </ol>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-full border border-white/15 px-4 py-2.5 text-sm font-medium text-neutral-300 active:opacity-70"
            onClick={close}
          >
            {ios || !prompt ? 'Got it' : 'Not now'}
          </button>
          {!ios && prompt ? (
            <button
              type="button"
              className="flex-1 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 active:opacity-80"
              onClick={() => void install()}
            >
              Install
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
