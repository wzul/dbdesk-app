/**
 * Silent OTA updates.
 *
 * The updater endpoint is the signed `latest.json` on GitHub Releases (see
 * tauri.conf.json → plugins.updater). This module is the policy on top of it:
 *
 * - at launch (and every few hours while running) the app checks in the
 *   background — the user never has to press anything;
 * - when an update exists it is downloaded and installed immediately, so the next
 *   time the app is opened it *is* the new version. We never call relaunch() by
 *   itself: swapping the binary under a running app is surprising, and the user may
 *   be mid-edit;
 * - `AUTO_KEY` is the opt-out. With it off the app still checks and offers a single
 *   "Install" button, but downloads nothing on its own.
 *
 * The pending marker lives in localStorage (not in the sidecar's data folder):
 * it is UI state that must survive a relaunch of the webview, and it is cleared as
 * soon as the new version reports a different APP_VERSION.
 */

const AUTO_KEY = 'dbdesk.updates.auto'
const PENDING_KEY = 'dbdesk.updates.pending'
const CHECKED_KEY = 'dbdesk.updates.checkedAt'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function readStore(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

export function isDesktopApp() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

/** Automatic installs are on unless the user turned them off. */
export function autoUpdateEnabled() {
  return readStore(AUTO_KEY) !== '0'
}

export function setAutoUpdateEnabled(enabled) {
  writeStore(AUTO_KEY, enabled ? '1' : '0')
  // Force the next check so turning it back on acts immediately.
  writeStore(CHECKED_KEY, null)
}

/** `{ version, at }` once an update has been installed and awaits a restart. */
export function pendingUpdate(currentVersion) {
  let raw = null
  try {
    raw = JSON.parse(readStore(PENDING_KEY) || 'null')
  } catch {
    return null
  }
  if (!raw || !raw.version) return null
  // A pending marker for the version we are already running means the restart
  // happened — drop it.
  if (currentVersion && raw.version === currentVersion) {
    writeStore(PENDING_KEY, null)
    return null
  }
  return raw
}

export function clearPendingUpdate() {
  writeStore(PENDING_KEY, null)
}

/** Check for a newer build. Throttled unless `force` is set. */
export async function checkForUpdate({ force = false } = {}) {
  if (!isDesktopApp()) return null
  if (!force) {
    const last = Number(readStore(CHECKED_KEY) || 0)
    if (last && Date.now() - last < CHECK_INTERVAL_MS) return null
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const found = await check()
    writeStore(CHECKED_KEY, String(Date.now()))
    return found || null
  } catch {
    // Offline, unsigned dev build, or the endpoint is unreachable: stay quiet.
    return null
  }
}

/**
 * Download and install an update. It takes effect on the next launch; call
 * `relaunchApp()` only after the user asks for it.
 */
export async function installUpdate(update, onProgress) {
  if (!update) return false
  let total = 0
  let done = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data?.contentLength || 0
    } else if (event.event === 'Progress') {
      done += event.data?.chunkLength || 0
      onProgress?.(total ? Math.round((done / total) * 100) : null)
    } else if (event.event === 'Finished') {
      onProgress?.(100)
    }
  })
  writeStore(PENDING_KEY, JSON.stringify({ version: update.version, at: Date.now() }))
  return true
}

export async function relaunchApp() {
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}
