/**
 * Open an external URL in the user's default browser.
 *
 * Primary path: the Tauri opener plugin, which hands the URL to the OS and works
 * in the packaged app. Fallback: `window.open`, for the plain-browser mode the
 * sidecar serves during development.
 *
 * Only `https:` is accepted. The plugin's default permission already limits the
 * scheme to http/https/mailto/tel, but refusing anything else here means a bug in
 * a component can never turn a label into an arbitrary protocol handler launch.
 *
 * Returns true when a handler accepted the URL.
 */
export async function openExternal(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false

  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return true
    } catch {
      /* plugin unavailable — fall through to the browser path */
    }
  }

  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    if (opened) {
      opened.opener = null
      return true
    }
  } catch {
    /* popup blocked */
  }
  return false
}

export const HOMEPAGE_URL = 'https://dbdesk.app'
export const REPO_URL = 'https://github.com/wzul/dbdesk-app'
