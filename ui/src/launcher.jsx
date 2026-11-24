import React, { useEffect, useMemo, useRef, useState } from 'react'

import { Badge, Button, Codicon, cn, host, rest } from './sdk-shim.jsx'
import { ExportDialog, ImportDialog } from './bundle-dialogs.jsx'
import SetupDialog from './setup-dialog.jsx'

const KINDS = {
  postgres: { label: 'PostgreSQL', icon: 'database', tone: 'text-sky-600 dark:text-sky-400' },
  mysql: { label: 'MySQL / MariaDB', icon: 'database', tone: 'text-amber-600 dark:text-amber-400' },
  clickhouse: { label: 'ClickHouse', icon: 'graph', tone: 'text-yellow-600 dark:text-yellow-400' },
  sqlite: { label: 'SQLite', icon: 'file', tone: 'text-emerald-600 dark:text-emerald-400' },
  mcp: { label: 'MCP', icon: 'plug', tone: 'text-purple-600 dark:text-purple-400' },
  http: { label: 'HTTP gateway', icon: 'cloud', tone: 'text-blue-600 dark:text-blue-400' }
}

function kindOf(connection) {
  return KINDS[connection.kind] || KINDS.postgres
}

function targetOf(connection) {
  const kind = connection.kind || 'postgres'
  if (kind === 'sqlite') return connection.dbname || ''
  if (kind === 'mcp') return connection.mcp_server ? `MCP · ${connection.mcp_server}` : 'MCP'
  if (kind === 'http') return connection.http_url || ''
  return `${connection.host || ''}:${connection.port || ''}/${connection.dbname || ''}`
}

function ConnectionRow({ connection, onOpen, onExport, onMenu }) {
  const kind = kindOf(connection)
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-[6px] border border-transparent',
        'hover:border-(--ui-stroke-secondary) hover:bg-(--ui-bg-secondary)'
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(connection.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          onMenu(connection, event.clientX, event.clientY)
        }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-[6px] px-3 py-2.5 text-left focus-visible:outline-none"
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-[5px] border',
            'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
          )}
        >
          <Codicon name={kind.icon} className={cn('text-base', kind.tone)} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium">{connection.name}</span>
            {connection.production ? (
              <Badge variant="destructive" size="xs">
                PROD
              </Badge>
            ) : null}
            {connection.readonly ? (
              <Badge variant="outline" size="xs">
                read-only
              </Badge>
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-(--ui-text-tertiary)">
            <span className="shrink-0">{kind.label}</span>
            <span className="shrink-0 opacity-50">·</span>
            <span className="truncate font-mono">{targetOf(connection)}</span>
          </span>
        </span>
        <Codicon
          name="chevron-right"
          className="shrink-0 text-(--ui-text-tertiary) opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>
      <button
        type="button"
        title="Export / share"
        onClick={() => onExport(connection)}
        className={cn(
          'mr-2 flex size-7 shrink-0 items-center justify-center rounded-[4px]',
          'text-(--ui-text-tertiary) opacity-0 transition-opacity',
          'hover:bg-(--ui-bg-quaternary) group-hover:opacity-100 focus-visible:opacity-100'
        )}
      >
        <Codicon name="link" />
      </button>
    </div>
  )
}

function ContextMenu({ menu, onClose, onOpen, onEdit, onClone, onTest, onExport, onDelete }) {
  const width = 210
  const left = Math.min(menu.x, window.innerWidth - width - 8)
  const top = Math.min(menu.y, window.innerHeight - 230)
  const item =
    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-(--ui-bg-secondary)'
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-50 flex flex-col rounded-[5px] border border-(--ui-stroke-secondary) bg-background py-1 shadow-xl"
        style={{ left, top, width }}
      >
        <button type="button" className={item} onClick={() => onOpen(menu.connection)}>
          <Codicon name="arrow-right" className="text-(--ui-text-tertiary)" />
          Open
        </button>
        <button type="button" className={item} onClick={() => onEdit(menu.connection)}>
          <Codicon name="edit" className="text-(--ui-text-tertiary)" />
          Edit connection
        </button>
        <button type="button" className={item} onClick={() => onClone(menu.connection)}>
          <Codicon name="copy" className="text-(--ui-text-tertiary)" />
          Clone connection
        </button>
        <button type="button" className={item} onClick={() => onTest(menu.connection)}>
          <Codicon name="debug-alt" className="text-(--ui-text-tertiary)" />
          Test connection
        </button>
        <button type="button" className={item} onClick={() => onExport(menu.connection)}>
          <Codicon name="link" className="text-(--ui-text-tertiary)" />
          Export / share…
        </button>
        <div className="my-1 h-px bg-(--ui-stroke-secondary)" />
        <button
          type="button"
          className={item + ' text-destructive'}
          onClick={() => onDelete(menu.connection)}
        >
          <Codicon name="trash" />
          Delete connection
        </button>
      </div>
    </>
  )
}

