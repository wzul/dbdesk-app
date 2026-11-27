/**
 * Platform helpers for shortcut labels.
 *
 * `navigator.platform` is deprecated and returns a non-empty string on every browser,
 * so it can never fall back to the user agent — the order matters: userAgentData first,
 * then platform, then the UA string. `ui/src/plugin.js` keeps its own copy of these
 * three functions because that file is also copied verbatim into the Hermes plugin,
 * where a local import would not resolve.
 */

export function isMac() {
  if (typeof navigator === 'undefined') return false
  const data = navigator.userAgentData
  if (data && typeof data.platform === 'string' && data.platform) {
    return /mac/i.test(data.platform)
  }
  if (navigator.platform) return /mac/i.test(navigator.platform)
  return /mac/i.test(navigator.userAgent || '')
}

/** True when the app is running in a browser tab rather than the Tauri shell. */
export function inBrowserTab() {
  return typeof window !== 'undefined' && !window.__TAURI_INTERNALS__
}

/** "⌘F" on macOS, "Ctrl+F" elsewhere. */
export function chord(keys) {
  return (isMac() ? '\u2318' : 'Ctrl+') + keys
}

/**
 * The new-SQL-tab chord. Ctrl+T and ⌘T belong to the browser and a page cannot cancel
 * them, so the hosted build binds Alt/⌥+T instead.
 */
export function newTabKey() {
  if (inBrowserTab()) return isMac() ? '\u2325T' : 'Alt+T'
  return chord('T')
}
