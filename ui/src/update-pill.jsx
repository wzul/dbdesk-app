/**
 * The only UI the automatic updater shows: a small pill in the corner.
 *
 * Three states — downloading silently, ready to restart, or (when automatic
 * installs are switched off) offering a one-click install. It never blocks, never
 * takes focus, and it lives outside the app shell so it is visible on the
 * connection picker as well as inside a connection.
 */
import React, { useEffect, useRef, useState } from 'react'

import { Codicon } from './sdk-shim.jsx'
import {
  autoUpdateEnabled,
  checkForUpdate,
  clearPendingUpdate,
  installUpdate,
  isDesktopApp,
  pendingUpdate,
  relaunchApp
} from './updates.js'

const POLL_MS = 6 * 60 * 60 * 1000

export default function UpdatePill({ version }) {
  const [phase, setPhase] = useState('idle') // idle | checking | downloading | ready | available | failed
  const [target, setTarget] = useState('')
  const [percent, setPercent] = useState(null)
  const busy = useRef(false)

  useEffect(() => {
    if (!isDesktopApp()) return undefined

    const pending = pendingUpdate(version)
    if (pending) {
      setTarget(pending.version)
      setPhase('ready')
      return undefined
    }

    let cancelled = false
    const run = async () => {
      if (busy.current || cancelled) return
      busy.current = true
      try {
        const found = await checkForUpdate()
        if (!found || cancelled) return
        setTarget(found.version)
        if (!autoUpdateEnabled()) {
          setPhase('available')
          return
        }
        setPhase('downloading')
        await installUpdate(found, (value) => {
          if (!cancelled) setPercent(value)
        })
        if (!cancelled) setPhase('ready')
      } catch (error) {
        if (!cancelled) {
          setPhase('failed')
          setPercent(null)
          // eslint-disable-next-line no-console
          console.warn('update failed:', error)
        }
      } finally {
        busy.current = false
      }
    }

    void run()
    const timer = window.setInterval(() => void run(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [version])

  if (phase === 'idle' || phase === 'checking' || !target) return null

  const label =
    phase === 'downloading'
      ? `Downloading ${target}${percent ? ` · ${percent}%` : '…'}`
      : phase === 'ready'
        ? `${target} installed — restart to apply`
        : phase === 'failed'
          ? `Update ${target} failed`
          : `${target} available`

  return (
    <div className="dbd-update-pill" role="status" aria-live="polite">
      <Codicon name={phase === 'failed' ? 'warning' : 'cloud-download'} />
      <span>{label}</span>
      {phase === 'available' ? (
        <button
          type="button"
          className="dbd-update-action"
          onClick={async () => {
            const found = await checkForUpdate({ force: true })
            if (!found) return
            setPhase('downloading')
            try {
              await installUpdate(found, setPercent)
              setPhase('ready')
            } catch {
              setPhase('failed')
            }
          }}
        >
          Install
        </button>
      ) : null}
      {phase === 'ready' ? (
        <button type="button" className="dbd-update-action" onClick={() => void relaunchApp()}>
          Restart
        </button>
      ) : null}
      {phase === 'failed' ? (
        <button type="button" className="dbd-update-action" onClick={() => setPhase('idle')}>
          Dismiss
        </button>
      ) : null}
      {phase === 'ready' ? (
        <button
          type="button"
          className="dbd-update-dismiss"
          title="Later"
          onClick={() => {
            clearPendingUpdate()
            setPhase('idle')
          }}
        >
          <Codicon name="close" />
        </button>
      ) : null}
    </div>
  )
}