export default function Launcher({ onOpen, onNew, onEdit, onSetup, onSettings, onReviewDraft }) {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState(null)
  const [drafts, setDrafts] = useState([])
  const [menu, setMenu] = useState(null)
  const [update, setUpdate] = useState(null)
  const [updateState, setUpdateState] = useState('')
  const [checking, setChecking] = useState(false)
  const searchRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const loadDrafts = () => {
      rest('/connection-drafts')
        .then((result) => {
          if (!cancelled) setDrafts(result.drafts || [])
        })
        .catch(() => {})
    }
    loadDrafts()
    const timer = setInterval(loadDrafts, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [reloadKey])

  useEffect(() => {
    const reload = () => setReloadKey((value) => value + 1)
    window.addEventListener('dbdesk:reload', reload)
    return () => window.removeEventListener('dbdesk:reload', reload)
  }, [])

  const dismissDraft = async (draftId) => {
    try {
      await rest(`/connection-drafts/${draftId}/dismissed`, { method: 'POST' })
      setDrafts((current) => current.filter((draft) => draft.id !== draftId))
    } catch {
      /* keep it visible */
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    rest('/connections')
      .then((result) => {
        if (!cancelled) {
          setConnections(result.connections || [])
          setError('')
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason.message || String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const checkForUpdates = async () => {
    if (!window.__TAURI_INTERNALS__ || checking) return
    setChecking(true)
    setUpdateState('')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const found = await check()
      setUpdate(found || null)
      if (!found) setUpdateState('Up to date')
    } catch (error) {
      setUpdateState(`Check failed: ${error.message || error}`)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void checkForUpdates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  useEffect(() => {
    if (!menu) return
    const onKey = (event) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const testConnection = async (connection) => {
    setMenu(null)
    try {
      const result = await rest('/connections/test', {
        method: 'POST',
        body: { id: connection.id }
      })
      host.notify({
        kind: 'success',
        message: `Connected: ${result.server.version || connection.name}`
      })
    } catch (error) {
      host.notify({ kind: 'error', message: String(error.message || error) })
    }
  }

  const cloneConnection = async (connection) => {
    setMenu(null)
    setError('')
    try {
      const result = await rest(`/connections/${connection.id}/clone`, {
        method: 'POST'
      })
      setReloadKey((value) => value + 1)
      host.notify({ kind: 'info', message: `Cloned “${connection.name}”` })
      return result
    } catch (reason) {
      setError(String(reason.message || reason))
    }
  }

  const deleteConnection = async (connection) => {
    setMenu(null)
    if (!window.confirm(`Delete connection "${connection.name}"?`)) return
    try {
      await rest(`/connections/${connection.id}`, { method: 'DELETE' })
      setReloadKey((value) => value + 1)
      host.notify({ kind: 'success', message: `Deleted “${connection.name}”` })
    } catch (error) {
      host.notify({ kind: 'error', message: String(error.message || error) })
    }
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = connections.filter((connection) => {
      if (!needle) return true
      const kind = kindOf(connection)
      return [connection.name, connection.group, connection.dbname, connection.host, targetOf(connection), kind.label]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    })
    const byGroup = new Map()
    for (const connection of matching) {
      const name = (connection.group || '').trim() || 'Ungrouped'
      if (!byGroup.has(name)) byGroup.set(name, [])
      byGroup.get(name).push(connection)
    }
    return [...byGroup.entries()].sort((a, b) => {
      if (a[0] === 'Ungrouped') return 1
      if (b[0] === 'Ungrouped') return -1
      return a[0].localeCompare(b[0])
    })
  }, [connections, query])

  const flat = groups.flatMap(([, items]) => items)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-6 py-12">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
            <Codicon name="database" className="text-xl" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">DB Desk</h1>
            <p className="text-[11.5px] text-(--ui-text-tertiary)">
              Choose a connection to open
            </p>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onSettings}
            title="Settings (⌘,)"
            className={cn(
              'flex size-8 items-center justify-center rounded-[4px] border border-(--ui-stroke-secondary)',
              'bg-transparent text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)'
            )}
          >
            <Codicon name="settings-gear" />
          </button>
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-[4px] border border-(--ui-stroke-secondary)',
              'bg-transparent px-3 text-xs font-medium hover:bg-(--ui-bg-secondary)'
            )}
          >
            <Codicon name="sparkle" className="text-primary" />
            AI setup
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-[4px] border border-(--ui-stroke-secondary)',
              'bg-transparent px-3 text-xs font-medium hover:bg-(--ui-bg-secondary)'
            )}
          >
            <Codicon name="cloud-download" />
            Import
          </button>
          <button
            type="button"
            onClick={onNew}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-[4px] border border-(--ui-stroke-secondary)',
              'bg-(--ui-bg-secondary) px-3 text-xs font-medium hover:bg-(--ui-bg-quaternary)'
            )}
          >
            <Codicon name="add" />
            New connection
          </button>
        </div>

        {drafts.length ? (
          <div className="flex flex-col gap-2">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className="flex items-center gap-3 rounded-[6px] border border-primary/30 bg-primary/5 px-3 py-2"
              >
                <Codicon name="sparkle" className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">
                    Agent drafted “{draft.draft.name}”
                  </div>
                  <div className="truncate text-[10.5px] text-(--ui-text-tertiary)">
                    {draft.draft.kind} · {draft.draft.dbname}
                    {draft.draft.host ? ` · ${draft.draft.host}` : ''} · password needed
                  </div>
                  {draft.note ? (
                    <div className="truncate text-[10px] text-(--ui-text-tertiary)">
                      {draft.note}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onReviewDraft(draft)}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-[4px] bg-primary px-2.5 text-xs font-medium text-white hover:opacity-90"
                >
                  Review
                </button>
                <button
                  type="button"
                  onClick={() => void dismissDraft(draft.id)}
                  className="flex h-7 shrink-0 items-center rounded-[4px] border border-(--ui-stroke-secondary) px-2.5 text-xs hover:bg-(--ui-bg-secondary)"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="relative">
          <Codicon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-(--ui-text-tertiary)"
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && flat[0]) onOpen(flat[0].id)
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="Search connections…"
            className={cn(
              'h-9 w-full rounded-[5px] border border-(--ui-stroke-secondary) bg-background pl-8 pr-3',
              'text-xs outline-none placeholder:text-(--ui-text-tertiary) focus:border-primary/60'
            )}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-(--ui-text-tertiary)">
            ⏎ open
          </span>
        </div>

        {error ? (
          <div className="rounded-[4px] bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="px-1 py-8 text-xs text-(--ui-text-tertiary)">Loading connections…</div>
        ) : !connections.length ? (
          <div className="flex flex-col items-center gap-3 rounded-[6px] border border-dashed border-(--ui-stroke-secondary) px-6 py-14">
            <Codicon name="database" className="text-2xl text-(--ui-text-tertiary)" />
            <div className="text-[13px] font-medium">No connections yet</div>
            <div className="text-[11.5px] text-(--ui-text-tertiary)">
              Add PostgreSQL, MySQL/MariaDB, ClickHouse or a local SQLite file.
            </div>
            <button
              type="button"
              onClick={onNew}
              className="mt-1 flex h-8 items-center gap-1.5 rounded-[4px] bg-primary px-3 text-xs font-medium text-white hover:opacity-90"
            >
              <Codicon name="add" />
              New connection
            </button>
          </div>
        ) : !flat.length ? (
          <div className="px-1 py-8 text-xs text-(--ui-text-tertiary)">
            Nothing matches “{query}”.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map(([group, items]) => (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="px-3 pb-1 text-[10px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">
                  {group === 'Ungrouped' ? 'Connections' : group}
                </div>
                {items.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    onOpen={onOpen}
                    onExport={setExportTarget}
                    onMenu={(connection, x, y) => setMenu({ connection, x, y })}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {window.__TAURI_INTERNALS__ && update ? (
          <div className="flex flex-wrap items-center gap-2 rounded-[5px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-3 py-2">
            <Codicon name="cloud-download" className="text-primary" />
            <span className="text-[12px] font-medium">
              Update available — v{update.version}
            </span>
            <span className="text-[10.5px] text-(--ui-text-tertiary)">
              {updateState || 'Download and restart to apply.'}
            </span>
            <span className="flex-1" />
            <Button size="sm" onClick={() => void installUpdate()} disabled={updateState === 'Installing…'}>
              Update now
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1 text-[10.5px] text-(--ui-text-tertiary)">
          <span>Credentials are encrypted on this Mac. Connections never leave the machine.</span>

        </div>
      </div>

      {importOpen ? (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            setReloadKey((value) => value + 1)
          }}
        />
      ) : null}
      {exportTarget ? (
        <ExportDialog connection={exportTarget} onClose={() => setExportTarget(null)} />
      ) : null}
      {setupOpen ? (
        <SetupDialog
          onClose={() => setSetupOpen(false)}
          onUse={(draft) => {
            setSetupOpen(false)
            onSetup(draft)
          }}
        />
      ) : null}
      {menu ? (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpen={(connection) => {
            setMenu(null)
            onOpen(connection.id)
          }}
          onEdit={(connection) => {
            setMenu(null)
            onEdit(connection.id)
          }}
          onClone={cloneConnection}
          onTest={testConnection}
          onExport={(connection) => {
            setMenu(null)
            setExportTarget(connection)
          }}
          onDelete={deleteConnection}
        />
      ) : null}
    </div>
  )
}
