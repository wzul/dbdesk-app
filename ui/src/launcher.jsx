import React, { useEffect, useMemo, useRef, useState } from 'react'

import { Badge, Codicon, cn, rest } from './sdk-shim.jsx'
import { ExportDialog, ImportDialog } from './bundle-dialogs.jsx'

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

function ConnectionRow({ connection, onOpen, onExport }) {
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

export default function Launcher({ onOpen, onNew }) {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState(null)
  const searchRef = useRef(null)

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
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <p className="pt-1 text-[10.5px] text-(--ui-text-tertiary)">
          Credentials are encrypted on this Mac. Connections never leave the machine.
        </p>
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
    </div>
  )
}
