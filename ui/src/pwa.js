/**
 * Register the service worker that makes the hosted build installable.
 *
 * Only in a browser: inside the Tauri shell the UI is a local file served by the
 * sidecar, a service worker there would cache a stale bundle and fight the
 * updater, so it is skipped whenever the Tauri bridge is present.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (window.__TAURI_INTERNALS__) return;
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return;
  }
  const start = () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      // A failed registration must never break the app; it only costs the offline shell.
      // eslint-disable-next-line no-console
      console.warn('service worker registration failed:', error);
    });
  };
  // The entry script can run after `load` has already fired (the splash screen keeps
  // the document busy), in which case waiting for the event means never registering.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
