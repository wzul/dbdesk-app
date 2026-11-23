import React, { useEffect, useRef, useState } from 'react'

import { Badge, Button, Codicon, cn, rest } from './sdk-shim.jsx'

const FIELD_LABELS = {
  kind: 'Type',
  name: 'Name',
  group: 'Group',
  host: 'Host',
  port: 'Port',
  dbname: 'Database',
  user: 'User',
  sslmode: 'SSL mode',
  ssh_host: 'SSH host',
  ssh_user: 'SSH user',
  ssh_port: 'SSH port',
  tunnel_command: 'Tunnel command',
  http_url: 'Gateway URL',
  http_method: 'HTTP method',
  http_dialect: 'HTTP dialect',
  mcp_url: 'MCP URL',
  mcp_tool: 'MCP tool'
}

export default function SetupDialog({ onClose, onUse }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState([])
  const [config, setConfig] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef(null)

  useEffect(() => {
    rest('/ai/config')
      .then((value) => {
        setConfig(value)
        setBaseUrl(value.base_url || '')
        setModel(value.model || '')
        if (!value.configured) setSettingsOpen(true)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const ask = async () => {
    const question = prompt.trim()
    if (!question || busy) return
    if (config && !config.configured) {
      setSettingsOpen(true)
      return
    }
    const history = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-10)
      .map((message) => ({
        role: message.role,
        content:
          message.role === 'user'
            ? message.text
            : JSON.stringify({ answer: message.answer, draft: message.draft })
      }))
    setMessages((current) => [...current, { role: 'user', text: question }])
    setPrompt('')
    setBusy(true)
    setError('')
    try {
      const value = await rest('/ai/setup', {
        method: 'POST',
        body: { question, history }
      })
      setMessages((current) => [...current, { role: 'assistant', ...value }])
    } catch (reason) {
      setError(String(reason.message || reason))
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    try {
      const value = await rest('/ai/config', {
        method: 'POST',
        body: { base_url: baseUrl, model, api_key: apiKey }
      })
      setConfig(value)
      setApiKey('')
      setSettingsOpen(false)
    } catch (reason) {
      setError(String(reason.message || reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[min(640px,90vh)] w-full max-w-[520px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
          <Codicon name="sparkle" className="text-primary" />
          <span className="text-[13px] font-semibold">AI setup</span>
          <span className="truncate text-[10.5px] text-(--ui-text-tertiary)">
            {config && config.model ? config.model : ''}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            title="AI settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Codicon name="settings-gear" />
          </Button>
          <Button variant="ghost" size="sm" title="Close" onClick={onClose}>
            <Codicon name="close" />
          </Button>
        </div>

        {settingsOpen ? (
          <div className="flex shrink-0 flex-col gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
            <input
              value={baseUrl}
              placeholder="Base URL (https://api.openai.com/v1)"
              onChange={(event) => setBaseUrl(event.target.value)}
              className="h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60"
            />
            <input
              value={model}
              placeholder="Model (gpt-4o-mini)"
              onChange={(event) => setModel(event.target.value)}
              className="h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60"
            />
            <input
              type="password"
              value={apiKey}
              placeholder={config && config.configured ? 'API key saved' : 'API key'}
              onChange={(event) => setApiKey(event.target.value)}
              className="h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => void saveSettings()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <span className="text-[10px] text-(--ui-text-tertiary)">
                Passwords are never sent to the provider.
              </span>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mx-3 mt-3 rounded-[5px] bg-destructive/10 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">
            {error}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
          {messages.length === 0 && !busy ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <Codicon name="plug" className="text-2xl text-(--ui-text-tertiary) opacity-60" />
              <div className="text-[12px] font-medium text-(--ui-text-secondary)">
                Describe what you want to connect to
              </div>
              <div className="max-w-[300px] text-[11px] leading-5 text-(--ui-text-tertiary)">
                e.g. “MySQL on my VPS at db.example.com through an SSH bastion” or “a local SQLite
                file”. The agent suggests fields; you type the password yourself.
              </div>
            </div>
          ) : null}

          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div
                key={`u-${index}`}
                className="rounded-[7px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-3 py-2 text-[12.5px] whitespace-pre-wrap"
              >
                {message.text}
              </div>
            ) : (
              <div key={`a-${index}`} className="flex flex-col gap-2">
                <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap">
                  {message.answer}
                </div>
                {message.draft && Object.keys(message.draft).length ? (
                  <div className="flex flex-col gap-1 rounded-[6px] border border-(--ui-stroke-secondary) p-2">
                    {Object.entries(message.draft).map(([key, value]) => (
                      <div key={key} className="flex items-baseline gap-2 text-[11.5px]">
                        <span className="w-24 shrink-0 text-(--ui-text-tertiary)">
                          {FIELD_LABELS[key] || key}
                        </span>
                        <span className="min-w-0 truncate font-mono">{String(value)}</span>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-1">
                      <Button size="sm" onClick={() => onUse(message.draft)}>
                        Use this setup
                      </Button>
                      <span className="text-[10px] text-(--ui-text-tertiary)">
                        Password stays blank.
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          )}

          {busy ? (
            <div className="flex items-center gap-2 text-[11px] text-(--ui-text-tertiary)">
              <Codicon name="loading" className="animate-spin" />
              Thinking…
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <div className="shrink-0 border-t border-(--ui-stroke-secondary) p-3">
          <div className="flex items-end gap-2 rounded-[8px] border border-(--ui-stroke-secondary) bg-background p-2 focus-within:border-primary/50">
            <textarea
              value={prompt}
              rows={2}
              placeholder="Describe the connection…"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void ask()
                }
              }}
              className="min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[12.5px] leading-5 outline-none placeholder:text-(--ui-text-tertiary)"
            />
            <Button
              size="sm"
              disabled={busy || !prompt.trim() || (config && !config.configured)}
              onClick={() => void ask()}
            >
              Ask
            </Button>
          </div>
          <div className="pt-1 text-[10px] text-(--ui-text-tertiary)">
            Only your message and the suggested fields leave this Mac. Credentials never do.
          </div>
        </div>
      </div>
    </div>
  )
}
