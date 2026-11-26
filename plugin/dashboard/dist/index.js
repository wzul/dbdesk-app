/* DB Desk has no web-dashboard tab; this stub keeps the manifest's `entry`
 * resolvable for dashboard surfaces that inspect it. The real UI is the
 * desktop half at desktop/plugin.js. */
;(function () {
  var SDK = window.__HERMES_PLUGIN_SDK__
  if (!SDK || typeof SDK.register !== 'function') return
  SDK.register({
    id: 'dbdesk-note',
    title: 'DB Desk',
    render: function () {
      return null
    }
  })
})()
