/* The standalone build has no Hermes runtime, so MCP connections cannot run. */
globalThis.__DBDESK_STANDALONE__ = true

import './app.css'
import '@vscode/codicons/dist/codicon.css'

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import plugin, { DbDesk } from './plugin.js'
import Launcher from './launcher.jsx'
import SettingsDialog from './settings-dialog.jsx'
import { isMacOS, sendNativeNotification } from './notify.js'
import { rest, onNotify } from './sdk-shim.jsx'

const ACTIVE_KEY = 'dbdesk.activeConnection'
const APP_VERSION = '0.12.0'
const ZOOM_KEY = 'dbdesk.zoom'
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function readZoom() {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY))
    return ZOOM_STEPS.includes(value) ? value : 1
  } catch {
    return 1
  }
}

async function applyZoom(scale) {
  const value = ZOOM_STEPS.includes(scale) ? scale : 1
  try {
    localStorage.setItem(ZOOM_KEY, String(value))
  } catch {
    /* private mode */
  }
  if (window.__TAURI_INTERNALS__) {
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      await getCurrentWebviewWindow().setZoom(value)
      return
    } catch {
      /* fall through to CSS zoom */
    }
  }
  document.documentElement.style.zoom = String(value)
}

function stepZoom(direction) {
  const current = readZoom()
  if (direction === 0) return 1
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) || ZOOM_STEPS[0]
  return next
}


const KIND_LABELS = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mariadb: 'MariaDB',
  clickhouse: 'ClickHouse',
  sqlite: 'SQLite',
  mcp: 'MCP',
  http: 'HTTP gateway'
}

function StatusBar({ connection }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-(--ui-stroke-secondary) bg-(--ui-bg-sidebar) px-3 text-[10.5px] text-(--ui-text-tertiary)">
      <span className="flex items-center gap-1.5">
        <span
          className={
            'size-1.5 rounded-full ' +
            (connection ? 'bg-emerald-500' : 'bg-(--ui-text-tertiary) opacity-50')
          }
        />
        <span className="text-(--ui-text-secondary)">
          {connection ? 'Connected' : 'No connection'}
        </span>
      </span>
      {connection ? <span className="truncate">{connection.name}</span> : null}
      {connection ? (
        <span className="truncate">
          {KIND_LABELS[connection.flavor === 'mariadb' ? 'mariadb' : connection.kind] ||
            connection.kind}
        </span>
      ) : null}
      {connection ? (
        <span>{connection.readonly ? 'read-only' : 'writes allowed'}</span>
      ) : null}
      <span className="flex-1" />
      <span>DB Desk {APP_VERSION}</span>
    </div>
  )
}

/* Follow the OS light/dark preference (the page uses the `dark:` variant). */
const scheme = window.matchMedia('(prefers-color-scheme: dark)')
let appearance = 'system'
const applyScheme = () => {
  const dark = appearance === 'dark' || (appearance === 'system' && scheme.matches)
  document.documentElement.classList.toggle('dark', dark)
}
applyScheme()
scheme.addEventListener('change', () => {
  if (appearance === 'system') applyScheme()
})
window.addEventListener('dbdesk:appearance', (event) => {
  const value = event.detail
  appearance = ['system', 'light', 'dark'].includes(value) ? value : 'system'
  applyScheme()
})
rest('/prefs')
  .then((prefs) => {
    appearance = prefs.appearance || 'system'
    applyScheme()
  })
  .catch(() => {})

/* Register the page exactly like the Hermes plugin host does: this injects the
 * page's stylesheet and hands it the REST helper. */
plugin.register({
  rest,
  onDispose() {},
  registerMany() {}
})

let nextToast = 1

function Toasts() {
  const [items, setItems] = useState([])

  useEffect(
    () =>
      onNotify((payload) => {
        const id = nextToast++
        const kind = payload.kind || 'info'
        setItems((current) => [...current.slice(-2), { id, kind, message: payload.message || '' }])
        setTimeout(() => {
          setItems((current) => current.filter((item) => item.id !== id))
        }, 4000)
      }),
    []
  )

  if (!items.length) return null
  return (
    <div className="dbd-toasts">
      {items.map((item) => (
        <div key={item.id} className="dbd-toast" data-kind={item.kind} role="status">
          {item.message}
        </div>
      ))}
    </div>
  )
}


