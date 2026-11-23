import React, { useEffect, useState } from 'react'

import { Badge, Button, Codicon, Input, cn, rest } from './sdk-shim.jsx'

const NOTIFY_KEY = 'dbdesk.notifications'

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
  const [notifyState, setNotifyState] = useState('')
  const [home, setHome] = useState('')

  useEffect(() => {
    if (!open) return
    setAiMessage('')
    setUpdateState('')
    setNotifyState('')
    try {
      setNotifyEnabled(localStorage.getItem(NOTIFY_KEY) !== 'off')
    } catch {
      setNotifyEnabled(true)
    }
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

  const testNotification = async () => {
    setNotifyState('')
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      )
      let granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
      if (!granted) {
        setNotifyState('Permission denied')
        return
      }
      sendNotification({ title: 'DB Desk', body: 'Native notifications are working.' })
      setNotifyState('Sent')
    } catch {
      setNotifyState('Not available')
    }
  }

  const toggleNotifications = (checked) => {
    setNotifyEnabled(checked)
    try {
      localStorage.setItem(NOTIFY_KEY, checked ? 'on' : 'off')
    } catch {
      /* private mode */
    }
  }

  return (
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
            </Row>
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
  )
}
