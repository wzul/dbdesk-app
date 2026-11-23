/* The standalone build has no Hermes runtime, so MCP connections cannot run. */
globalThis.__DBDESK_NO_MCP__ = true

import './app.css'
import '@vscode/codicons/dist/codicon.css'

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import plugin, { DbDesk } from './plugin.js'
import Launcher from './launcher.jsx'
import { rest, onNotify } from './sdk-shim.jsx'

const ACTIVE_KEY = 'dbdesk.activeConnection'

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
    <DbDesk
      key={generation}
      startNew={startNew}
      onHome={() => setView('connections')}
    />
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <Shell />
    <Toasts />
  </>
)
