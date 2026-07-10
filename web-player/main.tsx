import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker on supported browsers (most evergreen mobile
// browsers). We catch+swallow because dev / older Safari versions may reject
// it -- the player still works fine without offline shell caching.
//
// Auto-update flow (critical for iOS home-screen PWAs): a home-screen PWA
// resumes from a snapshot without a real navigation, so a newly-activated
// worker's HTML/JS would otherwise never render — the app stays pinned to
// the old bundle no matter how many times it's reopened. To fix that:
//   1. Force an update check on first load AND every time the app returns
//      to the foreground (iOS doesn't re-fire 'load' on resume).
//   2. When a new worker takes control (the SW calls skipWaiting +
//      clients.claim on a SHELL_CACHE bump), reload the page exactly once
//      so the fresh bundle actually runs.
if ('serviceWorker' in navigator) {
  // Only reload on *updates* — not on the very first install, where there
  // was no prior controller and the page already loaded the latest code.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });

  const checkForUpdate = (reg: ServiceWorkerRegistration) => {
    reg.update().catch(() => {});
  };

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        checkForUpdate(reg);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate(reg);
        });
      })
      .catch((err) => console.warn('[beetbot] sw registration failed', err));
  });
}
