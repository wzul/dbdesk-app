import React, { useEffect, useState } from 'react'

import { Badge, Button, Codicon, Input, cn, rest } from './sdk-shim.jsx'
import { isMacOS, sendNativeNotification } from './notify.js'

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2 border-b border-(--ui-stroke-secondary) px-4 py-3 last:border-b-0">
      <h3 className="text-[10.5px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({ label, hint, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0">
        <div className="text-[12px] font-medium">{label}</div>
        {hint ? (
          <div className="text-[10.5px] leading-4 text-(--ui-text-tertiary)">{hint}</div>
        ) : null}
      </div>
      <span className="flex-1" />
      {children}
    </div>
  )
}

export default function SettingsDialog({ open, onClose, version }) {
  const [config, setConfig] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [update, setUpdate] = useState(null)
  const [updateState, setUpdateState] = useState('')
  const [checking, setChecking] = useState(false)
  const [notifyEnabled, setNotifyEnabled] = useState(true)
  const [appearance, setAppearance] = useState('system')
  const [backupOpen, setBackupOpen] = useState(false)
  const [backupSecrets, setBackupSecrets] = useState(false)
  const [backupPass, setBackupPass] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMessage, setBackupMessage] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restoreBundle, setRestoreBundle] = useState('')
  const [restoreName, setRestoreName] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [restorePreview, setRestorePreview] = useState(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreMessage, setRestoreMessage] = useState('')
  const [notifyState, setNotifyState] = useState('')
  const [home, setHome] = useState('')
  const [mcp, setMcp] = useState(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpMessage, setMcpMessage] = useState('')
  const [mcpReveal, setMcpReveal] = useState(false)
  const [notifyDiag, setNotifyDiag] = useState(null)
  const [diagBusy, setDiagBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setAiMessage('')
    setUpdateState('')
    setNotifyState('')
    setMcpMessage('')
    setMcpReveal(false)
    setNotifyDiag(null)
    rest('/prefs')
      .then((value) => {
        setNotifyEnabled(Boolean(value.notifications))
        setAppearance(value.appearance || 'system')
      })
      .catch(() => setNotifyEnabled(true))
    rest('/ai/config')
      .then((value) => {
        setConfig(value)
        setBaseUrl(value.base_url || '')
        setModel(value.model || '')
      })
      .catch(() => {})
    fetch('/health')
      .then((response) => response.json())
      .then((value) => setHome(value.home || ''))
      .catch(() => {})
    rest('/mcp/status')
      .then(setMcp)
      .catch(() => setMcp(null))
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const saveAi = async () => {
    setSaving(true)
    setAiMessage('')
    try {
      const value = await rest('/ai/config', {
        method: 'POST',
        body: { base_url: baseUrl, model, api_key: apiKey }
      })
      setConfig(value)
      setApiKey('')
      setAiMessage('Saved')
    } catch (error) {
      setAiMessage(String(error.message || error))
    } finally {
      setSaving(false)
    }
  }


  const copyText = async (value, label) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      try {
        const area = document.createElement('textarea')
        area.value = value
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      } catch {
        setMcpMessage('Clipboard unavailable')
        return
      }
    }
    setMcpMessage(`${label} copied`)
  }

  const updateMcp = async (body) => {
    setMcpBusy(true)
    setMcpMessage('')
    try {
      const value = await rest('/mcp/status', { method: 'POST', body })
      setMcp(value)
      setMcpReveal(false)
      setMcpMessage(value.enabled ? 'MCP server running' : 'MCP server stopped')
    } catch (error) {
      setMcpMessage(String(error.message || error))
    } finally {
      setMcpBusy(false)
    }
  }

  const rotateMcp = async () => {
    setMcpBusy(true)
    setMcpMessage('')
    try {
      const value = await rest('/mcp/token/rotate', { method: 'POST' })
      setMcp(value)
      setMcpReveal(true)
      setMcpMessage('New token generated — reconnect the agent')
    } catch (error) {
      setMcpMessage(String(error.message || error))
    } finally {
      setMcpBusy(false)
    }
  }

  const checkUpdates = async () => {
    setChecking(true)
    setUpdateState('')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const found = await check()
      setUpdate(found || null)
      setUpdateState(found ? `v${found.version} available` : 'Up to date')
    } catch (error) {
      setUpdateState(`Check failed: ${error.message || error}`)
    } finally {
      setChecking(false)
    }
  }

  const installUpdate = async () => {
    if (!update) return
    setUpdateState('Downloading…')
    try {
      let total = 0
      let done = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0
        } else if (event.event === 'Progress') {
          done += event.data.chunkLength
          setUpdateState(total ? `${Math.round((done / total) * 100)}%` : 'Downloading…')
        } else if (event.event === 'Finished') {
          setUpdateState('Installing…')
        }
      })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (error) {
      setUpdateState(`Update failed: ${error.message || error}`)
    }
  }


  const runNotifyDiagnostics = async () => {
    if (!window.__TAURI_INTERNALS__) {
      setNotifyDiag({ error: 'Diagnostics are available in the desktop app.' })
      return
    }
    setDiagBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      setNotifyDiag(await invoke('notification_diagnostics'))
    } catch (error) {
      setNotifyDiag({ error: String(error) })
    } finally {
      setDiagBusy(false)
    }
  }

  const openNotificationSettings = async () => {
    if (!window.__TAURI_INTERNALS__) {
      setNotifyState('Only available in the desktop app')
      return
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_notification_settings')
    } catch (error) {
      setNotifyState(String(error.message || error))
    }
  }

  const testNotification = async (fallback = false) => {
    setNotifyState('')
    if (!isMacOS() && !fallback) {
      try {
        const { isPermissionGranted, requestPermission } = await import(
          '@tauri-apps/plugin-notification'
        )
        let granted = await isPermissionGranted()
        if (!granted) granted = (await requestPermission()) === 'granted'
        if (!granted) {
          setNotifyState('Permission denied')
          return
        }
      } catch {
        setNotifyState('Not available')
        return
      }
    }
    const channel = await sendNativeNotification(
      fallback ? 'DB Desk (Script Editor fallback)' : 'DB Desk',
      fallback
        ? 'Fallback delivery works. This banner is posted by Script Editor.'
        : 'Native notifications are working.',
      { fallback }
    )
    if (channel === 'osascript') setNotifyState('Sent as Script Editor')
    else if (channel === 'native') setNotifyState('Sent to Notification Center')
    else setNotifyState('Not available')
  }


  const exportBackup = async () => {
    if (backupSecrets && backupPass.length < 8) {
      setBackupMessage('Passphrase must be at least 8 characters.')
      return
    }
    setBackupBusy(true)
    setBackupMessage('')
    try {
      const result = await rest('/backup/export', {
        method: 'POST',
        body: { include_secrets: backupSecrets, passphrase: backupPass }
      })
      const blob = new Blob([result.bundle], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `dbdesk-backup-${new Date().toISOString().slice(0, 10)}.dbdesk`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setBackupMessage(
        `${result.connections_count} connections, ${result.views_count} views, ${result.queries_count} queries.`
      )
    } catch (error) {
      setBackupMessage(String(error.message || error))
    } finally {
      setBackupBusy(false)
    }
  }

  const pickRestoreFile = async (event) => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    setRestoreName(file.name)
    setRestoreBundle(await file.text())
    setRestorePreview(null)
    setRestoreMessage('')
  }

  const previewRestore = async () => {
    setRestoreBusy(true)
    setRestoreMessage('')
    try {
      const result = await rest('/backup/import', {
        method: 'POST',
        body: { bundle: restoreBundle, passphrase: restorePass, preview: true }
      })
      setRestorePreview(result)
    } catch (error) {
      setRestorePreview(null)
      setRestoreMessage(String(error.message || error))
    } finally {
      setRestoreBusy(false)
    }
  }

  const runRestore = async () => {
    setRestoreBusy(true)
    setRestoreMessage('')
    try {
      const result = await rest('/backup/import', {
        method: 'POST',
        body: { bundle: restoreBundle, passphrase: restorePass }
      })
      setRestoreMessage(
        `Restored ${result.connections} connections, ${result.views} views, ${result.queries} queries.`
      )
      setRestorePreview(null)
      window.dispatchEvent(new CustomEvent('dbdesk:reload'))
    } catch (error) {
      setRestoreMessage(String(error.message || error))
    } finally {
      setRestoreBusy(false)
    }
  }

  const changeAppearance = (value) => {
    setAppearance(value)
    rest('/prefs', { method: 'POST', body: { appearance: value } }).catch(() => {})
    window.dispatchEvent(new CustomEvent('dbdesk:appearance', { detail: value }))
  }

  const toggleNotifications = (checked) => {
    setNotifyEnabled(checked)
    rest('/prefs', { method: 'POST', body: { notifications: checked } }).catch(() => {})
  }

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-4 py-2.5">
          <Codicon name="settings-gear" className="text-(--ui-text-secondary)" />
          <span className="text-[13px] font-semibold">Settings</span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" title="Close" onClick={onClose}>
            <Codicon name="close" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Section title="General">
            <Row label="Version" hint="DB Desk for macOS">
              <Badge variant="muted" size="xs">
                {version}
              </Badge>
            </Row>
            <Row
              label="Updates"
              hint={
                updateState ||
                'Downloads a signed build, verifies it and relaunches.'
              }
            >
              {update ? (
                <Button size="sm" onClick={() => void installUpdate()}>
                  Update to v{update.version}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={checking}
                  onClick={() => void checkUpdates()}
                >
                  {checking ? 'Checking…' : 'Check for updates'}
                </Button>
              )}
            </Row>
          </Section>

          <Section title="Appearance">
            <Row label="Theme" hint="System follows the macOS Light/Dark setting.">
              <div className="flex overflow-hidden rounded-[4px] border border-(--ui-stroke-secondary)">
                {[
                  ['system', 'System'],
                  ['light', 'Light'],
                  ['dark', 'Dark']
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => changeAppearance(value)}
                    className={cn(
                      'h-7 px-3 text-[11px] font-medium',
                      appearance === value
                        ? 'bg-primary text-white'
                        : 'bg-background text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="Notifications">
            <Row
              label="Native notifications"
              hint={notifyState || 'Approval requests and production writes.'}
            >
              <label className="flex items-center gap-2 text-[11.5px]">
                <input
                  type="checkbox"
                  checked={notifyEnabled}
                  onChange={(event) => toggleNotifications(event.target.checked)}
                />
                Enabled
              </label>
              <Button variant="secondary" size="sm" onClick={() => void testNotification()}>
                Test
              </Button>
              {isMacOS() ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Post through Script Editor (works without a permission entry)"
                  onClick={() => void testNotification(true)}
                >
                  Fallback
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={diagBusy}
                onClick={() => void runNotifyDiagnostics()}
              >
                {diagBusy ? 'Checking…' : 'Diagnostics'}
              </Button>
            </Row>
            {notifyDiag ? (
              <div className="flex flex-col gap-1 rounded-[5px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1.5 font-mono text-[10px] leading-4 text-(--ui-text-secondary)">
                {notifyDiag.error ? (
                  <span>{notifyDiag.error}</span>
                ) : (
                  <>
                    <span className="truncate" title={notifyDiag.path}>
                      bundle {notifyDiag.path || 'unknown'}
                    </span>
                    <span>
                      {notifyDiag.in_applications ? 'in /Applications' : 'not in /Applications'} ·{' '}
                      {notifyDiag.translocated ? 'translocated' : 'normal path'} ·{' '}
                      {notifyDiag.signature || 'unknown'} ·{' '}
                      {notifyDiag.signature_ok ? 'signature valid' : 'signature invalid'}
                    </span>
                    <span>
                      notification registration:{' '}
                      {notifyDiag.registered === 'found'
                        ? 'found'
                        : notifyDiag.registered === 'missing'
                          ? 'not found'
                          : 'unknown'}
                    </span>
                    {!notifyDiag.signature_ok && notifyDiag.signature_error ? (
                      <span className="whitespace-pre-wrap text-destructive">
                        {notifyDiag.signature_error}
                      </span>
                    ) : null}
                    {notifyDiag.translocated ? (
                      <span className="text-amber-600 dark:text-amber-300">
                        macOS is running a translocated copy. Move DB Desk to /Applications and
                        reopen it.
                      </span>
                    ) : null}
                  </>
                )}
                <Button
                  variant="secondary"
                  size="xs"
                  className="mt-1 self-start"
                  onClick={() => void openNotificationSettings()}
                >
                  Open Notification Settings
                </Button>
              </div>
            ) : null}
            <div className="text-[10.5px] leading-4 text-(--ui-text-tertiary)">
              Ad-hoc builds (no Apple Developer ID) lose their notification permission
              on every update. If Test shows “Sent” but nothing appears, open
              System Settings → Notifications → DB Desk, enable it and choose
              <span className="font-medium"> Alerts</span>. The Fallback button posts
              through Script Editor instead.
            </div>
          </Section>

          <Section title="MCP server">
            <Row
              label="Local agent access"
              hint={
                mcp && mcp.enabled
                  ? `Loopback only · ${mcp.tools} tools · bearer token`
                  : 'Let Claude Desktop, Cursor or Hermes drive DB Desk over MCP.'
              }
            >
              <label className="flex items-center gap-2 text-[11.5px]">
                <input
                  type="checkbox"
                  checked={Boolean(mcp && mcp.enabled)}
                  disabled={mcpBusy || !mcp}
                  onChange={(event) => void updateMcp({ enabled: event.target.checked })}
                />
                Enabled
              </label>
              {mcp && mcp.enabled ? (
                <Badge variant="outline" size="xs">
                  running
                </Badge>
              ) : null}
            </Row>

            {mcp && mcp.enabled ? (
              <>
                <Row label="Endpoint" hint="Streamable HTTP, JSON-RPC 2.0">
                  <code className="max-w-[260px] truncate rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-1.5 py-0.5 font-mono text-[10.5px]">
                    {mcp.endpoint}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyText(mcp.endpoint, 'Endpoint')}
                  >
                    Copy
                  </Button>
                </Row>

                <Row label="Token" hint="Stored 0600 · sent as Authorization: Bearer">
                  <code className="max-w-[180px] truncate rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-1.5 py-0.5 font-mono text-[10.5px]">
                    {mcpReveal ? mcp.token : mcp.token_hint || '…'}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMcpReveal((value) => !value)}
                  >
                    {mcpReveal ? 'Hide' : 'Show'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyText(mcp.token, 'Token')}
                  >
                    Copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mcpBusy}
                    onClick={() => void rotateMcp()}
                  >
                    Rotate
                  </Button>
                </Row>

                <Row
                  label="Allow writes"
                  hint="Writable connections may run INSERT/UPDATE/DELETE; PROD writes notify."
                >
                  <label className="flex items-center gap-2 text-[11.5px]">
                    <input
                      type="checkbox"
                      checked={Boolean(mcp.allow_writes)}
                      disabled={mcpBusy}
                      onChange={(event) =>
                        void updateMcp({ allow_writes: event.target.checked })
                      }
                    />
                    Enabled
                  </label>
                </Row>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void copyText(JSON.stringify(mcp.stdio, null, 2), 'stdio config')
                    }
                  >
                    Copy stdio config
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void copyText(JSON.stringify(mcp.http, null, 2), 'HTTP config')
                    }
                  >
                    Copy HTTP config
                  </Button>
                  <span className="text-[10.5px] text-(--ui-text-tertiary)">
                    Paste into the agent&apos;s MCP servers list.
                  </span>
                </div>
              </>
            ) : null}

            {mcpMessage ? (
              <span className="text-[10.5px] text-(--ui-text-secondary)">{mcpMessage}</span>
            ) : null}
          </Section>

          <Section title="AI provider">
            <div className="grid grid-cols-1 gap-2">
              <Input
                value={baseUrl}
                placeholder="Base URL (https://api.openai.com/v1)"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <Input
                value={model}
                placeholder="Model (gpt-4o-mini)"
                onChange={(event) => setModel(event.target.value)}
              />
              <Input
                type="password"
                value={apiKey}
                placeholder={config && config.configured ? 'API key saved' : 'API key'}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={saving} onClick={() => void saveAi()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {config && config.configured ? (
                <Badge variant="outline" size="xs">
                  configured
                </Badge>
              ) : null}
              <span className="text-[10.5px] text-(--ui-text-tertiary)">
                Passwords never enter a prompt. Point at Ollama for local-only.
              </span>
              {aiMessage ? (
                <span className="text-[10.5px] text-(--ui-text-secondary)">{aiMessage}</span>
              ) : null}
            </div>
          </Section>

          <Section title="Backup & restore">
            <Row
              label="Backup all"
              hint="Connections, saved views and queries. Passwords are optional and encrypted."
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBackupMessage('')
                  setBackupOpen(true)
                }}
              >
                Backup…
              </Button>
            </Row>
            <Row
              label="Restore"
              hint="Merge a backup from another Mac. Passwords are asked again unless included."
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setRestoreMessage('')
                  setRestorePreview(null)
                  setRestoreOpen(true)
                }}
              >
                Restore…
              </Button>
            </Row>
          </Section>

          <Section title="Data">
            <Row label="Application data" hint="Encrypted connections, audit, tokens.">
              <code className="max-w-[320px] truncate rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-1.5 py-0.5 font-mono text-[10.5px]">
                {home || '…'}
              </code>
            </Row>
          </Section>

          <Section title="About">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-(--ui-text-tertiary)">
              <span>DB Desk {version}</span>
              <span>·</span>
              <span>MIT</span>
              <span>·</span>
              <span className="font-mono">github.com/wzul/dbdesk-app</span>
            </div>
          </Section>
        </div>
      </div>
    </div>

      {backupOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-[8px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl">
            <div className="flex items-center gap-2">
              <Codicon name="cloud-upload" className="text-primary" />
              <span className="text-[13px] font-semibold">Backup all</span>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" title="Close" onClick={() => setBackupOpen(false)}>
                <Codicon name="close" />
              </Button>
            </div>
            <label className="flex items-center gap-2 text-[11.5px]">
              <input
                type="checkbox"
                checked={backupSecrets}
                onChange={(event) => setBackupSecrets(event.target.checked)}
              />
              Include database passwords (encrypted)
            </label>
            {backupSecrets ? (
              <Input
                type="password"
                value={backupPass}
                placeholder="Passphrase (min 8 characters)"
                onChange={(event) => setBackupPass(event.target.value)}
              />
            ) : (
              <div className="text-[10.5px] leading-4 text-(--ui-text-tertiary)">
                Without passwords, restore opens each connection without a password and
                asks you to fill it in.
              </div>
            )}
            {backupMessage ? (
              <div className="text-[10.5px] text-(--ui-text-secondary)">{backupMessage}</div>
            ) : null}
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={backupBusy} onClick={() => void exportBackup()}>
                {backupBusy ? 'Preparing…' : 'Download backup'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setBackupOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {restoreOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-[500px] flex-col gap-3 overflow-auto rounded-[8px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl">
            <div className="flex items-center gap-2">
              <Codicon name="cloud-download" className="text-primary" />
              <span className="text-[13px] font-semibold">Restore backup</span>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" title="Close" onClick={() => setRestoreOpen(false)}>
                <Codicon name="close" />
              </Button>
            </div>
            <input
              type="file"
              accept=".dbdesk,.json,application/json"
              onChange={(event) => void pickRestoreFile(event)}
              className="text-[11px]"
            />
            {restoreName ? (
              <div className="truncate font-mono text-[10.5px] text-(--ui-text-tertiary)">
                {restoreName}
              </div>
            ) : null}
            <Input
              type="password"
              value={restorePass}
              placeholder="Passphrase (if the backup is encrypted)"
              onChange={(event) => setRestorePass(event.target.value)}
            />
            {restorePreview ? (
              <div className="flex flex-col gap-1 rounded-[5px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2.5 py-2 text-[10.5px] text-(--ui-text-secondary)">
                <span>
                  {restorePreview.count} connections · {restorePreview.views} views ·{' '}
                  {restorePreview.queries} queries
                </span>
                {restorePreview.connections.slice(0, 8).map((item) => (
                  <span key={`${item.name}-${item.database}`} className="truncate font-mono">
                    {item.kind} · {item.name} · {item.database}
                    {item.has_password ? ' · password included' : ''}
                  </span>
                ))}
              </div>
            ) : null}
            {restoreMessage ? (
              <div className="text-[10.5px] text-(--ui-text-secondary)">{restoreMessage}</div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={restoreBusy || !restoreBundle}
                onClick={() => void previewRestore()}
              >
                {restoreBusy ? 'Reading…' : 'Preview'}
              </Button>
              <Button
                size="sm"
                disabled={restoreBusy || !restoreBundle}
                onClick={() => void runRestore()}
              >
                Restore
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRestoreOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
