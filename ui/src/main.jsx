/* The standalone build has no Hermes runtime, so MCP connections cannot run. */
globalThis.__DBDESK_STANDALONE__ = true

import './app.css'
import '@vscode/codicons/dist/codicon.css'

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import plugin, { DbDesk } from './plugin.js'
import Launcher from './launcher.jsx'
import { rest, onNotify } from './sdk-shim.jsx'

const ACTIVE_KEY = 'dbdesk.activeConnection'
const APP_VERSION = '0.5.1'

const KIND_LABELS = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
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
        <span className="truncate">{KIND_LABELS[connection.kind] || connection.kind}</span>
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
const applyScheme = () => document.documentElement.classList.toggle('dark', scheme.matches)
applyScheme()
scheme.addEventListener('change', applyScheme)

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

function Shell() {
  const [view, setView] = useState('connections')
  const [startNew, setStartNew] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [active, setActive] = useState(null)

  useEffect(() => {
    if (view !== 'app') return
    let cancelled = false
    let id = ''
    try {
      id = localStorage.getItem(ACTIVE_KEY) || ''
    } catch {
      /* private mode */
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
  }, [view, generation])

  const open = (id) => {
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* private mode */
    }
    setStartNew(false)
    setGeneration((value) => value + 1)
    setView('app')
  }

  const create = () => {
    setStartNew(true)
    setGeneration((value) => value + 1)
    setView('app')
  }

  if (view === 'connections') {
    return <Launcher onOpen={open} onNew={create} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <DbDesk
          key={generation}
          startNew={startNew}
          onHome={() => setView('connections')}
        />
      </div>
      <StatusBar connection={active} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <Shell />
    <Toasts />
  </>
)