function useNativeNotifications() {
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return
    let cancelled = false
    let timer = null
    let seenApprovals = null
    let lastAudit = null

    const tick = async () => {
      if (cancelled || !seenApprovals) return
      try {
        const prefs = await rest('/prefs')
        if (!prefs.notifications) return
      } catch {
        /* server starting */
      }
      try {
        const approvals = await rest('/approvals?limit=50')
        for (const entry of approvals.approvals || []) {
          if (entry.status === 'pending' && !seenApprovals.has(entry.id)) {
            seenApprovals.add(entry.id)
            void sendNativeNotification(
              'DB Desk — approval required',
              `${entry.action} on ${entry.connection_name} (${entry.database})`
            )
          }
        }
        const audit = await rest('/audit?limit=50')
        for (const entry of (audit.entries || []).slice().reverse()) {
          const ts = Number(entry.ts) || 0
          if (ts <= lastAudit) continue
          lastAudit = Math.max(lastAudit, ts)
          if (!entry.production || entry.action === 'approval_requested') continue
          void sendNativeNotification(
            entry.ok ? 'DB Desk — production write' : 'DB Desk — production write failed',
            `${entry.action} on ${entry.connection_name} (${entry.database}) · ${entry.rows} row(s)`
          )
        }
      } catch {
        /* server starting or notifications unavailable */
      }
    }

    const setup = async () => {
      if (!isMacOS()) {
        try {
          const { isPermissionGranted, requestPermission } = await import(
            '@tauri-apps/plugin-notification'
          )
          let granted = await isPermissionGranted()
          if (!granted) granted = (await requestPermission()) === 'granted'
          if (!granted) return
        } catch {
          return
        }
      }
      try {
        const [approvals, audit] = await Promise.all([
          rest('/approvals?limit=50'),
          rest('/audit?limit=50')
        ])
        seenApprovals = new Set(
          (approvals.approvals || []).filter((entry) => entry.status === 'pending').map((entry) => entry.id)
        )
        lastAudit = Math.max(
          0,
          ...(audit.entries || []).map((entry) => Number(entry.ts) || 0)
        )
      } catch {
        seenApprovals = new Set()
        lastAudit = Date.now() / 1000
      }
      if (!cancelled) timer = setInterval(tick, 10000)
    }

    void setup()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [])
}

function Shell() {
  useNativeNotifications()
  const [view, setView] = useState('connections')
  const [startNew, setStartNew] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [active, setActive] = useState(null)
  const [editId, setEditId] = useState('')
  const [setupDraft, setSetupDraft] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    if (view !== 'app') return
    let cancelled = false
    let id = editId
    if (!id) {
      try {
        id = localStorage.getItem(ACTIVE_KEY) || ''
      } catch {
        /* private mode */
      }
    }
    rest('/connections')
      .then((result) => {
        if (cancelled) return
        setActive((result.connections || []).find((item) => item.id === id) || null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [view, generation, editId])

  const open = (id) => {
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* private mode */
    }
    setStartNew(false)
    setEditId('')
    setGeneration((value) => value + 1)
    setView('app')
  }

  const create = () => {
    setStartNew(true)
    setEditId('')
    setGeneration((value) => value + 1)
    setView('app')
  }

  const edit = (id) => {
    setStartNew(false)
    setEditId(id)
    setGeneration((value) => value + 1)
    setView('app')
  }

  useEffect(() => {
    void applyZoom(readZoom())
  }, [])

  useEffect(() => {
    const handler = (event) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen((open) => !open)
        return
      }
      if (['+', '=', '-', '_', '0'].includes(event.key)) {
        event.preventDefault()
        const direction = event.key === '0' ? 0 : event.key === '+' || event.key === '=' ? 1 : -1
        void applyZoom(stepZoom(direction))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const setup = (draft) => {
    setSetupDraft(draft)
    setStartNew(true)
    setEditId('')
    setGeneration((value) => value + 1)
    setView('app')
  }

  if (view === 'connections') {
    return (
      <>
        <Launcher
          onOpen={open}
          onNew={create}
          onEdit={edit}
          onSetup={setup}
          onSettings={() => setSettingsOpen(true)}
          onReviewDraft={(entry) => setup({ ...entry.draft, _draftId: entry.id })}
        />
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          version={APP_VERSION}
        />
      </>
    )
  }
  return (
    <>
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <DbDesk
          key={generation}
          startNew={startNew}
          editConnectionId={editId}
          initialDraft={setupDraft}
          onSettings={() => setSettingsOpen(true)}
          onHome={() => setView('connections')}
        />
      </div>
      <StatusBar connection={active} />
    </div>
    <SettingsDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      version={APP_VERSION}
    />
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <Shell />
    <Toasts />
  </>
)
