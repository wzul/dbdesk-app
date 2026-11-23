/**
 * Native notification helper.
 *
 * Primary path: the Tauri notification plugin (UNUserNotificationCenter).
 * On an ad-hoc signed build macOS invalidates the stored notification
 * permission whenever the signature changes, so after an update the user must
 * re-enable DB Desk in System Settings → Notifications. The Settings panel
 * exposes diagnostics and a shortcut to that pane.
 *
 * Fallback: `native_notify` posts through osascript/Script Editor, which works
 * on some macOS versions without a permission entry but is attributed to
 * Script Editor. It is only used when explicitly requested or when the native
 * plugin is unavailable.
 */
export async function sendNativeNotification(title, body, { fallback = false } = {}) {
  if (window.__TAURI_INTERNALS__ && !fallback) {
    try {
      const { sendNotification } = await import('@tauri-apps/plugin-notification')
      sendNotification({ title, body })
      return 'native'
    } catch {
      /* fall through to osascript */
    }
  }
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const channel = await invoke('native_notify', { title, body })
      if (channel === 'osascript') return 'osascript'
    } catch {
      /* unavailable */
    }
  }
  return ''
}

export function isMacOS() {
  if (typeof navigator === 'undefined') return false
  return /mac/i.test(navigator.platform || navigator.userAgent || '')
}
