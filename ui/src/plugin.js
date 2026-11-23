/* DB Desk — a TablePlus-style PostgreSQL browser as a Hermes page.
 *
 * Disk plugin: loaded uncompiled, so this file uses jsx()/jsxs() calls and
 * imports only @hermes/plugin-sdk, react and react/jsx-runtime.
 * Backend routes: /api/plugins/dbdesk/ (dashboard/plugin_api.py).
 */

import {
  Badge,
  Button,
  Codicon,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  cn,
  host,
  writeClipboardText
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

let rest = null
const call = (path, opts) => rest(path, opts)

/** REST failures arrive as `400: {"detail": "..."}`; show the detail alone. */
function errText(error) {
  const raw = error && error.message ? error.message : String(error)
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (parsed && parsed.detail) return String(parsed.detail)
    } catch {
      /* not JSON */
    }
  }
  return raw
}


const STYLES = `
.dbd-app { font-size: 12px; }
.dbd-app input, .dbd-app select, .dbd-app textarea { border-radius: 3px; }
.dbd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dbd-grid-table { border-collapse: collapse; font-size: 12px; }
.dbd-grid-table tbody tr { height: 26px; }
.dbd-grid-table tbody td { height: 26px; }
.dbd-grid-table thead th { box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); }
.dark .dbd-grid-table thead th { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35); }
.dbd-grid-table th, .dbd-grid-table td {
  padding: 3px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent);
  vertical-align: top;
  white-space: nowrap;
}
.dbd-cell-inner { display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbd-selected { background-color: color-mix(in srgb, var(--primary) 14%, transparent); }
.dbd-selected-anchor { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 55%, transparent); }
.dbd-drawer-panel { width: 100%; max-width: 420px; height: 100%; }
.dbd-editor { width: 290px; }
.dbd-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) 92px; gap: 8px; }
.dbd-sidebar {
  position: absolute; top: 0; bottom: 0; left: 0; width: 18rem;
  transform: translateX(-100%); transition: transform .15s ease; z-index: 20;
  background-color: var(--background, #fff);
  background-image: linear-gradient(var(--ui-bg-sidebar, transparent), var(--ui-bg-sidebar, transparent));
}
.dbd-sidebar[data-open="true"] { transform: translateX(0); }
.dbd-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.3); z-index: 10; }
.dbd-approval-wait { z-index: 60; }
.dbd-meta { display: none; }
.dbd-sm-hide { display: none; }
.dbd-sm-block { display: none; }
.dbd-sm-inline { display: none; }
.dbd-tree-toggle { display: inline-flex; }
@media (min-width: 640px) {
  .dbd-sm-hide { display: inline-flex; }
  .dbd-sm-block { display: block; }
  .dbd-sm-inline { display: inline; }
}
@media (min-width: 768px) {
  .dbd-sidebar { position: static; width: 16rem; transform: none; z-index: auto; box-shadow: none; }
  .dbd-backdrop, .dbd-tree-toggle { display: none; }
}
@media (min-width: 1280px) {
  .dbd-meta { display: inline; }
}
`;

let styleEl = null

const ACTIVE_KEY = 'dbdesk.activeConnection'
const DB_KEY = 'dbdesk.databases.v1'
const DEFAULT_LIMIT = 100

function readActive() {
  try {
    return localStorage.getItem(ACTIVE_KEY) || ''
  } catch {
    return ''
  }
}

function writeActive(id) {
  try {
    localStorage.setItem(ACTIVE_KEY, id || '')
  } catch {
    /* private mode */
  }
}

function readDbMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DB_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDbMap(map) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(map))
  } catch {
    /* private mode */
  }
}

function toCsv(columns, rows) {
  const escape = (value) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.map((column) => escape(column.name)).join(',')]
  for (const row of rows) lines.push(row.map(escape).join(','))
  return lines.join('\n')
}

const SQL_KEYWORDS = [
  'select','from','where','group by','order by','having','limit','offset','union all','union',
  'left join','right join','inner join','join','on','insert into','values','update','set',
  'delete from','returning','count','sum','avg','min','max','as','and','or','not','null',
  'is null','is not null','like','ilike','in','between','case','when','then','else','end',
  'distinct','asc','desc','with','begin','commit','rollback'
]

function formatSqlText(text) {
  const parts = text.split(/('(?:''|[^'])*')/g)
  const keywords = new RegExp(
    '\\b(' + SQL_KEYWORDS.map((word) => word.replace(/ /g, '\\s+')).join('|') + ')\\b',
    'gi'
  )
  const clauses =
    /\b(from|where|group by|order by|having|limit|offset|union all|union|left join|right join|inner join|join|values|set|returning)\b/gi
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      let out = part.replace(/\s+/g, ' ').replace(keywords, (match) => match.toUpperCase())
      out = out.replace(clauses, (match) => '\n' + match.toUpperCase())
      return out
    })
    .join('')
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
}

function looksSerializedPhp(value) {
  return typeof value === 'string' && /^(?:a|O|s|i|b|d):\d+[:;{]/.test(value)
}

function parsePhpSerialized(input) {
  let position = 0
  const fail = (message) => {
    throw new Error(message)
  }
  const readUntil = (char) => {
    const index = input.indexOf(char, position)
    if (index === -1) fail('Unexpected end of serialized value')
    const text = input.slice(position, index)
    position = index + 1
    return text
  }
  const encoder = new TextEncoder()
  const readValue = () => {
    const tag = input[position]
    position += 1
    if (tag === 'N') {
      if (input[position] !== ';') fail('Bad null')
      position += 1
      return null
    }
    if (tag === 'b' || tag === 'i' || tag === 'd') {
      if (input[position] !== ':') fail('Bad scalar')
      position += 1
      const text = readUntil(';')
      if (tag === 'b') return text === '1'
      return Number(text)
    }
    if (tag === 's') {
      if (input[position] !== ':') fail('Bad string')
      position += 1
      const length = Number(readUntil(':'))
      if (!Number.isFinite(length)) fail('Bad string length')
      if (input[position] !== '"') fail('Bad string quote')
      position += 1
      let end = position
      let bytes = 0
      while (end < input.length && bytes < length) {
        bytes += encoder.encode(input[end]).length
        end += 1
      }
      if (bytes !== length) fail(`String length ${length} does not match its bytes`)
      const value = input.slice(position, end)
      position = end
      if (input.slice(position, position + 2) !== '";') fail('Bad string end')
      position += 2
      return value
    }
    if (tag === 'a') {
      if (input[position] !== ':') fail('Bad array')
      position += 1
      const count = Number(readUntil(':'))
      if (!Number.isFinite(count)) fail('Bad array count')
      if (input[position] !== '{') fail('Bad array open')
      position += 1
      const entries = []
      for (let index = 0; index < count; index += 1) {
        const key = readValue()
        const value = readValue()
        entries.push([key, value])
      }
      if (input[position] !== '}') fail('Bad array close')
      position += 1
      return { __phpArray: true, entries }
    }
    fail(`Unsupported serialized tag ${tag}`)
    return null
  }
  const value = readValue()
  if (position !== input.length) fail('Trailing characters after serialized value')
  return value
}

function phpToPlain(value) {
  if (value && value.__phpArray) {
    const out = {}
    for (const [key, item] of value.entries) out[String(key)] = phpToPlain(item)
    return out
  }
  return value
}

function serializePhp(value) {
  const encoder = new TextEncoder()
  if (value === null || value === undefined) return 'N;'
  if (typeof value === 'boolean') return `b:${value ? 1 : 0};`
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `i:${value};` : `d:${value};`
  }
  if (typeof value === 'string') {
    return `s:${encoder.encode(value).length}:"${value}";`
  }
  if (value && value.__phpArray) {
    const body = value.entries
      .map(([key, item]) => serializePhp(key) + serializePhp(item))
      .join('')
    return `a:${value.entries.length}:{${body}}`
  }
  throw new Error('Unsupported value')
}

function fixPhpLengths(value) {
  return serializePhp(parsePhpSerialized(value))
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function shortenType(type) {
  if (!type) return ''
  return type
    .replace('character varying', 'varchar')
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('double precision', 'float8')
}

const SENSITIVE_TABLES = new Set([
  'wp_options',
  'wp_users',
  'wp_usermeta',
  'users',
  'accounts',
  'subscriptions'
])

function columnKind(type) {
  const text = String(type || '').toLowerCase()
  if (text.includes('bool')) return 'boolean'
  if (text.includes('json')) return 'json'
  if (
    /(^|[^a-z])(tinyint|smallint|mediumint|int|integer|bigint|uint\d*|int\d*|float|double|real|numeric|decimal|money)/.test(
      text
    )
  ) {
    return 'number'
  }
  return 'text'
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true'
}

function SqlConfirm({ pending, onCancel }) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const execute = async () => {
    setBusy(true)
    setErr('')
    try {
      await pending.run()
    } catch (error) {
      setErr(errText(error))
      setBusy(false)
    }
  }

  const blocked = pending.production && !ack

  return jsxs('div', {
    className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3',
    children: [
      jsxs('div', {
        className:
          'flex max-h-[92vh] w-full max-w-[760px] flex-col gap-3 overflow-auto rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center gap-2',
            children: [
              jsx(Codicon, { key: 'i', name: 'database', className: 'text-(--ui-text-secondary)' }),
              jsx('div', { key: 't', className: 'text-sm font-semibold', children: pending.title }),
              jsx('div', { key: 's', className: 'flex-1' }),
              pending.production
                ? jsx(Badge, { key: 'p', variant: 'destructive', size: 'xs', children: 'PRODUCTION' })
                : null,
              pending.async
                ? jsx(Badge, { key: 'a', variant: 'muted', size: 'xs', children: 'async mutation' })
                : null
            ]
          }),
          pending.production
            ? jsx('div', {
                key: 'warn',
                className:
                  'rounded-[3px] border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive',
                children:
                  'This connection is marked PRODUCTION. The statement below changes live data.'
              })
            : null,
          pending.sensitive
            ? jsx('div', {
                key: 'sensitive',
                className:
                  'rounded-[3px] border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300',
                children:
                  'This table backs WordPress/users. A wrong write can break logins, options or the site.'
              })
            : null,
          jsx('pre', {
            key: 'sql',
            className:
              'max-h-[45vh] overflow-auto rounded-[3px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap',
            children: pending.sql
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          pending.production
            ? jsxs('label', {
                key: 'ack',
                className: 'flex items-start gap-2 text-[11px] text-(--ui-text-secondary)',
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: ack,
                    onChange: (event) => setAck(event.target.checked)
                  }),
                  jsx('span', {
                    children: 'I understand this writes to the production database.'
                  })
                ]
              })
            : null,
          jsxs('div', {
            key: 'actions',
            className: 'flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx('div', { className: 'flex-1' }),
              jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: onCancel,
                disabled: busy,
                children: 'Cancel'
              }),
              jsx(Button, {
                variant: pending.production ? 'destructive' : 'default',
                size: 'sm',
                onClick: execute,
                disabled: busy || blocked,
                children: busy ? 'Running…' : 'Execute'
              })
            ]
          })
        ]
      })
    ]
  })
}

function isNumeric(value) {
  return value !== null && /^-?\d+(\.\d+)?$/.test(String(value))
}

const TD = 'border-b border-(--ui-stroke-secondary) px-2 py-1 align-middle whitespace-nowrap'
const TH = 'sticky top-0 z-10 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1.5 text-left align-bottom text-[11px] font-semibold whitespace-nowrap text-(--ui-text-secondary)'

function CellMenu({ menu, onClose, onEdit, onCopy, onCopyRow, onFollow, onRowDetail }) {
  const top = Math.max(8, Math.min(window.innerHeight - 210, menu.rect.bottom + 6))
  const left = Math.max(8, Math.min(window.innerWidth - 210, menu.rect.left))
  const row = (label, icon, action) =>
    jsx('button', {
      type: 'button',
      className:
        'flex items-center gap-2 rounded-[2px] px-2 py-1.5 text-left text-[11.5px] hover:bg-(--chrome-action-hover)',
      onClick: () => {
        onClose()
        action()
      },
      children: [
        jsx(Codicon, { key: 'i', name: icon }),
        jsx('span', { key: 't', children: label })
      ]
    })

  return jsxs('div', {
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close cell menu',
        className: 'fixed inset-0 z-40 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        style: { top: `${top}px`, left: `${left}px` },
        className:
          'fixed z-50 flex w-52 flex-col rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
        children: [
          menu.editable ? row('Edit', 'edit', onEdit) : null,
          row('Copy value', 'copy', onCopy),
          row('Copy row', 'list-flat', onCopyRow),
          row('Row detail', 'eye', onRowDetail),
          menu.fk && menu.value !== null
            ? row(`Follow → ${menu.fk.table}`, 'link', onFollow)
            : null
        ]
      })
    ]
  })
}

function ResultChart({ columns, rows, type, onType }) {
  const numeric = columns
    .map((column, index) => ({ name: column.name, index }))
    .filter((column) => rows.some((row) => isNumeric(row[column.index])))
  const numericNames = new Set(numeric.map((column) => column.name))
  const labelColumn = columns.find((column) => !numericNames.has(column.name))
  const [x, setX] = useState(labelColumn ? labelColumn.name : columns[0] ? columns[0].name : '')
  const [y, setY] = useState(
    numeric[0] ? numeric[0].name : columns[0] ? columns[0].name : ''
  )

  if (columns.length === 0) return null
  const xi = columns.findIndex((column) => column.name === x)
  const yi = columns.findIndex((column) => column.name === y)
  const points = rows.slice(0, 60).map((row) => ({
    label: xi >= 0 ? String(row[xi] === null ? '' : row[xi]) : '',
    value: yi >= 0 ? Number(row[yi]) || 0 : 0
  }))
  const max = Math.max(1, ...points.map((point) => Math.abs(point.value)))
  const width = 600
  const height = 200
  const slot = points.length > 0 ? (width - 20) / points.length : 0

  return jsxs('div', {
    className: 'flex shrink-0 flex-col gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
    children: [
      jsxs('div', {
        key: 'controls',
        className: 'flex flex-wrap items-center gap-2 text-[11px]',
        children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Chart' }),
          jsx('select', {
            className:
              'h-6 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1 text-[11px]',
            value: type,
            onChange: (event) => onType(event.target.value),
            children: [
              jsx('option', { value: 'bar', children: 'bar' }),
              jsx('option', { value: 'line', children: 'line' })
            ]
          }),
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'x' }),
          jsx('select', {
            className:
              'h-6 max-w-[180px] rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1 text-[11px]',
            value: x,
            onChange: (event) => setX(event.target.value),
            children: columns.map((column) =>
              jsx('option', { value: column.name, children: column.name }, column.name)
            )
          }),
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'y' }),
          jsx('select', {
            className:
              'h-6 max-w-[180px] rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1 text-[11px]',
            value: y,
            onChange: (event) => setY(event.target.value),
            children: columns.map((column) =>
              jsx('option', { value: column.name, children: column.name }, column.name)
            )
          }),
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: `max ${max}` })
        ]
      }),
      numeric.length === 0
        ? jsx('div', {
            key: 'none',
            className: 'text-[11px] text-(--ui-text-tertiary)',
            children: 'No numeric column to chart.'
          })
        : jsx('svg', {
            key: 'svg',
            viewBox: `0 0 ${width} ${height}`,
            className: 'h-[180px] w-full',
            preserveAspectRatio: 'none',
            children:
              type === 'line'
                ? jsx('polyline', {
                    points: points
                      .map((point, index) => {
                        const px = 10 + index * slot + slot / 2
                        const py = 190 - (Math.abs(point.value) / max) * 170
                        return `${px},${py}`
                      })
                      .join(' '),
                    fill: 'none',
                    stroke: 'var(--primary, #3b82f6)',
                    strokeWidth: '2'
                  })
                : points.map((point, index) => {
                    const barHeight = (Math.abs(point.value) / max) * 170
                    return jsx(
                      'rect',
                      {
                        x: 10 + index * slot + 1,
                        y: 190 - barHeight,
                        width: Math.max(1, slot - 2),
                        height: barHeight,
                        fill: 'var(--primary, #3b82f6)',
                        opacity: 0.85,
                        children: jsx('title', {
                          children: `${point.label} = ${point.value}`
                        })
                      },
                      index
                    )
                  })
          })
    ]
  })
}

function Grid({
  columns,
  rows,
  emptyText,
  onSort,
  pk,
  editable,
  onEditCell,
  onDeleteRow,
  selection,
  onSelectCell,
  onSelectRow,
  fkMap,
  onFollowFk,
  onLongPress,
  hiddenColumns,
  selectable,
  selectedRows,
  onToggleRow,
  onToggleAll
}) {
  const pkSet = new Set(pk || [])
  const selectedSet = new Set(selectedRows || [])
  const allSelected = rows.length > 0 && selectedSet.size === rows.length
  const hiddenSet = new Set(hiddenColumns || [])
  const touchTimer = useRef(null)
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const cancelTouch = () => {
    if (touchTimer.current) {
      clearTimeout(touchTimer.current)
      touchTimer.current = null
    }
  }
  useEffect(() => () => cancelTouch(), [])
  const withActions = Boolean(onDeleteRow)
  const sel = selection
    ? {
        r0: Math.min(selection.r0, selection.r1),
        r1: Math.max(selection.r0, selection.r1),
        c0: Math.min(selection.c0, selection.c1),
        c1: Math.max(selection.c0, selection.c1)
      }
    : null
  const inSel = (ri, ci) => Boolean(sel && ri >= sel.r0 && ri <= sel.r1 && ci >= sel.c0 && ci <= sel.c1)
  if (!columns || columns.length === 0) {
    return jsx('div', {
      className: 'flex flex-1 items-center justify-center p-8 text-xs text-(--ui-text-tertiary)',
      children: emptyText || 'No columns.'
    })
  }

  const ROW_HEIGHT = 24
  const OVERSCAN = 8
  const virtual = rows.length > 200
  const bodyTop = Math.max(0, scrollTop - 30)
  const start = virtual
    ? Math.max(0, Math.floor(bodyTop / ROW_HEIGHT) - OVERSCAN)
    : 0
  const end = virtual
    ? Math.min(
        rows.length,
        start + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
      )
    : rows.length
  const visible = rows.slice(start, end)
  const visibleCount = columns.filter((column) => !hiddenSet.has(column.name)).length
  const columnCount = visibleCount + 1 + (withActions ? 1 : 0) + (selectable ? 1 : 0)

  return jsx('div', {
    ref: scrollRef,
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
    className: 'min-h-0 flex-1 overflow-auto',
    children: jsxs('table', {
      className: 'dbd-grid-table dbd-mono w-max min-w-full',
      children: [
        jsx('thead', {
          key: 'head',
          children: jsxs('tr', {
            children: [
              selectable
                ? jsx('th', {
                    key: '_sel',
                    className: cn(TH, 'w-8'),
                    children: jsx('input', {
                      type: 'checkbox',
                      checked: allSelected,
                      'aria-label': 'Select all rows',
                      onChange: () => onToggleAll && onToggleAll()
                    })
                  })
                : null,
              jsx('th', {
                key: '_n',
                className: cn(TH, 'w-10 text-right font-normal text-(--ui-text-tertiary)'),
                children: '#'
              })
            ]
              .concat(
                columns.map((col, i) =>
                  hiddenSet.has(col.name)
                    ? null
                    : jsx(
                    'th',
                    {
                      className: cn(TH, onSort && 'cursor-pointer select-none hover:text-(--ui-text-primary)'),
                      title: `${col.name} · ${col.type || 'unknown type'}`,
                      onClick: onSort ? () => onSort(col.name) : undefined,
                      children: jsxs('span', {
                        children: [
                          pkSet.has(col.name)
                            ? jsx(Codicon, {
                                key: 'k',
                                name: 'key',
                                className: 'mr-1 text-(--ui-text-tertiary)'
                              })
                            : null,
                          jsx('span', { key: 'n', children: col.name }),
                          col.type
                            ? jsx('span', {
                                key: 't',
                                className: 'ml-1.5 font-normal text-(--ui-text-tertiary)',
                                children: shortenType(col.type)
                              })
                            : null
                        ]
                      })
                    },
                    `${col.name}:${i}`
                  )
                )
              )
              .concat(withActions ? [jsx('th', { key: '_a', className: cn(TH, 'w-8') })] : [])
          })
        }),
        jsx('tbody', {
          key: 'body',
          children: [
            virtual && start > 0
              ? jsx(
                  'tr',
                  {
                    key: 'pad-top',
                    'aria-hidden': true,
                    style: { height: `${start * ROW_HEIGHT}px` },
                    children: jsx('td', { colSpan: columnCount })
                  },
                  'pad-top'
                )
              : null,
            ...visible.map((row, index) => {
              const ri = start + index
              return jsxs(
                'tr',
                {
                  className: cn('group', ri % 2 === 1 && 'bg-(--ui-bg-secondary)/35'),
                  children: [
                    selectable
                      ? jsx('td', {
                          className: cn(TD, 'w-8 text-center'),
                          children: jsx('input', {
                            type: 'checkbox',
                            checked: selectedSet.has(ri),
                            'aria-label': `Select row ${ri + 1}`,
                            onChange: () => onToggleRow && onToggleRow(ri),
                            onClick: (event) => event.stopPropagation()
                          })
                        })
                      : null,
                    jsx('td', {
                      className: cn(
                        TD,
                        'cursor-pointer text-right tabular-nums text-(--ui-text-tertiary)',
                        sel && ri >= sel.r0 && ri <= sel.r1 && 'dbd-selected'
                      ),
                      onClick: onSelectRow
                        ? (event) => onSelectRow(ri, event.shiftKey)
                        : undefined,
                      children: ri + 1
                    })
                  ]
                    .concat(
                      row.map((value, ci) => {
                        if (columns[ci] && hiddenSet.has(columns[ci].name)) return null
                        const isNull = value === null
                        const text = isNull ? 'NULL' : String(value)
                        return jsx(
                          'td',
                          {
                            className: cn(
                              TD,
                              isNumeric(value) && 'text-right tabular-nums',
                              isNull && 'italic text-(--ui-text-tertiary)',
                              editable && 'cursor-text hover:bg-(--chrome-action-hover)',
                              inSel(ri, ci) && 'dbd-selected',
                              sel && sel.r0 === ri && sel.c0 === ci && 'dbd-selected-anchor'
                            ),
                            title: isNull ? 'NULL' : text,
                            onClick: onSelectCell
                              ? (event) => onSelectCell(ri, ci, event.shiftKey)
                              : undefined,
                            onTouchStart: onLongPress
                              ? (event) => {
                                  cancelTouch()
                                  const rect = event.currentTarget.getBoundingClientRect()
                                  touchTimer.current = setTimeout(() => {
                                    touchTimer.current = null
                                    onLongPress(ri, ci, value, rect)
                                  }, 500)
                                }
                              : undefined,
                            onTouchEnd: cancelTouch,
                            onTouchMove: cancelTouch,
                            onTouchCancel: cancelTouch,
                            onDoubleClick: editable
                              ? (event) =>
                                  onEditCell(ri, ci, value, event.currentTarget.getBoundingClientRect())
                              : undefined,
                            children:
                              fkMap && columns[ci] && fkMap[columns[ci].name] && value !== null
                                ? jsxs('span', {
                                    className: 'flex items-center gap-1',
                                    children: [
                                      jsx('span', { className: 'dbd-cell-inner', children: text }),
                                      jsx('button', {
                                        type: 'button',
                                        title: `Follow to ${fkMap[columns[ci].name].schema}.${
                                          fkMap[columns[ci].name].table
                                        }.${fkMap[columns[ci].name].column}`,
                                        className:
                                          'shrink-0 text-primary opacity-50 hover:opacity-100',
                                        onClick: (event) => {
                                          event.stopPropagation()
                                          onFollowFk(fkMap[columns[ci].name], value)
                                        },
                                        children: jsx(Codicon, { name: 'link' })
                                      })
                                    ]
                                  })
                                : jsx('span', {
                                    className: 'dbd-cell-inner',
                                    children: text
                                  })
                          },
                          ci
                        )
                      })
                    )
                    .concat(
                      withActions
                        ? [
                            jsx(
                              'td',
                              {
                                key: '_del',
                                className: cn(TD, 'w-8 text-center'),
                                children: jsx('button', {
                                  type: 'button',
                                  title: 'Delete row',
                                  className:
                                    'rounded-[2px] p-0.5 text-(--ui-text-tertiary) opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive',
                                  onClick: (event) => {
                                    event.stopPropagation()
                                    onDeleteRow(ri)
                                  },
                                  children: jsx(Codicon, { name: 'trash' })
                                })
                              },
                              '_del'
                            )
                          ]
                        : []
                    )
                },
                ri
              )
            }),
            virtual && end < rows.length
              ? jsx(
                  'tr',
                  {
                    key: 'pad-bottom',
                    'aria-hidden': true,
                    style: { height: `${(rows.length - end) * ROW_HEIGHT}px` },
                    children: jsx('td', { colSpan: columnCount })
                  },
                  'pad-bottom'
                )
              : null
          ]
        })
      ]
    })
  })
}

function Field({ label, hint, children }) {
  return jsxs('label', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('span', {
        key: 'l',
        className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
        children: label
      }),
      children,
      hint
        ? jsx('span', {
            key: 'h',
            className: 'text-[10.5px] text-(--ui-text-tertiary)',
            children: hint
          })
        : null
    ]
  })
}

function CellEditor({ editor, column, onCancel, onSave }) {
  const kind = columnKind(column.type)
  const [value, setValue] = useState(editor.value === null ? '' : String(editor.value))
  const [flag, setFlag] = useState(isTruthy(editor.value))
  const [isNull, setIsNull] = useState(editor.value === null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [phpView, setPhpView] = useState('')
  const [phpError, setPhpError] = useState('')

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const commit = async () => {
    setBusy(true)
    setErr('')
    try {
      let payload = isNull ? null : value
      if (kind === 'boolean') payload = isNull ? null : flag ? '1' : '0'
      if (kind === 'json' && !isNull) {
        try {
          JSON.parse(value)
        } catch {
          throw new Error('Invalid JSON')
        }
      }
      await onSave(payload)
    } catch (error) {
      setErr(errText(error))
      setBusy(false)
    }
  }

  const top = Math.max(8, Math.min(window.innerHeight - 220, editor.rect.bottom + 4))
  const left = Math.max(8, Math.min(window.innerWidth - 300, editor.rect.left))
  const field =
    'w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 font-mono text-[12px] outline-none focus:border-primary/60 disabled:opacity-40'

  const control =
    kind === 'boolean'
      ? jsx('select', {
          key: 'input',
          'data-dbdesk-editor': 'cell',
          autoFocus: true,
          value: isNull ? '' : flag ? '1' : '0',
          disabled: isNull,
          className: `${field} h-8`,
          onChange: (event) => setFlag(event.target.value === '1'),
          children: [
            jsx('option', { value: '1', children: 'true' }),
            jsx('option', { value: '0', children: 'false' })
          ]
        })
      : kind === 'json'
        ? jsx('textarea', {
            key: 'input',
            'data-dbdesk-editor': 'cell',
            autoFocus: true,
            rows: 7,
            value: isNull ? '' : value,
            disabled: isNull,
            className: `${field} py-1 leading-5`,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void commit()
              }
            }
          })
        : jsx('input', {
            key: 'input',
            'data-dbdesk-editor': 'cell',
            autoFocus: true,
            type: kind === 'number' ? 'number' : 'text',
            step: kind === 'number' ? 'any' : undefined,
            value: isNull ? '' : value,
            disabled: isNull,
            className: `${field} h-8`,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commit()
              }
            }
          })

  return jsxs('div', {
    children: [
      jsx('button', {
        key: 'backdrop',
        type: 'button',
        'aria-label': 'Cancel editing',
        className: 'fixed inset-0 z-40 cursor-default',
        onClick: onCancel
      }),
      jsxs('div', {
        key: 'panel',
        style: { top: `${top}px`, left: `${left}px` },
        className:
          'dbd-editor fixed z-50 flex flex-col gap-2 rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-2 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center gap-1 text-[10.5px] text-(--ui-text-tertiary)',
            children: [
              jsx(Codicon, { key: 'k', name: column.pk ? 'key' : 'symbol-field' }),
              jsx('span', { key: 'n', className: 'font-mono text-(--ui-text-secondary)', children: column.name }),
              jsx('span', { key: 't', className: 'truncate', children: shortenType(column.type) }),
              jsx('span', { key: 'kind', className: 'ml-auto shrink-0 opacity-70', children: kind })
            ]
          }),
          control,
          kind !== 'boolean' && !isNull && looksSerializedPhp(value)
            ? jsxs('div', {
                key: 'serialized',
                className: 'flex flex-col gap-1 rounded-[3px] bg-amber-500/10 px-1.5 py-1',
                children: [
                  jsx('div', {
                    className: 'text-[10px] leading-4 text-amber-700 dark:text-amber-300',
                    children:
                      'This looks like serialized PHP. Keep the s:N lengths consistent or WordPress may drop the option.'
                  }),
                  jsxs('div', {
                    className: 'flex items-center gap-1',
                    children: [
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => {
                          setPhpError('')
                          try {
                            const parsed = phpToPlain(parsePhpSerialized(value))
                            setPhpView(JSON.stringify(parsed, null, 2))
                          } catch (error) {
                            setPhpView('')
                            setPhpError(errText(error))
                          }
                        },
                        children: 'Parse'
                      }),
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => {
                          setPhpError('')
                          try {
                            setValue(fixPhpLengths(value))
                            setPhpView('')
                          } catch (error) {
                            setPhpError(errText(error))
                          }
                        },
                        children: 'Fix lengths'
                      })
                    ]
                  }),
                  phpError
                    ? jsx('div', {
                        className: 'font-mono text-[10px] text-destructive',
                        children: phpError
                      })
                    : null,
                  phpView
                    ? jsx('pre', {
                        className:
                          'max-h-40 overflow-auto rounded-[2px] bg-(--ui-bg-secondary) p-1 font-mono text-[10px] whitespace-pre-wrap',
                        children: phpView
                      })
                    : null
                ]
              })
            : null,
          err
            ? jsx('div', {
                key: 'err',
                className: 'text-[10.5px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsxs('div', {
            key: 'actions',
            className: 'flex items-center gap-1',
            children: [
              jsx(Button, {
                variant: isNull ? 'default' : 'ghost',
                size: 'xs',
                onClick: () => setIsNull((current) => !current),
                children: 'NULL'
              }),
              jsx('div', { className: 'flex-1' }),
              jsx(Button, { variant: 'ghost', size: 'xs', onClick: onCancel, children: 'Cancel' }),
              jsx(Button, {
                variant: 'default',
                size: 'xs',
                onClick: () => void commit(),
                disabled: busy,
                children: busy ? 'Preparing…' : 'Save'
              })
            ]
          })
        ]
      })
    ]
  })
}

function InsertDrawer({ schema, table, columns, onClose, onInsert }) {
  const [state, setState] = useState(() =>
    Object.fromEntries(columns.map((column) => [column.name, { text: '', null: false }]))
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const set = (name, patch) =>
    setState((current) => ({ ...current, [name]: { ...current[name], ...patch } }))

  const save = async () => {
    setBusy(true)
    setErr('')
    const values = {}
    for (const column of columns) {
      const entry = state[column.name]
      if (entry.null) {
        values[column.name] = null
      } else if (entry.text !== '') {
        if (columnKind(column.type) === 'json') {
          try {
            JSON.parse(entry.text)
          } catch {
            setErr(`Invalid JSON in ${column.name}`)
            setBusy(false)
            return
          }
        }
        values[column.name] = entry.text
      }
    }
    try {
      await onInsert(values)
    } catch (error) {
      setErr(errText(error))
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Insert row' }),
                  jsx('div', {
                    className: 'font-mono text-[11px] text-(--ui-text-tertiary)',
                    children: `${schema}.${table}`
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsx('div', {
            key: 'note',
            className: 'text-[10.5px] text-(--ui-text-tertiary)',
            children: 'Leave a field empty to use the column default. NULL inserts an explicit null.'
          }),
          ...columns.map((column) =>
            jsxs(
              'div',
              {
                key: column.name,
                className: 'flex items-center gap-2',
                children: [
                  jsxs('div', {
                    style: { width: '42%' },
                    className: 'flex min-w-0 flex-col',
                    children: [
                      jsx('span', {
                        className: 'truncate font-mono text-[11px]',
                        children: column.name
                      }),
                      jsx('span', {
                        className: 'truncate text-[10px] text-(--ui-text-tertiary)',
                        children: `${shortenType(column.type)}${column.pk ? ' · key' : ''}${
                          column.default ? ' · default' : ''
                        }`
                      })
                    ]
                  }),
                  columnKind(column.type) === 'boolean'
                    ? jsx('select', {
                        'data-column': column.name,
                        className:
                          'h-8 min-w-0 flex-1 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs',
                        value: state[column.name].null ? '' : state[column.name].text,
                        disabled: state[column.name].null,
                        onChange: (event) => set(column.name, { text: event.target.value }),
                        children: [
                          jsx('option', { value: '', children: 'default' }),
                          jsx('option', { value: '1', children: 'true' }),
                          jsx('option', { value: '0', children: 'false' })
                        ]
                      })
                    : jsx(Input, {
                        className: 'min-w-0 flex-1',
                        'data-column': column.name,
                        type: columnKind(column.type) === 'number' ? 'number' : 'text',
                        step: columnKind(column.type) === 'number' ? 'any' : undefined,
                        value: state[column.name].null ? '' : state[column.name].text,
                        disabled: state[column.name].null,
                        placeholder:
                          columnKind(column.type) === 'json'
                            ? '{ "key": "value" }'
                            : column.nullable
                              ? 'empty = default'
                              : 'required',
                        onChange: (event) => set(column.name, { text: event.target.value })
                      }),
                  jsxs('label', {
                    className: 'flex shrink-0 items-center gap-1 text-[10px] text-(--ui-text-tertiary)',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: state[column.name].null,
                        onChange: (event) => set(column.name, { null: event.target.checked })
                      }),
                      'NULL'
                    ]
                  })
                ]
              },
              column.name
            )
          ),
          err
            ? jsx('div', {
                key: 'err',
                className:
                  'rounded-[3px] bg-destructive/10 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsxs('div', {
            key: 'actions',
            className: 'mt-auto flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx(Button, {
                variant: 'default',
                size: 'sm',
                onClick: save,
                disabled: busy,
                children: busy ? 'Inserting…' : 'Insert'
              }),
              jsx(Button, { variant: 'ghost', size: 'sm', onClick: onClose, children: 'Cancel' })
            ]
          })
        ]
      })
    ]
  })
}

function ViewsDrawer({ label, views, canSave, onApply, onSave, onDelete, onClose }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')

  const save = async () => {
    if (!name.trim() || !canSave) return
    setBusy('save')
    try {
      await onSave(name.trim())
      setName('')
    } finally {
      setBusy('')
    }
  }

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Saved views' }),
                  jsx('div', {
                    className: 'font-mono text-[11px] text-(--ui-text-tertiary)',
                    children: label || 'No table selected'
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsxs('div', {
            key: 'save',
            className: 'flex items-end gap-2',
            children: [
              jsx(Input, {
                className: 'min-w-0 flex-1',
                value: name,
                disabled: !canSave,
                placeholder: canSave ? 'Save current filters/sort as…' : 'Pick a table first',
                onChange: (event) => setName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void save()
                }
              }),
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: save,
                disabled: !canSave || !name.trim() || busy !== '',
                children: busy === 'save' ? 'Saving…' : 'Save'
              })
            ]
          }),
          jsx('div', {
            key: 'list',
            className: 'flex flex-col gap-2',
            children:
              views.length === 0
                ? jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: canSave
                      ? 'No views for this table yet.'
                      : 'Select a table to see its views.'
                  })
                : views.map((view) =>
                    jsxs(
                      'div',
                      {
                        className:
                          'flex items-start gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2 hover:bg-(--chrome-action-hover)',
                        children: [
                          jsxs('button', {
                            type: 'button',
                            className: 'flex min-w-0 flex-1 flex-col gap-0.5 text-left',
                            title: 'Apply this view',
                            onClick: () => onApply(view),
                            children: [
                              jsx('span', {
                                className: 'truncate text-[11.5px] font-medium',
                                children: view.name
                              }),
                              jsx('span', {
                                className: 'truncate text-[10px] text-(--ui-text-tertiary)',
                                children: `${(view.filters || []).length} filter(s) · ${
                                  view.order_by ? `sort ${view.order_by} ${view.order_dir}` : 'no sort'
                                } · ${view.limit} rows`
                              })
                            ]
                          }),
                          jsx(Button, {
                            variant: 'ghost',
                            size: 'icon-xs',
                            title: 'Delete view',
                            onClick: () => onDelete(view.id),
                            children: jsx(Codicon, { name: 'trash' })
                          })
                        ]
                      },
                      view.id
                    )
                  )
          })
        ]
      })
    ]
  })
}

function RowDrawer({ columns, row, onClose }) {
  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsx('div', { className: 'text-sm font-semibold', children: 'Row detail' }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsx('div', {
            key: 'table',
            className: 'overflow-auto rounded-[3px] border border-(--ui-stroke-secondary)',
            children: jsxs('table', {
              className: 'dbd-grid-table dbd-mono w-max min-w-full',
              children: [
                jsx('thead', {
                  children: jsxs('tr', {
                    children: ['column', 'value'].map((label) => jsx('th', { children: label }, label))
                  })
                }),
                jsx('tbody', {
                  children: columns.map((column, index) => {
                    const value = row[index]
                    const text =
                      value === null
                        ? 'NULL'
                        : typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)
                    return jsxs(
                      'tr',
                      {
                        children: [
                          jsx('td', { children: column.name }),
                          jsx('td', {
                            className: 'max-w-[360px]',
                            title: text,
                            children: jsx('span', { className: 'dbd-cell-inner', children: text })
                          })
                        ]
                      },
                      column.name
                    )
                  })
                })
              ]
            })
          })
        ]
      })
    ]
  })
}

function ColumnsMenu({ columns, hidden, onToggle }) {
  const [open, setOpen] = useState(false)
  const hiddenSet = new Set(hidden || [])
  return jsxs('div', {
    className: 'relative',
    children: [
      jsx(Button, {
        variant: 'ghost',
        size: 'sm',
        title: 'Show/hide columns',
        onClick: () => setOpen((value) => !value),
        children: jsxs('span', {
          className: 'flex items-center gap-1',
          children: [
            jsx(Codicon, { key: 'i', name: 'layout' }),
            jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'Columns' })
          ]
        })
      }),
      open
        ? jsxs('div', {
            key: 'menu',
            children: [
              jsx('button', {
                key: 'bg',
                type: 'button',
                'aria-label': 'Close columns menu',
                className: 'fixed inset-0 z-20 cursor-default',
                onClick: () => setOpen(false)
              }),
              jsx('div', {
                key: 'panel',
                className:
                  'absolute top-7 right-0 z-30 flex max-h-64 w-56 flex-col gap-0.5 overflow-auto rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                children: columns.map((column) =>
                  jsxs(
                    'label',
                    {
                      className: 'flex items-center gap-2 rounded-[2px] px-2 py-1 text-[11px] hover:bg-(--chrome-action-hover)',
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: !hiddenSet.has(column.name),
                          onChange: () => onToggle(column.name)
                        }),
                        jsx('span', { className: 'truncate font-mono', children: column.name })
                      ]
                    },
                    column.name
                  )
                )
              })
            ]
          })
        : null
    ]
  })
}

function CopyMenu({ disabled, canInsert, onCopy }) {
  const [open, setOpen] = useState(false)
  const pick = (format) => {
    setOpen(false)
    onCopy(format)
  }
  const items = [
    ['tsv', 'Cells (TSV)'],
    ['csv', 'CSV with header'],
    ['json', 'Rows (JSON)'],
    ...(canInsert ? [['insert', 'Rows (INSERT)']] : [])
  ]
  return jsxs('div', {
    className: 'relative',
    children: [
      jsx(Button, {
        variant: 'ghost',
        size: 'sm',
        disabled,
        title: 'Copy selection',
        onClick: () => setOpen((value) => !value),
        children: jsxs('span', {
          className: 'flex items-center gap-1',
          children: [
            jsx(Codicon, { key: 'i', name: 'copy' }),
            jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'Copy' })
          ]
        })
      }),
      open
        ? jsxs('div', {
            key: 'menu',
            children: [
              jsx('button', {
                key: 'bg',
                type: 'button',
                'aria-label': 'Close copy menu',
                className: 'fixed inset-0 z-20 cursor-default',
                onClick: () => setOpen(false)
              }),
              jsxs('div', {
                key: 'panel',
                className:
                  'absolute top-7 right-0 z-30 flex w-44 flex-col rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                children: items.map(([format, label]) =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      className:
                        'rounded-[2px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)',
                      onClick: () => pick(format),
                      children: label
                    },
                    format
                  )
                )
              })
            ]
          })
        : null
    ]
  })
}

function QueriesDrawer({ connectionId, currentSql, onPick, onClose }) {
  const [tab, setTab] = useState('history')
  const [history, setHistory] = useState([])
  const [saved, setSaved] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const [h, s] = await Promise.all([
        call('/queries/history?limit=100'),
        call('/queries/saved')
      ])
      setHistory(h.history || [])
      setSaved(s.saved || [])
    } catch (error) {
      setErr(errText(error))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const saveCurrent = async () => {
    if (!name.trim() || !currentSql.trim()) return
    setBusy('save')
    setErr('')
    try {
      await call('/queries/saved', {
        method: 'POST',
        body: { name, sql: currentSql, connection_id: connectionId }
      })
      setName('')
      await load()
      host.notify({ kind: 'info', message: 'Query saved' })
    } catch (error) {
      setErr(errText(error))
    } finally {
      setBusy('')
    }
  }

  const removeSaved = async (id) => {
    try {
      await call(`/queries/saved/${id}`, { method: 'DELETE' })
      await load()
    } catch (error) {
      setErr(errText(error))
    }
  }

  const clearHistory = async () => {
    if (!window.confirm('Clear all query history?')) return
    try {
      await call('/queries/history', { method: 'DELETE' })
      await load()
    } catch (error) {
      setErr(errText(error))
    }
  }

  const item = (entry, key, actions) =>
    jsxs(
      'div',
      {
        key,
        className:
          'flex flex-col gap-1 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2 hover:bg-(--chrome-action-hover)',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2 text-[10px] text-(--ui-text-tertiary)',
            children: [
              jsx('span', {
                className: 'min-w-0 flex-1 truncate',
                children: `${entry.connection_name || entry.connection_id || ''}${
                  entry.database ? ` · ${entry.database}` : ''
                } · ${new Date((entry.ts || entry.created_at || 0) * 1000).toLocaleString()}`
              }),
              entry.ok === false
                ? jsx(Badge, { variant: 'destructive', size: 'xs', children: 'error' })
                : null,
              actions
            ]
          }),
          entry.name
            ? jsx('div', {
                className: 'truncate text-[11px] font-medium text-(--ui-text-primary)',
                children: entry.name
              })
            : null,
          jsx('button', {
            type: 'button',
            className:
              'max-h-12 overflow-hidden text-left font-mono text-[11px] whitespace-pre-wrap text-(--ui-text-secondary) hover:text-(--ui-text-primary)',
            title: 'Load into the editor',
            onClick: () => onPick(entry.sql),
            children: entry.sql
          }),
          entry.ok === false && entry.error
            ? jsx('div', {
                className: 'font-mono text-[10px] whitespace-pre-wrap text-destructive',
                children: entry.error
              })
            : null,
          entry.ok !== false && (entry.rows || entry.duration_ms)
            ? jsx('div', {
                className: 'text-[10px] text-(--ui-text-tertiary)',
                children: `${entry.rows || 0} rows · ${entry.duration_ms || 0} ms`
              })
            : null
        ]
      },
      key
    )

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsx('div', { className: 'text-sm font-semibold', children: 'Queries' }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsxs('div', {
            key: 'tabs',
            className: 'flex items-center gap-1',
            children: [
              jsx(Button, {
                variant: tab === 'history' ? 'secondary' : 'ghost',
                size: 'sm',
                onClick: () => setTab('history'),
                children: `History (${history.length})`
              }),
              jsx(Button, {
                variant: tab === 'saved' ? 'secondary' : 'ghost',
                size: 'sm',
                onClick: () => setTab('saved'),
                children: `Saved (${saved.length})`
              }),
              jsx('div', { className: 'flex-1' }),
              tab === 'history'
                ? jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: clearHistory,
                    disabled: history.length === 0,
                    children: 'Clear'
                  })
                : null
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          tab === 'history'
            ? jsx('div', {
                key: 'history',
                className: 'flex flex-col gap-2',
                children:
                  history.length === 0
                    ? jsx('div', {
                        className: 'text-[11px] text-(--ui-text-tertiary)',
                        children: 'No queries yet. Every SQL run is recorded here.'
                      })
                    : history.map((entry) => item(entry, entry.id))
              })
            : jsxs('div', {
                key: 'saved',
                className: 'flex flex-col gap-3',
                children: [
                  jsxs('div', {
                    key: 'save',
                    className: 'flex items-end gap-2',
                    children: [
                      jsx(Input, {
                        className: 'min-w-0 flex-1',
                        value: name,
                        placeholder: 'Save current query as…',
                        onChange: (event) => setName(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') void saveCurrent()
                        }
                      }),
                      jsx(Button, {
                        variant: 'secondary',
                        size: 'sm',
                        onClick: saveCurrent,
                        disabled: !name.trim() || !currentSql.trim() || busy !== '',
                        children: busy === 'save' ? 'Saving…' : 'Save'
                      })
                    ]
                  }),
                  jsx('div', {
                    key: 'list',
                    className: 'flex flex-col gap-2',
                    children:
                      saved.length === 0
                        ? jsx('div', {
                            className: 'text-[11px] text-(--ui-text-tertiary)',
                            children: 'No saved queries.'
                          })
                        : saved.map((entry) =>
                            item(
                              entry,
                              entry.id,
                              jsx(Button, {
                                variant: 'ghost',
                                size: 'icon-xs',
                                title: 'Delete saved query',
                                onClick: (event) => {
                                  event.stopPropagation()
                                  void removeSaved(entry.id)
                                },
                                children: jsx(Codicon, { name: 'trash' })
                              })
                            )
                          )
                  })
                ]
              })
        ]
      })
    ]
  })
}

function LabelsDrawer({ connection, databases, onClose, onSaved }) {
  const [labels, setLabels] = useState(() =>
    Object.fromEntries(databases.map((db) => [db.name, db.label || '']))
  )
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const detect = async () => {
    setBusy('detect')
    setErr('')
    try {
      const result = await call(`/connections/${connection.id}/db-hints`)
      const hints = result.hints || {}
      setLabels((current) => {
        const next = { ...current }
        for (const [name, label] of Object.entries(hints)) {
          if (!next[name]) next[name] = label
        }
        return next
      })
    } catch (error) {
      setErr(errText(error))
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save')
    setErr('')
    try {
      const body = { ...connection, db_labels: {} }
      delete body.password
      for (const [name, label] of Object.entries(labels)) {
        if (label.trim()) body.db_labels[name] = label.trim()
      }
      await call('/connections', { method: 'POST', body })
      onSaved()
    } catch (error) {
      setErr(errText(error))
      setBusy('')
    }
  }

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Database labels' }),
                  jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: 'Optional — shown in the DB switcher.'
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsx(Button, {
            key: 'detect',
            variant: 'secondary',
            size: 'sm',
            onClick: detect,
            disabled: busy !== '',
            children: busy === 'detect' ? 'Detecting…' : 'Auto-detect from WordPress'
          }),
          err
            ? jsx('div', {
                key: 'err',
                className:
                  'rounded-[3px] bg-destructive/10 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsx('div', {
            key: 'list',
            className: 'flex flex-col gap-2',
            children: databases.map((db) =>
              jsxs(
                'div',
                {
                  key: db.name,
                  className: 'flex items-center gap-2',
                  children: [
                    jsx('span', {
                      style: { width: '42%' },
                      className: 'min-w-0 truncate font-mono text-[11px]',
                      title: db.name,
                      children: db.name
                    }),
                    jsx(Input, {
                      className: 'min-w-0 flex-1',
                      value: labels[db.name] || '',
                      placeholder: db.label || 'e.g. example.com',
                      onChange: (event) =>
                        setLabels((current) => ({ ...current, [db.name]: event.target.value }))
                    })
                  ]
                },
                db.name
              )
            )
          }),
          jsxs('div', {
            key: 'actions',
            className: 'mt-auto flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx(Button, {
                variant: 'default',
                size: 'sm',
                onClick: save,
                disabled: busy !== '',
                children: busy === 'save' ? 'Saving…' : 'Save labels'
              }),
              jsx(Button, { variant: 'ghost', size: 'sm', onClick: onClose, children: 'Cancel' })
            ]
          })
        ]
      })
    ]
  })
}

function IndexesDrawer({ connectionId, database, schema, table, columns, version, onCreate, onDrop, onClose }) {
  const [indexes, setIndexes] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [unique, setUnique] = useState(false)
  const [picked, setPicked] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const result = await call(
        `/connections/${connectionId}/indexes?schema=${encodeURIComponent(
          schema
        )}&table=${encodeURIComponent(table)}&database=${encodeURIComponent(database)}`
      )
      setIndexes(result.indexes || [])
    } catch (error) {
      setErr(errText(error))
    } finally {
      setLoading(false)
    }
  }, [connectionId, database, schema, table])

  useEffect(() => {
    void load()
  }, [load, version])

  const toggle = (column) =>
    setPicked((current) =>
      current.includes(column) ? current.filter((item) => item !== column) : [...current, column]
    )

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Indexes' }),
                  jsx('div', {
                    className: 'font-mono text-[11px] text-(--ui-text-tertiary)',
                    children: `${schema}.${table}`
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsx('div', {
            key: 'list',
            className: 'flex flex-col gap-2',
            children:
              loading
                ? jsx('div', { className: 'text-[11px] text-(--ui-text-tertiary)', children: 'Loading…' })
                : indexes.length === 0
                  ? jsx('div', {
                      className: 'text-[11px] text-(--ui-text-tertiary)',
                      children: 'No indexes (or index editing is unavailable for this dialect).'
                    })
                  : indexes.map((index) =>
                      jsxs(
                        'div',
                        {
                          className:
                            'flex items-start gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                          children: [
                            jsxs('div', {
                              className: 'flex min-w-0 flex-1 flex-col gap-0.5',
                              children: [
                                jsxs('div', {
                                  className: 'flex items-center gap-1',
                                  children: [
                                    jsx('span', {
                                      className: 'truncate font-mono text-[11px]',
                                      children: index.name
                                    }),
                                    index.primary
                                      ? jsx(Badge, { variant: 'muted', size: 'xs', children: 'PK' })
                                      : null,
                                    index.unique
                                      ? jsx(Badge, { variant: 'outline', size: 'xs', children: 'unique' })
                                      : null
                                  ]
                                }),
                                jsx('div', {
                                  className: 'truncate text-[10px] text-(--ui-text-tertiary)',
                                  title: index.columns,
                                  children: index.columns
                                })
                              ]
                            }),
                            jsx(Button, {
                              variant: 'ghost',
                              size: 'icon-xs',
                              title: index.primary ? 'Primary index cannot be dropped' : 'Drop index',
                              disabled: index.primary,
                              onClick: () =>
                                onDrop({
                                  connection_id: connectionId,
                                  database,
                                  schema,
                                  table,
                                  action: 'drop',
                                  name: index.name
                                }),
                              children: jsx(Codicon, { name: 'trash' })
                            })
                          ]
                        },
                        index.name
                      )
                    )
          }),
          jsx('div', {
            key: 'create',
            className: 'mt-auto flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx('div', {
                className: 'text-[11px] font-medium text-(--ui-text-secondary)',
                children: 'Create index'
              }),
              jsx(Input, {
                value: name,
                placeholder: 'index name, e.g. idx_users_email',
                onChange: (event) => setName(event.target.value)
              }),
              jsx('div', {
                className: 'flex max-h-40 flex-col gap-1 overflow-auto',
                children: columns.map((column) =>
                  jsxs(
                    'label',
                    {
                      className: 'flex items-center gap-2 text-[11px]',
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: picked.includes(column.name),
                          onChange: () => toggle(column.name)
                        }),
                        jsx('span', { className: 'font-mono', children: column.name }),
                        jsx('span', {
                          className: 'text-[9.5px] text-(--ui-text-tertiary)',
                          children: shortenType(column.type)
                        })
                      ]
                    },
                    column.name
                  )
                )
              }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-[11px]',
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: unique,
                    onChange: (event) => setUnique(event.target.checked)
                  }),
                  jsx('span', { children: 'Unique' })
                ]
              }),
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                disabled: !name.trim() || picked.length === 0,
                onClick: () =>
                  onCreate({
                    connection_id: connectionId,
                    database,
                    schema,
                    table,
                    action: 'create',
                    name: name.trim(),
                    columns: picked,
                    unique
                  }),
                children: 'Preview'
              })
            ]
          })
        ]
      })
    ]
  })
}

function SchemaDiffDrawer({
  connectionId,
  database,
  source,
  sourceColumns,
  tables: sourceTables,
  connections,
  onClose
}) {
  const [targetConnectionId, setTargetConnectionId] = useState(connectionId)
  const [tables, setTables] = useState(sourceTables || [])
  const [target, setTarget] = useState('')
  const [columns, setColumns] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const targetConn = connections.find((conn) => conn.id === targetConnectionId)
  const targetDatabase =
    targetConnectionId === connectionId ? database : targetConn ? targetConn.dbname : ''

  useEffect(() => {
    let cancelled = false
    if (targetConnectionId === connectionId) {
      const list = sourceTables || []
      setTables(list)
      const first =
        list.find((table) => !(table.schema === source.schema && table.name === source.table)) ||
        list[0]
      if (first) setTarget(`${first.schema}.${first.name}`)
      return () => {
        cancelled = true
      }
    }
    setTables([])
    setTarget('')
    setErr('')
    call(
      `/connections/${targetConnectionId}/tree?database=${encodeURIComponent(targetDatabase)}`
    )
      .then((result) => {
        if (cancelled) return
        const flat = (result.schemas || []).flatMap((schema) =>
          schema.tables.map((table) => ({ schema: schema.name, name: table.name }))
        )
        setTables(flat)
        const first = flat.find((table) => table.name === source.table) || flat[0]
        if (first) setTarget(`${first.schema}.${first.name}`)
      })
      .catch((error) => {
        if (!cancelled) setErr(errText(error))
      })
    return () => {
      cancelled = true
    }
  }, [targetConnectionId, connectionId, targetDatabase, source.schema, source.table, sourceTables])

  useEffect(() => {
    if (!target) return undefined
    const dot = target.indexOf('.')
    const schema = dot === -1 ? '' : target.slice(0, dot)
    const table = dot === -1 ? target : target.slice(dot + 1)
    let cancelled = false
    setLoading(true)
    setErr('')
    call(
      `/connections/${targetConnectionId}/columns?schema=${encodeURIComponent(
        schema
      )}&table=${encodeURIComponent(table)}&database=${encodeURIComponent(targetDatabase)}`
    )
      .then((result) => {
        if (!cancelled) setColumns(result.columns || [])
      })
      .catch((error) => {
        if (!cancelled) setErr(errText(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target, targetConnectionId, targetDatabase])

  const targetMap = new Map(columns.map((column) => [column.name, column]))
  const rows = []
  for (const column of sourceColumns) {
    const other = targetMap.get(column.name)
    let status = 'same'
    if (!other) status = 'missing in target'
    else if (String(column.type) !== String(other.type)) status = 'type differs'
    else if (Boolean(column.nullable) !== Boolean(other.nullable)) status = 'nullability differs'
    else if (Boolean(column.pk) !== Boolean(other.pk)) status = 'key differs'
    rows.push({
      name: column.name,
      source: column.type,
      target: other ? other.type : '—',
      status
    })
    targetMap.delete(column.name)
  }
  for (const column of targetMap.values()) {
    rows.push({ name: column.name, source: '—', target: column.type, status: 'only in target' })
  }
  const differences = rows.filter((row) => row.status !== 'same').length

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Schema diff' }),
                  jsx('div', {
                    className: 'font-mono text-[11px] text-(--ui-text-tertiary)',
                    children: `${source.schema}.${source.table} → ${
                      targetConn ? `${targetConn.name}: ` : ''
                    }${target || '…'}`
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsxs('div', {
            key: 'pick-connection',
            className: 'flex items-center gap-2',
            children: [
              jsx('span', {
                className: 'shrink-0 text-[11px] text-(--ui-text-tertiary)',
                children: 'Connection'
              }),
              jsx('select', {
                className:
                  'h-7 min-w-0 flex-1 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                value: targetConnectionId,
                onChange: (event) => setTargetConnectionId(event.target.value),
                children: connections.map((conn) =>
                  jsx('option', { value: conn.id, children: `${conn.name} (${conn.kind})` }, conn.id)
                )
              })
            ]
          }),
          jsxs('div', {
            key: 'pick-table',
            className: 'flex items-center gap-2',
            children: [
              jsx('span', {
                className: 'shrink-0 text-[11px] text-(--ui-text-tertiary)',
                children: 'Table'
              }),
              jsx('select', {
                className:
                  'h-7 min-w-0 flex-1 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 font-mono text-[11px]',
                value: target,
                onChange: (event) => setTarget(event.target.value),
                children: tables.map((table) => {
                  const value = `${table.schema}.${table.name}`
                  return jsx('option', { value, children: value }, value)
                })
              })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsx('div', {
            key: 'summary',
            className: 'text-[11px] text-(--ui-text-secondary)',
            children: loading
              ? 'Loading…'
              : `${differences} difference(s), ${rows.length} column(s)`
          }),
          jsx('div', {
            key: 'table',
            className: 'overflow-auto rounded-[3px] border border-(--ui-stroke-secondary)',
            children: jsxs('table', {
              className: 'dbd-grid-table dbd-mono w-max min-w-full',
              children: [
                jsx('thead', {
                  children: jsxs('tr', {
                    children: ['column', 'source', 'target', 'status'].map((label) =>
                      jsx('th', { children: label }, label)
                    )
                  })
                }),
                jsx('tbody', {
                  children: rows.map((row, index) =>
                    jsxs(
                      'tr',
                      {
                        children: [
                          jsx('td', { children: row.name }),
                          jsx('td', { children: row.source }),
                          jsx('td', { children: row.target }),
                          jsx('td', {
                            children: jsx(Badge, {
                              variant: row.status === 'same' ? 'muted' : 'warn',
                              size: 'xs',
                              children: row.status
                            })
                          })
                        ]
                      },
                      index
                    )
                  )
                })
              ]
            })
          }),
          jsx('div', {
            key: 'note',
            className: 'text-[10px] leading-4 text-(--ui-text-tertiary)',
            children:
              'Column-level diff: type, nullability and primary-key mismatches, plus columns present on only one side. Cross-connection compares the target connection’s default database.'
          })
        ]
      })
    ]
  })
}

function ApprovalsDrawer({ approvals, onDecide, onRefresh, onClose }) {
  const pending = approvals.filter((entry) => entry.status === 'pending')
  const recent = approvals.filter((entry) => entry.status !== 'pending').slice(0, 30)
  const row = (entry, canDecide) =>
    jsxs(
      'div',
      {
        className:
          'flex flex-col gap-1 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2 text-[10px] text-(--ui-text-tertiary)',
            children: [
              jsx('span', {
                className: 'font-mono',
                children: new Date((entry.ts || 0) * 1000).toLocaleString()
              }),
              jsx('span', { className: 'truncate', children: entry.connection_name }),
              jsx(Badge, {
                variant:
                  entry.status === 'pending'
                    ? 'warn'
                    : entry.status === 'approved'
                      ? 'success'
                      : 'destructive',
                size: 'xs',
                children: entry.status
              })
            ]
          }),
          jsx('div', {
            className:
              'max-h-16 overflow-hidden font-mono text-[10.5px] whitespace-pre-wrap text-(--ui-text-secondary)',
            children: entry.sql
          }),
          canDecide
            ? jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, {
                    variant: 'default',
                    size: 'xs',
                    onClick: () => onDecide(entry.id, 'approve'),
                    children: 'Approve'
                  }),
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    className: 'text-destructive',
                    onClick: () => onDecide(entry.id, 'deny'),
                    children: 'Deny'
                  })
                ]
              })
            : null
        ]
      },
      entry.id
    )

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Approvals' }),
                  jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: `${pending.length} pending · production writes only`
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: onRefresh,
                    children: 'Refresh'
                  }),
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'icon-xs',
                    onClick: onClose,
                    children: jsx(Codicon, { name: 'close' })
                  })
                ]
              })
            ]
          }),
          jsx('div', {
            key: 'pending',
            className: 'flex flex-col gap-2',
            children:
              pending.length === 0
                ? jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: 'No pending approvals.'
                  })
                : pending.map((entry) => row(entry, true))
          }),
          recent.length
            ? jsxs('div', {
                key: 'recent',
                className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3',
                children: [
                  jsx('div', {
                    className: 'text-[10px] tracking-wide text-(--ui-text-tertiary) uppercase',
                    children: 'Recent'
                  }),
                  ...recent.map((entry) => row(entry, false))
                ]
              })
            : null
        ]
      })
    ]
  })
}

function ApprovalWait({ wait, onDecide }) {
  return jsxs('div', {
    className: 'dbd-approval-wait fixed inset-0 flex items-center justify-center bg-black/50 p-3',
    children: jsxs('div', {
      className:
        'flex w-full max-w-[640px] flex-col gap-3 rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
      children: [
        jsxs('div', {
          className: 'flex items-center gap-2',
          children: [
            jsx(Codicon, { name: 'shield' }),
            jsx('div', { className: 'text-sm font-semibold', children: 'Waiting for approval' }),
            jsx(Badge, { variant: 'warn', size: 'xs', children: 'PRODUCTION' })
          ]
        }),
        jsx('div', {
          className: 'text-[11px] text-(--ui-text-secondary)',
          children:
            'A Telegram notice was sent. Open DB Desk → Approvals on another device, or approve here.'
        }),
        jsx('pre', {
          className:
            'max-h-[30vh] overflow-auto rounded-[3px] bg-(--ui-bg-secondary) p-2 font-mono text-[11px] whitespace-pre-wrap',
          children: wait.sql
        }),
        jsxs('div', {
          className: 'flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
          children: [
            jsx('div', { className: 'flex-1' }),
            jsx(Button, {
              variant: 'ghost',
              size: 'sm',
              className: 'text-destructive',
              onClick: () => onDecide('deny'),
              children: 'Deny'
            }),
            jsx(Button, {
              variant: 'default',
              size: 'sm',
              onClick: () => onDecide('approve'),
              children: 'Approve now'
            })
          ]
        })
      ]
    })
  })
}

function AuditDrawer({ onClose }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const result = await call('/audit?limit=200')
      setEntries(result.entries || [])
    } catch (error) {
      setErr(errText(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Audit log' }),
                  jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: `${entries.length} write(s) · newest first`
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: () => void load(),
                    disabled: loading,
                    children: loading ? '…' : 'Refresh'
                  }),
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'icon-xs',
                    onClick: onClose,
                    children: jsx(Codicon, { name: 'close' })
                  })
                ]
              })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          entries.length === 0
            ? jsx('div', {
                key: 'empty',
                className: 'text-[11px] text-(--ui-text-tertiary)',
                children: 'No writes recorded yet.'
              })
            : jsxs('div', {
                key: 'list',
                className: 'flex flex-col gap-2',
                children: entries.map((entry, index) =>
                  jsxs(
                    'div',
                    {
                      className:
                        'flex flex-col gap-1 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                      children: [
                        jsxs('div', {
                          className: 'flex items-center gap-2 text-[10px] text-(--ui-text-tertiary)',
                          children: [
                            jsx('span', {
                              className: 'font-mono',
                              children: new Date((entry.ts || 0) * 1000).toLocaleString()
                            }),
                            jsx('span', { className: 'truncate', children: entry.connection_name }),
                            jsx(Badge, {
                              variant: entry.ok ? 'muted' : 'destructive',
                              size: 'xs',
                              children: entry.ok ? entry.action : 'failed'
                            }),
                            entry.production
                              ? jsx(Badge, { variant: 'destructive', size: 'xs', children: 'PROD' })
                              : null,
                            entry.rows
                              ? jsx('span', { children: `${entry.rows} row(s)` })
                              : null
                          ]
                        }),
                        jsx('div', {
                          className:
                            'max-h-16 overflow-hidden font-mono text-[10.5px] whitespace-pre-wrap text-(--ui-text-secondary)',
                          children: entry.sql
                        }),
                        entry.error
                          ? jsx('div', {
                              className: 'font-mono text-[10px] whitespace-pre-wrap text-destructive',
                              children: entry.error
                            })
                          : null
                      ]
                    },
                    index
                  )
                )
              })
        ]
      })
    ]
  })
}

function ActivityDrawer({ connectionId, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const result = await call(`/connections/${connectionId}/activity`)
      setData(result)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  const queries = (data && data.queries) || []

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Activity' }),
                  jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: `${queries.length} connection(s) · refresh 5s`
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: () => void load(),
                    disabled: loading,
                    children: loading ? '…' : 'Refresh'
                  }),
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'icon-xs',
                    onClick: onClose,
                    children: jsx(Codicon, { name: 'close' })
                  })
                ]
              })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          queries.length === 0
            ? jsx('div', {
                key: 'empty',
                className: 'text-[11px] text-(--ui-text-tertiary)',
                children: 'No active queries visible.'
              })
            : jsx('div', {
                key: 'table',
                className: 'overflow-auto rounded-[3px] border border-(--ui-stroke-secondary)',
                children: jsxs('table', {
                  className: 'dbd-grid-table dbd-mono w-max min-w-full',
                  children: [
                    jsx('thead', {
                      children: jsx('tr', {
                        children: ['id', 'user', 'db', 'state', 's', 'query'].map((label) =>
                          jsx('th', { children: label }, label)
                        )
                      })
                    }),
                    jsx('tbody', {
                      children: queries.map((row, index) =>
                        jsxs(
                          'tr',
                          {
                            children: [
                              jsx('td', { children: row.id }),
                              jsx('td', { children: row.user }),
                              jsx('td', { children: row.database }),
                              jsx('td', { children: row.state }),
                              jsx('td', { children: row.seconds }),
                              jsx('td', {
                                className: 'max-w-[420px]',
                                title: row.query,
                                children: jsx('span', {
                                  className: 'dbd-cell-inner',
                                  children: row.query
                                })
                              })
                            ]
                          },
                          index
                        )
                      )
                    })
                  ]
                })
              }),
          jsx('div', {
            key: 'note',
            className: 'text-[10px] leading-4 text-(--ui-text-tertiary)',
            children: (data && data.note) || ''
          })
        ]
      })
    ]
  })
}

function ImportDrawer({ data, tableLabel, nullEmpty, onToggleNull, onImport, onClose }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const preview = data.rows.slice(0, 5)

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      await onImport()
    } catch (error) {
      setErr(errText(error))
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'text-sm font-semibold', children: 'Import CSV' }),
                  jsx('div', {
                    className: 'font-mono text-[11px] text-(--ui-text-tertiary)',
                    children: `${data.filename} → ${tableLabel}`
                  })
                ]
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsx('div', {
            key: 'summary',
            className: 'text-[11px] text-(--ui-text-secondary)',
            children: `${data.rows.length} rows · ${data.columns.length} columns (${data.columns.join(', ')})`
          }),
          jsx('div', {
            key: 'preview',
            className: 'overflow-auto rounded-[3px] border border-(--ui-stroke-secondary)',
            children: jsxs('table', {
              className: 'dbd-grid-table dbd-mono w-max min-w-full',
              children: [
                jsx('thead', {
                  children: jsx('tr', {
                    children: data.columns.map((column) =>
                      jsx('th', { children: column }, column)
                    )
                  })
                }),
                jsx('tbody', {
                  children: preview.map((row, index) =>
                    jsx(
                      'tr',
                      {
                        children: row.map((value, cellIndex) =>
                          jsx(
                            'td',
                            {
                              title: value === '' ? '(empty)' : value,
                              children: jsx('span', {
                                className: 'dbd-cell-inner',
                                children: value === '' ? '∅' : value
                              })
                            },
                            cellIndex
                          )
                        )
                      },
                      index
                    )
                  )
                })
              ]
            })
          }),
          jsx('div', {
            key: 'more',
            className: 'text-[10px] text-(--ui-text-tertiary)',
            children:
              data.rows.length > preview.length
                ? `Showing ${preview.length} of ${data.rows.length} rows`
                : 'All rows shown'
          }),
          jsxs('label', {
            key: 'null',
            className: 'flex items-center gap-2 text-[11px]',
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: nullEmpty,
                onChange: (event) => onToggleNull(event.target.checked)
              }),
              jsx('span', { children: 'Treat empty cells as NULL' })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          jsxs('div', {
            key: 'actions',
            className: 'mt-auto flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx(Button, {
                variant: 'default',
                size: 'sm',
                onClick: run,
                disabled: busy,
                children: busy ? 'Preparing…' : `Import ${data.rows.length} rows`
              }),
              jsx(Button, { variant: 'ghost', size: 'sm', onClick: onClose, children: 'Cancel' })
            ]
          })
        ]
      })
    ]
  })
}

function ConnectionDrawer({ draft, onDraft, onClose, onSaved, onDeleted }) {
  const [busy, setBusy] = useState('')
  const [test, setTest] = useState(null)
  const [err, setErr] = useState('')
  const [mcpStatus, setMcpStatus] = useState(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const standalone = Boolean(globalThis.__DBDESK_STANDALONE__)
  const editing = Boolean(draft.id)

  useEffect(() => {
    if (!standalone || draft.kind !== 'mcp' || !draft.mcp_url) {
      setMcpStatus(null)
      return
    }
    let cancelled = false
    const check = () =>
      call(`/mcp/oauth/status?url=${encodeURIComponent(draft.mcp_url)}`)
        .then((result) => {
          if (!cancelled) setMcpStatus(result)
        })
        .catch(() => {})
    check()
    const timer = setInterval(check, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [standalone, draft.kind, draft.mcp_url])

  const authorizeMcp = async () => {
    const url = String(draft.mcp_url || '').trim()
    if (!url) return
    setMcpBusy(true)
    setErr('')
    try {
      await call('/mcp/authorize', { method: 'POST', body: { url } })
      setTest(null)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setMcpBusy(false)
    }
  }

  const forgetMcp = async () => {
    try {
      await call('/mcp/logout', { method: 'POST', body: { url: draft.mcp_url } })
      setMcpStatus({ authorized: false })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const set = (key) => (event) => {
    const value = event && event.target ? event.target.value : event
    onDraft({ ...draft, [key]: value })
  }

  const runTest = async () => {
    setBusy('test')
    setErr('')
    setTest(null)
    try {
      const result = await call('/connections/test', { method: 'POST', body: draft })
      setTest(result.server)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save')
    setErr('')
    try {
      const result = await call('/connections', { method: 'POST', body: draft })
      onSaved(result.connection)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    if (!draft.id) return
    if (!window.confirm(`Delete connection “${draft.name}”?`)) return
    setBusy('delete')
    try {
      await call(`/connections/${draft.id}`, { method: 'DELETE' })
      onDeleted(draft.id)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setBusy('')
    }
  }

  return jsxs('div', {
    className: 'absolute inset-0 z-40 flex justify-end bg-black/30',
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close',
        className: 'flex-1 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'dbd-drawer-panel flex shrink-0 flex-col gap-3 overflow-auto border-l border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
        children: [
          jsxs('div', {
            key: 'head',
            className: 'flex items-center justify-between',
            children: [
              jsx('div', {
                className: 'text-sm font-semibold',
                children: editing ? 'Edit connection' : 'New connection'
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsxs('div', {
            key: 'name',
            className: 'flex flex-col gap-3',
            children: [
              jsxs('div', {
                key: 'kind',
                className: 'dbd-grid-2',
                children: [
                  jsx(Field, {
                    label: 'Type',
                    children: jsxs('select', {
                      className:
                        'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                      value: draft.kind || 'postgres',
                      onChange: (event) => {
                        const kind = event.target.value
                        const defaults = { postgres: 5432, mysql: 3306, clickhouse: 8123, mcp: 0, http: 0, sqlite: 0 }
                        const oldDefault = draft.kind ? defaults[draft.kind] : undefined
                        const current = Number(draft.port)
                        const nextPort =
                          !draft.port || current === oldDefault || current === 5432 || current === 3306 || current === 8123
                            ? defaults[kind]
                            : draft.port
                        onDraft({ ...draft, kind, port: nextPort })
                      },
                      children: [
                        jsx('option', { value: 'postgres', children: 'PostgreSQL' }, 'postgres'),
                        jsx('option', { value: 'mysql', children: 'MySQL / MariaDB' }, 'mysql'),
                        jsx('option', { value: 'clickhouse', children: 'ClickHouse' }, 'clickhouse'),
                        jsx('option', { value: 'sqlite', children: 'SQLite (file)' }, 'sqlite'),
                        ...(globalThis.__DBDESK_NO_MCP__
                          ? []
                          : [jsx('option', { value: 'mcp', children: 'MCP (query tool)' }, 'mcp')]),
                        jsx('option', { value: 'http', children: 'HTTP (query gateway)' }, 'http')
                      ]
                    })
                  }),
                  !['mcp', 'http', 'sqlite'].includes(draft.kind || 'postgres')
                    ? jsx(Field, {
                        label: 'Port',
                        children: jsx(Input, {
                          type: 'number',
                          value: draft.port || 5432,
                          onChange: set('port')
                        })
                      })
                    : null
                ]
              }),
              jsx(Field, {
                label: 'Name',
                children: jsx(Input, {
                  value: draft.name || '',
                  placeholder: 'Local Postgres',
                  onChange: set('name')
                })
              }),
              jsx(Field, {
                label: 'Group',
                hint: 'Optional — groups connections in the sidebar.',
                children: jsx(Input, {
                  value: draft.group || '',
                  placeholder: 'e.g. staging / production',
                  onChange: set('group')
                })
              }),
              (draft.kind || 'postgres') === 'http'
                ? jsxs('div', {
                    key: 'http',
                    className: 'flex flex-col gap-3',
                    children: [
                      jsx(Field, {
                        label: 'Gateway URL',
                        hint: 'POST/GET endpoint that accepts SQL and returns JSON or a table.',
                        children: jsx(Input, {
                          value: draft.http_url || '',
                          placeholder: 'https://db-gw.example.com/query',
                          onChange: set('http_url')
                        })
                      }),
                      jsxs('div', {
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            label: 'Method',
                            children: jsxs('select', {
                              className:
                                'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                              value: draft.http_method || 'POST',
                              onChange: set('http_method'),
                              children: [
                                jsx('option', { value: 'POST', children: 'POST' }, 'POST'),
                                jsx('option', { value: 'GET', children: 'GET' }, 'GET')
                              ]
                            })
                          }),
                          jsx(Field, {
                            label: 'SQL field',
                            children: jsx(Input, {
                              value: draft.http_sql_field || 'sql',
                              placeholder: 'sql',
                              onChange: set('http_sql_field')
                            })
                          })
                        ]
                      }),
                      jsx(Field, {
                        label: 'Body',
                        hint: 'json = {"<sql field>": sql}; raw = the SQL text (ClickHouse HTTP).',
                        children: jsxs('select', {
                          className:
                            'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                          value: draft.http_body_mode || 'json',
                          onChange: set('http_body_mode'),
                          children: [
                            jsx('option', { value: 'json', children: 'JSON {sql}' }, 'json'),
                            jsx('option', { value: 'raw', children: 'Raw SQL text' }, 'raw')
                          ]
                        })
                      }),
                      jsx(Field, {
                        label: 'Headers',
                        hint: 'One Name: value per line. Cloudflare Access: CF-Access-Client-Id / CF-Access-Client-Secret.',
                        children: jsx('textarea', {
                          value: draft.http_headers || '',
                          rows: 4,
                          placeholder:
                            'CF-Access-Client-Id: xxx.access\nCF-Access-Client-Secret: yyy',
                          className:
                            'w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[11px] outline-none focus:border-primary/60',
                          onChange: (event) => onDraft({ ...draft, http_headers: event.target.value })
                        })
                      }),
                      jsxs('div', {
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            label: 'SQL dialect',
                            children: jsxs('select', {
                              className:
                                'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                              value: draft.http_dialect || 'postgres',
                              onChange: set('http_dialect'),
                              children: [
                                jsx('option', { value: 'postgres', children: 'PostgreSQL' }, 'postgres'),
                                jsx('option', { value: 'mysql', children: 'MySQL / MariaDB' }, 'mysql'),
                                jsx('option', { value: 'clickhouse', children: 'ClickHouse' }, 'clickhouse')
                              ]
                            })
                          }),
                          jsx(Field, {
                            label: 'Timeout (s)',
                            children: jsx(Input, {
                              type: 'number',
                              value: draft.http_timeout || 30,
                              onChange: set('http_timeout')
                            })
                          })
                        ]
                      })
                    ]
                  })
                : (draft.kind || 'postgres') === 'mcp'
                ? jsxs('div', {
                    key: 'mcp',
                    className: 'flex flex-col gap-3',
                    children: [
                      standalone
                        ? jsx(Field, {
                            label: 'Server URL',
                            hint: 'Streamable-HTTP MCP endpoint. Authorize once — tokens refresh automatically.',
                            children: jsx(Input, {
                              value: draft.mcp_url || '',
                              placeholder: 'https://mcp.example.com/mcp',
                              onChange: set('mcp_url')
                            })
                          })
                        : jsx(Field, {
                            label: 'MCP server',
                            hint: 'Name from mcp_servers in config.yaml. Grant it via plugins.entries.dbdesk.mcp_allowlist.',
                            children: jsx(Input, {
                              value: draft.mcp_server || '',
                              placeholder: 'e.g. my-postgres-mcp',
                              onChange: set('mcp_server')
                            })
                          }),
                      standalone
                        ? jsxs('div', {
                            key: 'mcp-auth',
                            className: 'flex flex-wrap items-center gap-2',
                            children: [
                              jsx(Button, {
                                variant: 'secondary',
                                size: 'sm',
                                disabled: mcpBusy || !draft.mcp_url,
                                onClick: authorizeMcp,
                                children: mcpBusy
                                  ? 'Opening browser…'
                                  : mcpStatus && mcpStatus.authorized
                                    ? 'Re-authorize'
                                    : 'Authorize'
                              }),
                              jsx('span', {
                                className:
                                  'text-[11px] ' +
                                  (mcpStatus && mcpStatus.authorized
                                    ? 'text-emerald-600 dark:text-emerald-300'
                                    : 'text-(--ui-text-tertiary)'),
                                children:
                                  mcpStatus && mcpStatus.authorized
                                    ? 'Authorized'
                                    : 'Not authorized yet'
                              }),
                              mcpStatus && mcpStatus.authorized
                                ? jsx(Button, {
                                    variant: 'ghost',
                                    size: 'sm',
                                    onClick: forgetMcp,
                                    children: 'Forget tokens'
                                  })
                                : null
                            ]
                          })
                        : null,
                      jsxs('div', {
                        key: 'tool',
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            label: 'Query tool',
                            children: jsx(Input, {
                              value: draft.mcp_tool || 'query',
                              placeholder: 'query',
                              onChange: set('mcp_tool')
                            })
                          }),
                          jsx(Field, {
                            label: 'SQL argument',
                            children: jsx(Input, {
                              value: draft.mcp_sql_arg || 'sql',
                              placeholder: 'sql',
                              onChange: set('mcp_sql_arg')
                            })
                          })
                        ]
                      }),
                      standalone
                        ? jsx(Field, {
                            label: 'Extra arguments (optional)',
                            hint: 'JSON merged into tools/call, e.g. {"database":"analytics"}.',
                            children: jsx(Input, {
                              value: draft.mcp_extra_args || '',
                              placeholder: '{"database":"analytics"}',
                              onChange: set('mcp_extra_args')
                            })
                          })
                        : null,
                      jsx(Field, {
                        label: 'SQL dialect',
                        children: jsxs('select', {
                          className:
                            'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                          value: draft.mcp_dialect || 'postgres',
                          onChange: set('mcp_dialect'),
                          children: [
                            jsx('option', { value: 'postgres', children: 'PostgreSQL' }, 'postgres'),
                            jsx('option', { value: 'mysql', children: 'MySQL / MariaDB' }, 'mysql'),
                            jsx('option', { value: 'clickhouse', children: 'ClickHouse' }, 'clickhouse')
                          ]
                        })
                      })
                    ]
                  })
                : (draft.kind || 'postgres') === 'sqlite'
                  ? null
                  : jsx(Field, {
                      key: 'host',
                      label: 'Host',
                      children: jsx(Input, { value: draft.host || '', onChange: set('host') })
                    }),
              jsxs('div', {
                className:
                  (draft.kind || 'postgres') === 'sqlite'
                    ? 'grid grid-cols-1 gap-3'
                    : 'grid grid-cols-2 gap-3',
                children: [
                  jsx(Field, {
                    key: 'db',
                    label: (draft.kind || 'postgres') === 'sqlite' ? 'Database file' : 'Database',
                    hint:
                      (draft.kind || 'postgres') === 'sqlite'
                        ? 'Absolute path to the .db/.sqlite file on the machine running Hermes.'
                        : undefined,
                    children: jsx(Input, {
                      value: draft.dbname || '',
                      placeholder:
                        (draft.kind || 'postgres') === 'sqlite'
                          ? '/root/data/app.db'
                          : undefined,
                      onChange: set('dbname')
                    })
                  }),
                  (draft.kind || 'postgres') === 'sqlite'
                    ? null
                    : jsx(Field, {
                        key: 'user',
                        label: 'User',
                        children: jsx(Input, { value: draft.user || '', onChange: set('user') })
                      })
                ]
              }),
              !['mcp', 'http', 'sqlite'].includes(draft.kind || 'postgres')
                ? jsx(Field, {
                    label: 'Password',
                    hint: editing ? 'Leave blank to keep the saved password.' : undefined,
                    children: jsx(Input, {
                      type: 'password',
                      value: draft.password || '',
                      placeholder: editing ? '••••••••' : '',
                      onChange: set('password')
                    })
                  })
                : null,
              !['mysql', 'mcp', 'http', 'sqlite'].includes(draft.kind || 'postgres')
                ? jsx(Field, {
                label: 'SSL mode',
                children: jsxs('select', {
                  className: 'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                  value: draft.sslmode || 'prefer',
                  onChange: set('sslmode'),
                  children: ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].map((mode) =>
                    jsx('option', { value: mode, children: mode }, mode)
                  )
                })
              })
                : null,
              ['mcp', 'http', 'sqlite'].includes(draft.kind || 'postgres')
                ? null
                : jsxs('div', {
                key: 'ssh',
                className: 'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                children: [
                  jsx('div', {
                    className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
                    children: 'SSH tunnel (optional)'
                  }),
                  jsxs('div', {
                    className: 'dbd-grid-2',
                    children: [
                      jsx(Input, {
                        value: draft.ssh_host || '',
                        placeholder: 'ssh host (e.g. bastion.example.com)',
                        onChange: set('ssh_host')
                      }),
                      jsx(Input, {
                        type: 'number',
                        value: draft.ssh_port || 22,
                        onChange: set('ssh_port')
                      })
                    ]
                  }),
                  jsx(Input, {
                    value: draft.ssh_user || 'root',
                    placeholder: 'root',
                    onChange: set('ssh_user')
                  }),
                  jsx('div', {
                    className: 'text-[10px] leading-4 text-(--ui-text-tertiary)',
                    children:
                      'Host + port above are the target as the SSH server sees it (e.g. 127.0.0.1:3307 for a published container port).'
                  }),
                  jsx(Field, {
                    label: 'Custom tunnel command (optional)',
                    hint:
                      'Overrides SSH when set. The command must open Host:Port above (SSM port forwarding, cloudflared access tcp, ...).',
                    children: jsx('textarea', {
                      value: draft.tunnel_command || '',
                      rows: 3,
                      placeholder:
                        'aws ssm start-session --target i-... --document-name AWS-StartPortForwardingSessionToRemoteHost ...',
                      className:
                        'w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[11px] outline-none focus:border-primary/60',
                      onChange: (event) => onDraft({ ...draft, tunnel_command: event.target.value })
                    })
                  }),
                  jsx(Field, {
                    label: 'Tunnel env (optional)',
                    hint: 'KEY=VALUE per line, merged into the tunnel command environment.',
                    children: jsx('textarea', {
                      value: draft.tunnel_env || '',
                      rows: 3,
                      placeholder:
                        'AWS_PROFILE=default\nAWS_REGION=ap-southeast-1',
                      className:
                        'w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[11px] outline-none focus:border-primary/60',
                      onChange: (event) => onDraft({ ...draft, tunnel_env: event.target.value })
                    })
                  })
                ]
              }),
              ['mcp', 'http'].includes(draft.kind || 'postgres')
                ? jsx('div', {
                    className: 'text-[11px] text-(--ui-text-tertiary)',
                    children: 'MCP/HTTP connections are read-only in DB Desk.'
                  })
                : jsxs('label', {
                    className: 'flex items-center gap-2 text-xs',
                    children: [
                      jsx('input', {
                        key: 'cb',
                        type: 'checkbox',
                        checked: draft.readonly !== false,
                        onChange: (event) => onDraft({ ...draft, readonly: event.target.checked })
                      }),
                      jsx('span', {
                        key: 't',
                        children: 'Read-only connection (writes refused by the backend)'
                      })
                    ]
                  }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-xs',
                children: [
                  jsx('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: Boolean(draft.production),
                    onChange: (event) => onDraft({ ...draft, production: event.target.checked })
                  }),
                  jsx('span', {
                    key: 't',
                    children: 'Production connection (extra confirmation on every write)'
                  })
                ]
              })
            ]
          }),
          err
            ? jsx('div', {
                key: 'err',
                className: 'rounded-[3px] bg-destructive/10 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive',
                children: err
              })
            : null,
          test
            ? jsxs('div', {
                key: 'test-ok',
                className: 'rounded-[3px] bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-300',
                children: [
                  jsx('div', { key: 'a', children: `Connected to ${test.database} as ${test.user}` }),
                  jsx('div', {
                    key: 'b',
                    className: 'mt-0.5 truncate font-mono text-[10.5px] opacity-80',
                    children: String(test.version || '').split(',')[0]
                  })
                ]
              })
            : null,
          jsxs('div', {
            key: 'actions',
            className: 'mt-auto flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3',
            children: [
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: runTest,
                disabled: busy !== '',
                children: busy === 'test' ? 'Testing…' : 'Test'
              }),
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: save,
                disabled: busy !== '',
                children: busy === 'save' ? 'Saving…' : 'Save'
              }),
              jsx('div', { className: 'flex-1' }),
              editing
                ? jsx(Button, {
                    variant: 'ghost',
                    size: 'sm',
                    className: 'text-destructive',
                    onClick: remove,
                    disabled: busy !== '',
                    children: 'Delete'
                  })
                : null
            ]
          })
        ]
      })
    ]
  })
}

function emptyDraft() {
  return {
    id: '',
    kind: 'postgres',
    name: '',
    group: '',
    host: '127.0.0.1',
    port: 5432,
    dbname: '',
    user: '',
    password: '',
    sslmode: 'prefer',
    readonly: true,
    production: false,
    ssh_host: '',
    ssh_user: 'root',
    ssh_port: 22,
    ssh_key: '',
    mcp_server: '',
    mcp_tool: 'query',
    mcp_sql_arg: 'sql',
    mcp_dialect: 'postgres',
    http_url: '',
    http_method: 'POST',
    http_sql_field: 'sql',
    http_body_mode: 'json',
    http_headers: '',
    http_dialect: 'postgres',
    http_timeout: 30,
    tunnel_command: '',
    tunnel_env: '',
    tunnel_timeout: 25
  }
}

function AiPanel({ connectionId, database, schema, table, onClose, onUseSql }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [config, setConfig] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    call('/ai/config')
      .then((value) => {
        setConfig(value)
        setBaseUrl(value.base_url || '')
        setModel(value.model || '')
        if (!value.configured) setSettingsOpen(true)
      })
      .catch(() => {})
  }, [])

  const ask = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const value = await call('/ai/ask', {
        method: 'POST',
        body: {
          connection_id: connectionId,
          database,
          schema: schema || '',
          table: table || '',
          question: prompt.trim(),
          execute: true
        }
      })
      setResult(value)
    } catch (reason) {
      setError(errText(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    try {
      const value = await call('/ai/config', {
        method: 'POST',
        body: { base_url: baseUrl, model, api_key: apiKey }
      })
      setConfig(value)
      setApiKey('')
      setSettingsOpen(false)
    } catch (reason) {
      setError(errText(reason))
    } finally {
      setSaving(false)
    }
  }

  return jsxs('div', {
    key: 'ai-panel',
    className:
      'flex shrink-0 flex-col gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-3 py-2',
    children: [
      jsxs('div', {
        key: 'row',
        className: 'flex items-center gap-2',
        children: [
          jsx(Codicon, { key: 'i', name: 'sparkle', className: 'text-primary' }),
          jsx('input', {
            key: 'q',
            value: prompt,
            autoFocus: true,
            placeholder: 'Ask about this data — e.g. "berapa purchases bulan ini?"',
            onChange: (event) => setPrompt(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void ask()
              }
            },
            className:
              'h-8 min-w-0 flex-1 rounded-[4px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none focus:border-primary/60'
          }),
          jsx(Button, {
            key: 'run',
            size: 'sm',
            disabled: busy || !prompt.trim() || (config && !config.configured),
            onClick: () => void ask(),
            children: busy ? 'Thinking…' : 'Ask'
          }),
          jsx(Button, {
            key: 'settings',
            variant: 'ghost',
            size: 'sm',
            title: 'AI settings',
            onClick: () => setSettingsOpen((open) => !open),
            children: jsx(Codicon, { name: 'settings-gear' })
          }),
          jsx(Button, {
            key: 'close',
            variant: 'ghost',
            size: 'sm',
            title: 'Close',
            onClick: onClose,
            children: jsx(Codicon, { name: 'close' })
          })
        ]
      }),
      settingsOpen
        ? jsxs('div', {
            key: 'settings',
            className:
              'flex flex-col gap-2 rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-2',
            children: [
              jsxs('div', {
                key: 'fields',
                className: 'grid grid-cols-1 gap-2 sm:grid-cols-3',
                children: [
                  jsx('input', {
                    key: 'base',
                    value: baseUrl,
                    placeholder: 'Base URL (https://api.openai.com/v1)',
                    onChange: (event) => setBaseUrl(event.target.value),
                    className:
                      'h-8 rounded-[4px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                  }),
                  jsx('input', {
                    key: 'model',
                    value: model,
                    placeholder: 'Model (gpt-4o-mini)',
                    onChange: (event) => setModel(event.target.value),
                    className:
                      'h-8 rounded-[4px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                  }),
                  jsx('input', {
                    key: 'key',
                    type: 'password',
                    value: apiKey,
                    placeholder: config && config.configured ? 'API key saved' : 'API key',
                    onChange: (event) => setApiKey(event.target.value),
                    className:
                      'h-8 rounded-[4px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                  })
                ]
              }),
              jsxs('div', {
                key: 'actions',
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, {
                    variant: 'secondary',
                    size: 'sm',
                    disabled: saving,
                    onClick: () => void saveSettings(),
                    children: saving ? 'Saving…' : 'Save'
                  }),
                  jsx('span', {
                    className: 'text-[10.5px] text-(--ui-text-tertiary)',
                    children:
                      'OpenAI-compatible endpoint. Only table/column names and your question are sent — no rows.'
                  })
                ]
              })
            ]
          })
        : null,
      error
        ? jsx('div', {
            key: 'err',
            className:
              'rounded-[4px] bg-destructive/10 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive',
            children: error
          })
        : null,
      result
        ? jsxs('div', {
            key: 'result',
            className: 'flex min-h-0 flex-col gap-1.5',
            children: [
              jsxs('div', {
                key: 'meta',
                className: 'flex items-center gap-2 text-[11px] text-(--ui-text-secondary)',
                children: [
                  jsx('span', { key: 'e', children: result.explanation || 'Result' }),
                  jsx('span', {
                    key: 'n',
                    className: 'text-(--ui-text-tertiary)',
                    children: `${result.rows ? result.rows.length : 0} row(s) · ${result.duration_ms || 0} ms`
                  })
                ]
              }),
              jsxs('div', {
                key: 'sqlrow',
                className: 'flex items-start gap-2',
                children: [
                  jsx('pre', {
                    key: 'sql',
                    className:
                      'max-h-24 min-w-0 flex-1 overflow-auto rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[10.5px] whitespace-pre-wrap',
                    children: result.sql
                  }),
                  jsxs('div', {
                    key: 'acts',
                    className: 'flex shrink-0 flex-col gap-1',
                    children: [
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => void writeClipboardText(result.sql),
                        children: 'Copy SQL'
                      }),
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => onUseSql(result.sql),
                        children: 'Open in SQL'
                      })
                    ]
                  })
                ]
              }),
              result.columns && result.rows
                ? jsx('div', {
                    key: 'grid',
                    className:
                      'max-h-64 overflow-auto rounded-[4px] border border-(--ui-stroke-secondary) bg-background',
                    children: jsx('table', {
                      className: 'dbd-grid-table dbd-mono min-w-full',
                      children: [
                        jsx('thead', {
                          key: 'h',
                          children: jsx('tr', {
                            children: result.columns.map((column) =>
                              jsx('th', { children: column.name }, column.name)
                            )
                          })
                        }),
                        jsx('tbody', {
                          key: 'b',
                          children: result.rows.slice(0, 200).map((row, index) =>
                            jsx(
                              'tr',
                              {
                                children: row.map((value, column) =>
                                  jsx(
                                    'td',
                                    {
                                      className: 'px-2 py-1',
                                      children:
                                        value === null || value === undefined
                                          ? jsx('span', {
                                              className: 'text-(--ui-text-tertiary) italic',
                                              children: 'NULL'
                                            })
                                          : typeof value === 'object'
                                            ? JSON.stringify(value)
                                            : String(value)
                                    },
                                    column
                                  )
                                )
                              },
                              index
                            )
                          )
                        })
                      ]
                    })
                  })
                : null
            ]
          })
        : null
    ]
  })
}


export function DbDesk({ onHome, startNew = false, editConnectionId = '' } = {}) {
  const [connections, setConnections] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState(readActive)
  const [tree, setTree] = useState([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('data')
  const [order, setOrder] = useState({ by: '', dir: 'asc' })
  const [filters, setFilters] = useState([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterDraft, setFilterDraft] = useState({ column: '', op: 'contains', value: '', insensitive: true })
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [columnsMeta, setColumnsMeta] = useState([])
  const [sql, setSql] = useState('select * from ')
  const [query, setQuery] = useState(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState(null)
  const [databases, setDatabases] = useState([])
  const [dbVersion, setDbVersion] = useState(0)
  const [dbMap, setDbMap] = useState(readDbMap)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [pending, setPending] = useState(null)
  const [aiOpen, setAiOpen] = useState(false)
  const editHandled = useRef(false)

  useEffect(() => {
    if (editHandled.current || !editConnectionId) return
    const connection = connections.find((item) => item.id === editConnectionId)
    if (!connection) return
    editHandled.current = true
    setActiveId(connection.id)
    writeActive(connection.id)
    setDraft({ ...emptyDraft(), ...connection, password: '' })
  }, [editConnectionId, connections])

  useEffect(() => {
    if (startNew) setDraft(emptyDraft())
    // The standalone launcher remounts the page with a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [selection, setSelection] = useState(null)
  const [queriesOpen, setQueriesOpen] = useState(false)
  const [views, setViews] = useState([])
  const [viewsOpen, setViewsOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [approvals, setApprovals] = useState([])
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [approvalWait, setApprovalWait] = useState(null)
  const [siteInfo, setSiteInfo] = useState(null)
  const [siteLoading, setSiteLoading] = useState(false)
  const [siteVersion, setSiteVersion] = useState(0)
  const [rowDetail, setRowDetail] = useState(null)
  const [hiddenColumns, setHiddenColumns] = useState([])
  const [selectedRows, setSelectedRows] = useState([])
  const [chartOpen, setChartOpen] = useState(false)
  const [chartType, setChartType] = useState('bar')
  const [appended, setAppended] = useState(false)
  const [cellMenu, setCellMenu] = useState(null)
  const [schemaVersion, setSchemaVersion] = useState(0)
  const columnCacheRef = useRef({})
  const [columnCacheVersion, setColumnCacheVersion] = useState(0)
  const [alter, setAlter] = useState(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [indexesOpen, setIndexesOpen] = useState(false)
  const [indexVersion, setIndexVersion] = useState(0)
  const [importData, setImportData] = useState(null)
  const [importNullEmpty, setImportNullEmpty] = useState(true)
  const importFileRef = useRef(null)
  const sqlRef = useRef(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestPrefix, setSuggestPrefix] = useState('')
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [ddl, setDdl] = useState('')
  const [ddlLoading, setDdlLoading] = useState(false)
  const [editor, setEditor] = useState(null)
  const [insertOpen, setInsertOpen] = useState(false)

  const active = connections.find((conn) => conn.id === activeId) || null
  const activeDb = (activeId && dbMap[activeId]) || (active && active.dbname) || ''

  const loadConnections = useCallback(async () => {
    try {
      const result = await call('/connections')
      const list = result.connections || []
      setConnections(list)
      setLoaded(true)
      setActiveId((current) => {
        if (current && list.some((conn) => conn.id === current)) return current
        const next = list.length > 0 ? list[0].id : ''
        writeActive(next)
        return next
      })
    } catch (error) {
      setLoaded(true)
      setErr(errText(error))
    }
  }, [])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      call('/approvals?limit=50')
        .then((result) => {
          if (!cancelled) setApprovals(result.approvals || [])
        })
        .catch(() => {})
    void load()
    const timer = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    call('/views')
      .then((result) => setViews(result.views || []))
      .catch(() => setViews([]))
  }, [])

  useEffect(() => {
    writeActive(activeId)
  }, [activeId])

  useEffect(() => {
    setDatabases([])
    if (!activeId) return
    let cancelled = false
    call(`/connections/${activeId}/databases`)
      .then((result) => {
        if (!cancelled) setDatabases(result.databases || [])
      })
      .catch(() => {
        if (!cancelled) setDatabases([])
      })
    return () => {
      cancelled = true
    }
  }, [activeId, dbVersion])

  useEffect(() => {
    setTree([])
    if (!activeId) return
    let cancelled = false
    setTreeLoading(true)
    setErr('')
    call(`/connections/${activeId}/tree?database=${encodeURIComponent(activeDb)}`)
      .then((result) => {
        if (!cancelled) setTree(result.schemas || [])
      })
      .catch((error) => {
        if (!cancelled) setErr(errText(error))
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId, activeDb, treeVersion])

  useEffect(() => {
    columnCacheRef.current = {}
    setColumnCacheVersion((version) => version + 1)
  }, [activeId, activeDb])

  useEffect(() => {
    if (tab !== 'sql' || !activeId) return undefined
    const references = [...sql.matchAll(/\b(?:from|join|update|into)\s+([A-Za-z_][\w.$]*)/gi)].map(
      (match) => match[1].replace(/["`]/g, '')
    )
    if (references.length === 0) return undefined
    let cancelled = false
    const timer = setTimeout(async () => {
      let fetched = 0
      for (const reference of references) {
        if (fetched >= 5 || cancelled) break
        let schema = selected ? selected.schema : ''
        let table = reference
        if (reference.includes('.')) {
          const parts = reference.split('.')
          schema = parts[0]
          table = parts[1]
        } else {
          const found = tree
            .flatMap((item) => item.tables.map((entry) => ({ schema: item.name, name: entry.name })))
            .find((entry) => entry.name === table)
          if (found) schema = found.schema
        }
        if (!schema || !table) continue
        const key = `${schema}.${table}`
        if (columnCacheRef.current[key]) continue
        try {
          const result = await call(
            `/connections/${activeId}/columns?schema=${encodeURIComponent(
              schema
            )}&table=${encodeURIComponent(table)}&database=${encodeURIComponent(activeDb)}`
          )
          if (cancelled) return
          columnCacheRef.current[key] = (result.columns || []).map((column) => column.name)
          fetched += 1
        } catch {
          /* table may not exist yet */
        }
      }
      if (!cancelled && fetched > 0) setColumnCacheVersion((version) => version + 1)
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sql, tab, activeId, activeDb, tree, selected])

  const loadRows = useCallback(
    async (nextOffset, nextOrder) => {
      if (!activeId || !selected) return
      const ord = nextOrder || order
      setDataLoading(true)
      setSelection(null)
      setSelectedRows([])
      setAppended(false)
      setErr('')
      try {
        const result = await call('/table/rows', {
          method: 'POST',
          body: {
            connection_id: activeId,
            database: activeDb,
            schema: selected.schema,
            table: selected.table,
            limit,
            offset: nextOffset == null ? offset : nextOffset,
            order_by: ord.by,
            order_dir: ord.dir,
            filters
          }
        })
        setData(result)
      } catch (error) {
        setData(null)
        setErr(errText(error))
      } finally {
        setDataLoading(false)
      }
    },
    [activeId, activeDb, selected, limit, offset, order, filters]
  )

  useEffect(() => {
    if (!selected || !activeId) {
      setColumnsMeta([])
      return
    }
    let cancelled = false
    call(
      `/connections/${activeId}/columns?schema=${encodeURIComponent(
        selected.schema
      )}&table=${encodeURIComponent(selected.table)}&database=${encodeURIComponent(activeDb)}`
    )
      .then((result) => {
        if (cancelled) return
        const columns = result.columns || []
        setColumnsMeta(columns)
        const pk = columns.filter((column) => column.pk)
        if (pk.length > 0) setOrder({ by: pk[0].name, dir: 'asc' })
      })
      .catch(() => {
        if (!cancelled) setColumnsMeta([])
      })
    return () => {
      cancelled = true
    }
  }, [activeId, activeDb, selected, schemaVersion])

  useEffect(() => {
    if (!selected || tab !== 'data') return
    void loadRows(offset)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selected, offset, limit, order, tab, filters, schemaVersion])

  const suggestionPool = useMemo(() => {
    const pool = new Set(SQL_KEYWORDS.map((word) => word.toUpperCase()))
    for (const schema of tree) {
      for (const table of schema.tables) pool.add(table.name)
    }
    for (const column of columnsMeta) pool.add(column.name)
    for (const names of Object.values(columnCacheRef.current)) {
      for (const name of names) pool.add(name)
    }
    return [...pool]
  }, [tree, columnsMeta, columnCacheVersion])

  const suggestions = useMemo(() => {
    const query = suggestPrefix.toLowerCase()
    return suggestionPool
      .filter((item) => item.toLowerCase().startsWith(query))
      .slice(0, 8)
  }, [suggestionPool, suggestPrefix])

  const updateSuggestions = (value, caret) => {
    const position = caret == null ? value.length : caret
    const match = /([A-Za-z_][\w$]*)$/.exec(value.slice(0, position))
    const prefix = match ? match[1] : ''
    setSuggestPrefix(prefix)
    setSuggestIndex(0)
    setSuggestOpen(prefix.length >= 2)
  }

  const acceptSuggestion = (value) => {
    const element = sqlRef.current
    const caret = element ? element.selectionStart : sql.length
    const before = sql.slice(0, caret)
    const start = before.replace(/[A-Za-z_][\w$]*$/, '').length
    const next = sql.slice(0, start) + value + sql.slice(caret)
    setSql(next)
    setSuggestOpen(false)
    requestAnimationFrame(() => {
      if (element) {
        element.focus()
        const position = start + value.length
        element.setSelectionRange(position, position)
      }
    })
  }

  const runQuery = useCallback(async () => {
    if (!activeId) return
    setQueryLoading(true)
    setErr('')
    try {
      const result = await call('/query', {
        method: 'POST',
        body: { connection_id: activeId, database: activeDb, sql, limit: 500 }
      })
      setQuery(result)
    } catch (error) {
      setQuery(null)
      setErr(errText(error))
    } finally {
      setQueryLoading(false)
    }
  }, [activeId, activeDb, sql])

  const currentViewState = () => ({ filters, order, limit, offset, hidden: hiddenColumns })

  const applyViewState = (state) => {
    setFilters(Array.isArray(state.filters) ? state.filters : [])
    setOrder(state.order || { by: '', dir: 'asc' })
    setLimit(state.limit || DEFAULT_LIMIT)
    setOffset(state.offset || 0)
    setHiddenColumns(Array.isArray(state.hidden) ? state.hidden : [])
  }

  const previewIndex = async (body, title) => {
    try {
      const preview = await call('/table/index', {
        method: 'POST',
        body: { ...body, preview: true }
      })
      setPending({
        title,
        sql: preview.sql,
        async: false,
        production: Boolean(active && active.production),
        sensitive: Boolean(selected && SENSITIVE_TABLES.has(selected.table)),
        run: async () => {
          const approvalId = await ensureApproval('index', body, preview.sql, title)
          await call('/table/index', {
            method: 'POST',
            body: approvalId ? { ...body, approval_id: approvalId } : body
          })
          setPending(null)
          host.notify({ kind: 'info', message: 'Index updated' })
          setIndexVersion((version) => version + 1)
          setSchemaVersion((version) => version + 1)
        }
      })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const previewAlter = async () => {
    if (!alter || !selected) return
    const action =
      alter.mode === 'add'
        ? 'add_column'
        : alter.mode === 'drop'
          ? 'drop_column'
          : 'rename_column'
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      action,
      name: alter.name,
      new_name: alter.newName,
      type: alter.type,
      default: alter.default,
      nullable: alter.nullable
    }
    try {
      const preview = await call('/table/alter', {
        method: 'POST',
        body: { ...body, preview: true }
      })
      const title =
        alter.mode === 'add'
          ? `Add column ${alter.name}`
          : alter.mode === 'drop'
            ? `Drop column ${alter.name}`
            : `Rename ${alter.name} → ${alter.newName}`
      setPending({
        title,
        sql: preview.sql,
        async: Boolean(preview.async),
        production: Boolean(active && active.production),
        sensitive: SENSITIVE_TABLES.has(selected.table),
        run: async () => {
          const approvalId = await ensureApproval(action, body, preview.sql, title)
          await call('/table/alter', {
            method: 'POST',
            body: approvalId ? { ...body, approval_id: approvalId } : body
          })
          setPending(null)
          setAlter(null)
          host.notify({ kind: 'info', message: 'Schema updated' })
          setSchemaVersion((version) => version + 1)
          setTreeVersion((version) => version + 1)
        }
      })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const openCellMenu = (rowIndex, columnIndex, value, rect) => {
    const column = data && data.columns[columnIndex]
    if (!column) return
    setCellMenu({
      rowIndex,
      columnIndex,
      value,
      rect,
      editable: rowsEditable,
      fk: fkMap[column.name] || null
    })
  }

  const menuCopyValue = async () => {
    if (!cellMenu) return
    await writeClipboardText(cellMenu.value === null ? '' : String(cellMenu.value))
    host.notify({ kind: 'info', message: 'Cell copied' })
  }

  const menuCopyRow = async () => {
    if (!cellMenu || !data) return
    const row = data.rows[cellMenu.rowIndex] || []
    await writeClipboardText(
      data.columns.map((column, index) => `${column.name}=${row[index] === null ? '' : row[index]}`).join('\t')
    )
    host.notify({ kind: 'info', message: 'Row copied' })
  }

  const openTab = (schema, table, state) => {
    const id = `${schema}.${table}`
    let next = tabs.map((tab) =>
      tab.id === activeTabId ? { ...tab, state: currentViewState() } : tab
    )
    const existing = next.find((tab) => tab.id === id)
    if (!existing) {
      next = [
        ...next,
        {
          id,
          schema,
          table,
          state: state || {
            filters: [],
            order: { by: '', dir: 'asc' },
            limit: DEFAULT_LIMIT,
            offset: 0,
            hidden: []
          }
        }
      ]
    } else if (state) {
      next = next.map((tab) => (tab.id === id ? { ...tab, state } : tab))
    }
    const target = next.find((tab) => tab.id === id)
    setTabs(next)
    setActiveTabId(id)
    setSelected({ schema: target.schema, table: target.table })
    applyViewState(target.state)
    setFilterDraft({ column: '', op: 'contains', value: '', insensitive: true })
    setSelection(null)
    setEditor(null)
    setInsertOpen(false)
    setTreeOpen(false)
    setTab('data')
  }

  const switchTab = (id) => {
    if (id === activeTabId) return
    const next = tabs.map((tab) =>
      tab.id === activeTabId ? { ...tab, state: currentViewState() } : tab
    )
    const target = next.find((tab) => tab.id === id)
    if (!target) return
    setTabs(next)
    setActiveTabId(id)
    setSelected({ schema: target.schema, table: target.table })
    applyViewState(target.state)
    setSelection(null)
    setEditor(null)
    setInsertOpen(false)
    setTab('data')
  }

  const closeTab = (id) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const closingActive = id === activeTabId
    let next = tabs
      .filter((tab) => tab.id !== id)
      .map((tab) =>
        tab.id === activeTabId && !closingActive ? { ...tab, state: currentViewState() } : tab
      )
    setTabs(next)
    if (!closingActive) return
    const fallback = next[Math.max(0, index - 1)]
    if (fallback) {
      setActiveTabId(fallback.id)
      setSelected({ schema: fallback.schema, table: fallback.table })
      applyViewState(fallback.state)
    } else {
      setActiveTabId(null)
      setSelected(null)
      setData(null)
      setColumnsMeta([])
      setDdl('')
      setSelection(null)
    }
  }

  const followFk = (fk, value) => {
    openTab(fk.schema, fk.table, {
      filters: [{ column: fk.column, op: 'eq', value }],
      order: { by: '', dir: 'asc' },
      limit: DEFAULT_LIMIT,
      offset: 0
    })
  }

  const pickTable = (schema, table) => {
    openTab(schema, table)
  }

  const pickDb = (database) => {
    setTreeOpen(false)
    const next = { ...dbMap, [activeId]: database }
    setDbMap(next)
    writeDbMap(next)
    setSelected(null)
    setData(null)
    setDdl('')
    setTabs([])
    setActiveTabId(null)
    setTreeVersion((v) => v + 1)
  }

  const deleteSelected = async () => {
    if (!selected || !data || selectedRows.length === 0) return
    const pks = selectedRows
      .map((index) => pkValuesFor(index))
      .filter((pk) => Object.keys(pk).length > 0)
    if (pks.length === 0) {
      setErr('Selected rows have no primary key.')
      return
    }
    if (pks.length > 500) {
      setErr('Too many rows selected (500 max per bulk delete).')
      return
    }
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      pks
    }
    try {
      const preview = await call('/rows/delete_bulk', {
        method: 'POST',
        body: { ...body, preview: true }
      })
      armMutation('/rows/delete_bulk', body, preview, {
        title: `Delete ${pks.length} rows from ${selected.schema}.${selected.table}`,
        action: 'delete_bulk',
        table: selected.table,
        done: `Deleted ${pks.length} rows`,
        after: async () => {
          setSelectedRows([])
          await loadRows(offset)
        }
      })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const loadMore = async () => {
    if (!data || !selected || !activeId) return
    setDataLoading(true)
    setErr('')
    try {
      const result = await call('/table/rows', {
        method: 'POST',
        body: {
          connection_id: activeId,
          database: activeDb,
          schema: selected.schema,
          table: selected.table,
          limit,
          offset: data.rows.length,
          order_by: order.by,
          order_dir: order.dir,
          filters
        }
      })
      setData({
        ...result,
        rows: [...data.rows, ...result.rows],
        offset: 0,
        limit: data.rows.length + result.rows.length
      })
      setAppended(true)
    } catch (error) {
      setErr(errText(error))
    } finally {
      setDataLoading(false)
    }
  }

  useEffect(() => {
    if (tab !== 'site' || !activeId) return undefined
    let cancelled = false
    setSiteLoading(true)
    setSiteInfo(null)
    setErr('')
    call(`/connections/${activeId}/wp-info?database=${encodeURIComponent(activeDb)}`)
      .then((result) => {
        if (!cancelled) setSiteInfo(result)
      })
      .catch((error) => {
        if (!cancelled) setErr(errText(error))
      })
      .finally(() => {
        if (!cancelled) setSiteLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, activeId, activeDb, siteVersion])

  useEffect(() => {
    if (tab !== 'schema' || !selected || !activeId) return
    let cancelled = false
    setDdlLoading(true)
    setDdl('')
    call(
      `/connections/${activeId}/ddl?schema=${encodeURIComponent(
        selected.schema
      )}&table=${encodeURIComponent(selected.table)}&database=${encodeURIComponent(activeDb)}`
    )
      .then((result) => {
        if (!cancelled) setDdl(result.ddl || '')
      })
      .catch((error) => {
        if (!cancelled) setErr(errText(error))
      })
      .finally(() => {
        if (!cancelled) setDdlLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, selected, activeId, activeDb, treeVersion, schemaVersion])

  const sortBy = (column) => {
    setOffset(0)
    setOrder((current) =>
      current.by === column
        ? { by: column, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { by: column, dir: 'asc' }
    )
  }

  const pkColumns = useMemo(() => columnsMeta.filter((column) => column.pk), [columnsMeta])
  const fkMap = useMemo(
    () => Object.fromEntries(columnsMeta.filter((column) => column.fk).map((column) => [column.name, column.fk])),
    [columnsMeta]
  )
  const rowsEditable = Boolean(active && !active.readonly && selected && data && pkColumns.length > 0)
  const canInsert = Boolean(active && !active.readonly && selected && columnsMeta.length > 0)

  const pkValuesFor = (rowIndex) => {
    const values = {}
    if (!data) return values
    for (const column of pkColumns) {
      const index = data.columns.findIndex((col) => col.name === column.name)
      if (index !== -1) values[column.name] = data.rows[rowIndex][index]
    }
    return values
  }

  const editCell = (rowIndex, columnIndex, value, rect) => {
    const source = data && data.columns[columnIndex]
    const meta = columnsMeta.find((column) => column.name === (source && source.name))
    if (!meta) return
    setEditor({
      rowIndex,
      columnIndex,
      value,
      rect,
      column: meta
    })
  }

  const previewMutation = (path, body) =>
    call(path, { method: 'POST', body: { ...body, preview: true } })

  const decideApproval = async (id, decision) => {
    try {
      await call(`/approvals/${id}/decision`, {
        method: 'POST',
        body: { decision }
      })
      const result = await call('/approvals?limit=50')
      setApprovals(result.approvals || [])
    } catch (error) {
      setErr(errText(error))
    }
  }

  const ensureApproval = async (action, body, sql, title) => {
    if (!active || !active.production) return ''
    const result = await call('/approvals', {
      method: 'POST',
      body: {
        connection_id: activeId,
        database: activeDb,
        schema: selected ? selected.schema : '',
        table: selected ? selected.table : '',
        action,
        sql
      }
    })
    const entry = result.approval
    setApprovalWait({ id: entry.id, title, sql })
    try {
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const listed = await call('/approvals?limit=100')
        setApprovals(listed.approvals || [])
        const current = (listed.approvals || []).find((item) => item.id === entry.id)
        if (current && current.status === 'approved') {
          setApprovalWait(null)
          return entry.id
        }
        if (current && current.status === 'denied') {
          setApprovalWait(null)
          throw new Error('Approval denied')
        }
      }
      setApprovalWait(null)
      throw new Error('Approval timed out')
    } catch (error) {
      setApprovalWait(null)
      throw error
    }
  }

  const armMutation = (path, body, preview, meta) => {
    setPending({
      title: meta.title,
      sql: preview.sql,
      async: Boolean(preview.async),
      production: Boolean(active && active.production),
      sensitive: SENSITIVE_TABLES.has(meta.table),
      run: async () => {
        const approvalId = await ensureApproval(
          meta.action || 'write',
          body,
          preview.sql,
          meta.title
        )
        const result = await call(path, {
          method: 'POST',
          body: approvalId ? { ...body, approval_id: approvalId } : body
        })
        setPending(null)
        if (meta.close) meta.close()
        host.notify({
          kind: 'info',
          message: result.async ? `${meta.done} queued (ClickHouse mutation)` : meta.done
        })
        if (result.async) await new Promise((resolve) => setTimeout(resolve, 1200))
        await meta.after()
      }
    })
  }

  const saveEdit = async (nextValue) => {
    if (!editor || !selected || !data) return
    const pk = pkValuesFor(editor.rowIndex)
    if (Object.keys(pk).length === 0) {
      throw new Error('This table has no primary key — edit it from the SQL tab.')
    }
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      pk,
      changes: { [editor.column.name]: nextValue }
    }
    const preview = await previewMutation('/rows/update', body)
    setEditor(null)
    armMutation('/rows/update', body, preview, {
      title: `Update ${selected.schema}.${selected.table}`,
      action: 'update',
      table: selected.table,
      done: `Saved ${editor.column.name}`,
      after: () => loadRows(offset)
    })
  }

  const deleteRow = async (rowIndex) => {
    if (!selected || !data) return
    const pk = pkValuesFor(rowIndex)
    if (Object.keys(pk).length === 0) {
      host.notify({ kind: 'error', message: 'This table has no primary key — delete rows from SQL.' })
      return
    }
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      pk
    }
    try {
      const preview = await previewMutation('/rows/delete', body)
      armMutation('/rows/delete', body, preview, {
        title: `Delete from ${selected.schema}.${selected.table}`,
        action: 'delete',
        table: selected.table,
        done: 'Row deleted',
        after: () => loadRows(offset)
      })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const insertRow = async (values) => {
    if (!selected) return
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      values
    }
    const preview = await previewMutation('/rows/insert', body)
    armMutation('/rows/insert', body, preview, {
      title: `Insert into ${selected.schema}.${selected.table}`,
      action: 'insert',
      table: selected.table,
      done: 'Row inserted',
      close: () => setInsertOpen(false),
      after: async () => {
        setOffset(0)
        await loadRows(0)
      }
    })
  }

  const selectCell = (rowIndex, columnIndex, extend) => {
    setSelection((current) =>
      extend && current
        ? { ...current, r1: rowIndex, c1: columnIndex }
        : { r0: rowIndex, c0: columnIndex, r1: rowIndex, c1: columnIndex }
    )
  }

  const selectRow = (rowIndex, extend) => {
    const width = tab === 'data' ? (data ? data.columns.length : 0) : query ? query.columns.length : 0
    if (width === 0) return
    setSelection((current) =>
      extend && current
        ? { ...current, r1: rowIndex, c1: width - 1 }
        : { r0: rowIndex, c0: 0, r1: rowIndex, c1: width - 1 }
    )
  }

  const copySelection = useCallback(
    async (format) => {
      if (!selection && selectedRows.length === 0) return
      const grid = tab === 'data' ? data : query
      if (!grid || !grid.columns.length) return
      const useChecked = selectedRows.length > 0
      const r0 = selection ? Math.min(selection.r0, selection.r1) : 0
      const r1 = selection ? Math.max(selection.r0, selection.r1) : 0
      const c0 = selection ? Math.min(selection.c0, selection.c1) : 0
      const c1 = selection ? Math.max(selection.c0, selection.c1) : 0
      const columns = useChecked ? grid.columns : grid.columns.slice(c0, c1 + 1)
      const rows = useChecked
        ? selectedRows.filter((index) => index < grid.rows.length).map((index) => grid.rows[index])
        : grid.rows.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1))
      const single = rows.length === 1 && columns.length === 1

      const quote = (value) => {
        if (value === null || value === undefined) return ''
        const text = String(value)
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }
      const tsvValue = (value) =>
        value === null || value === undefined ? '' : String(value).replace(/[\t\n\r]+/g, ' ')

      let text = ''
      if (format === 'csv') {
        text = [columns.map((column) => quote(column.name)).join(',')]
          .concat(rows.map((row) => row.map(quote).join(',')))
          .join('\n')
      } else if (format === 'json') {
        text = JSON.stringify(
          rows.map((row) =>
            Object.fromEntries(columns.map((column, index) => [column.name, row[index]]))
          ),
          null,
          2
        )
      } else if (format === 'insert') {
        const kind = (active && active.kind) || 'postgres'
        const qi = (name) => (kind === 'mysql' ? `\`${name}\`` : `"${name}"`)
        const ql = (value) => {
          if (value === null || value === undefined) return 'NULL'
          let body = String(value)
          if (kind !== 'postgres') body = body.replace(/\\/g, '\\\\')
          return `'${body.replace(/'/g, "''")}'`
        }
        const table = `${qi(selected.schema)}.${qi(selected.table)}`
        text = rows
          .map(
            (row) =>
              `INSERT INTO ${table} (${columns.map((column) => qi(column.name)).join(', ')}) VALUES (${row
                .map(ql)
                .join(', ')});`
          )
          .join('\n')
      } else {
        const lines = rows.map((row) => row.map(tsvValue).join('\t'))
        if (!single) lines.unshift(columns.map((column) => tsvValue(column.name)).join('\t'))
        text = lines.join('\n')
      }

      await writeClipboardText(text)
      host.notify({
        kind: 'info',
        message: `Copied ${rows.length}×${columns.length} cell${single ? '' : 's'} as ${
          format === 'tsv' ? 'TSV' : format.toUpperCase()
        }`
      })
    },
    [selection, selectedRows, tab, data, query, active, selected]
  )

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') return
      const tag = (document.activeElement && document.activeElement.tagName) || ''
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (window.getSelection && String(window.getSelection())) return
      if (!selection) return
      event.preventDefault()
      void copySelection('tsv')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, copySelection])

  const toggleColumn = (name) => {
    setHiddenColumns((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    )
  }

  const toggleRow = (index) => {
    setSelectedRows((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index]
    )
  }

  const toggleAllRows = () => {
    if (!data) return
    setSelectedRows((current) =>
      current.length === data.rows.length
        ? []
        : data.rows.map((_, index) => index)
    )
  }

  const addFilter = () => {
    const column = filterDraft.column || (columnsMeta[0] && columnsMeta[0].name) || ''
    if (!column) return
    const nullable = ['isnull', 'notnull'].includes(filterDraft.op)
    if (!nullable && filterDraft.value === '') return
    setFilters((current) => [...current, { ...filterDraft, column }])
    setFilterDraft((current) => ({ ...current, column, value: '' }))
    setOffset(0)
  }

  const removeFilter = (index) => {
    setFilters((current) => current.filter((_, i) => i !== index))
    setOffset(0)
  }

  const opLabel = (op) =>
    ({
      contains: 'contains',
      eq: '=',
      neq: '≠',
      gt: '>',
      lt: '<',
      gte: '≥',
      lte: '≤',
      isnull: 'is null',
      notnull: 'is not null'
    })[op] || op

  const tableViews = useMemo(() => {
    if (!selected) return []
    return views.filter(
      (view) =>
        view.connection_id === activeId &&
        view.database === activeDb &&
        view.schema === selected.schema &&
        view.table === selected.table
    )
  }, [views, activeId, activeDb, selected])

  const applyView = (view) => {
    setFilters(Array.isArray(view.filters) ? view.filters : [])
    setOrder({ by: view.order_by || '', dir: view.order_dir === 'desc' ? 'desc' : 'asc' })
    setLimit(view.limit || DEFAULT_LIMIT)
    setOffset(0)
    setViewsOpen(false)
  }

  const saveView = async (name) => {
    if (!selected) return
    await call('/views', {
      method: 'POST',
      body: {
        name,
        connection_id: activeId,
        database: activeDb,
        schema: selected.schema,
        table: selected.table,
        filters,
        order_by: order.by,
        order_dir: order.dir,
        limit
      }
    })
    const result = await call('/views')
    setViews(result.views || [])
    host.notify({ kind: 'info', message: `View “${name}” saved` })
  }

  const deleteView = async (id) => {
    await call(`/views/${id}`, { method: 'DELETE' })
    const result = await call('/views')
    setViews(result.views || [])
  }

  const onImportFile = async (event) => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    setErr('')
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.length < 2) throw new Error('CSV needs a header and at least one data row')
      const columns = parsed[0].map((cell) => cell.trim())
      const known = new Set(columnsMeta.map((column) => column.name))
      const unknown = columns.filter((column) => !known.has(column))
      if (unknown.length) throw new Error(`Unknown column(s): ${unknown.join(', ')}`)
      const rows = parsed
        .slice(1)
        .filter((row) => row.some((value) => String(value).trim() !== ''))
        .map((row) => columns.map((_, index) => (row[index] === undefined ? '' : row[index])))
      if (rows.length === 0) throw new Error('CSV has no data rows')
      if (rows.length > 5000) throw new Error('CSV has more than 5000 rows')
      setImportData({ filename: file.name, columns, rows })
      setImportOpen(true)
    } catch (error) {
      setErr(errText(error))
    }
  }

  const runImport = async () => {
    if (!importData || !selected) return
    const rows = importData.rows.map((row) =>
      row.map((value) => (importNullEmpty && value === '' ? null : value))
    )
    const body = {
      connection_id: activeId,
      database: activeDb,
      schema: selected.schema,
      table: selected.table,
      columns: importData.columns,
      rows
    }
    const preview = await call('/rows/import', {
      method: 'POST',
      body: { ...body, preview: true }
    })
    setPending({
      title: `Import ${rows.length} rows into ${selected.schema}.${selected.table}`,
      sql: preview.sql,
      async: false,
      production: Boolean(active && active.production),
      sensitive: SENSITIVE_TABLES.has(selected.table),
      run: async () => {
        const approvalId = await ensureApproval('import', body, preview.sql, `Import into ${selected.schema}.${selected.table}`)
        const result = await call('/rows/import', {
          method: 'POST',
          body: approvalId ? { ...body, approval_id: approvalId } : body
        })
        setPending(null)
        setImportOpen(false)
        setImportData(null)
        host.notify({ kind: 'info', message: `Imported ${result.rows} rows` })
        await loadRows(offset)
      }
    })
  }

  const exportTable = async () => {
    if (!selected || !activeId) return
    setExporting(true)
    setErr('')
    try {
      const params = new URLSearchParams({
        schema: selected.schema,
        table: selected.table,
        database: activeDb,
        limit: '50000'
      })
      const result = await call(`/connections/${activeId}/table/csv?${params.toString()}`)
      downloadCsv(result.filename || `${selected.table}.csv`, result.csv)
      host.notify({
        kind: 'info',
        message: result.truncated
          ? `Exported first ${result.rows} rows (50k cap)`
          : `Exported ${result.rows} rows`
      })
    } catch (error) {
      setErr(errText(error))
    } finally {
      setExporting(false)
    }
  }

  const groupedConnections = useMemo(() => {
    const map = new Map()
    for (const conn of connections) {
      const group = (conn.group || '').trim() || 'Ungrouped'
      if (!map.has(group)) map.set(group, [])
      map.get(group).push(conn)
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === 'Ungrouped') return 1
      if (b[0] === 'Ungrouped') return -1
      return a[0].localeCompare(b[0])
    })
  }, [connections])

  const allTables = useMemo(
    () =>
      tree.flatMap((schema) =>
        schema.tables.map((table) => ({ schema: schema.name, name: table.name }))
      ),
    [tree]
  )

  const filteredTree = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return tree
    return tree
      .map((schema) => ({
        ...schema,
        tables: schema.tables.filter(
          (table) =>
            table.name.toLowerCase().includes(needle) || schema.name.toLowerCase().includes(needle)
        )
      }))
      .filter((schema) => schema.tables.length > 0)
  }, [tree, filter])

  const onSaved = async (connection) => {
    setDraft(null)
    await loadConnections()
    setActiveId(connection.id)
    setTreeVersion((v) => v + 1)
    host.notify({ kind: 'info', message: `Saved connection “${connection.name}”` })
  }

  const onDeleted = async (id) => {
    setDraft(null)
    if (selected) setSelected(null)
    await loadConnections()
    if (activeId === id) setActiveId('')
  }

  const editActive = () => {
    if (!active) {
      setDraft(emptyDraft())
      return
    }
    setDraft({ ...emptyDraft(), ...active, password: '' })
  }

  return jsxs('div', {
    className: 'dbd-app relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground',
    children: [
      jsxs('header', {
        key: 'header',
        className: 'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-3 py-2',
        children: [
          jsx(Button, {
            key: 'menu',
            variant: 'ghost',
            size: 'icon-xs',
            className: 'dbd-tree-toggle',
            title: 'Tables',
            onClick: () => setTreeOpen(true),
            children: jsx(Codicon, { name: 'menu' })
          }),
          onHome
            ? jsx(Button, {
                key: 'home',
                variant: 'ghost',
                size: 'sm',
                title: 'All connections',
                onClick: onHome,
                children: jsx(Codicon, { name: 'chevron-left' })
              })
            : null,
          jsx(Codicon, { key: 'i', name: 'database', className: 'hidden shrink-0 text-(--ui-text-secondary) sm:block' }),
          jsx('div', {
            key: 't',
            className: 'dbd-sm-block shrink-0 text-sm font-semibold whitespace-nowrap',
            children: 'DB Desk'
          }),
          active
            ? jsxs('div', {
                key: 'a',
                className: 'flex min-w-0 flex-1 items-center gap-2 text-[11px] text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { key: 'n', className: 'min-w-0 truncate', children: active.name }),
                  jsx(Badge, {
                    key: 'kind',
                    variant: 'muted',
                    size: 'xs',
                    className: 'dbd-sm-hide',
                    children:
                      {
                        postgres: 'PG',
                        mysql: 'MySQL',
                        clickhouse: 'CH',
                        sqlite: 'SQLite',
                        mcp: 'MCP',
                        http: 'HTTP'
                      }[active.kind || 'postgres'] || 'PG'
                  }),
                  jsx('span', {
                    key: 'h',
                    className: 'hidden min-w-0 truncate font-mono opacity-80 lg:inline',
                    children:
                      (active.kind || 'postgres') === 'sqlite'
                        ? active.dbname
                        : `${active.user}@${active.host}:${active.port}/${active.dbname}`
                  }),
                  active.ssh_host
                    ? jsx(Badge, {
                        key: 'ssh',
                        variant: 'muted',
                        size: 'xs',
                        className: 'dbd-sm-hide',
                        children: 'SSH'
                      })
                    : null,
                  active.production
                    ? jsx(Badge, {
                        key: 'prod',
                        variant: 'destructive',
                        size: 'xs',
                        className: 'dbd-sm-hide',
                        children: 'PROD'
                      })
                    : null,
                  active.readonly
                    ? jsx(Badge, {
                        key: 'ro',
                        variant: 'outline',
                        size: 'xs',
                        className: 'dbd-sm-hide',
                        children: 'read-only'
                      })
                    : jsx(Badge, {
                        key: 'rw',
                        variant: 'warn',
                        size: 'xs',
                        className: 'dbd-sm-hide',
                        children: 'writes allowed'
                      })
                ]
              })
            : null,
          jsx('div', { key: 'sp', className: 'flex-1' }),
          jsx(Button, {
            key: 'ai',
            variant: aiOpen ? 'secondary' : 'ghost',
            size: 'sm',
            title: 'Ask AI (read-only)',
            onClick: () => {
              setTab('data')
              setAiOpen((open) => !open)
            },
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'sparkle' }),
                jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'AI' })
              ]
            })
          }),
          jsx(Button, {
            key: 'refresh',
            variant: 'secondary',
            size: 'sm',
            title: 'Refresh',
            onClick: () => setTreeVersion((v) => v + 1),
            disabled: !activeId || treeLoading,
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'refresh' }),
                jsx('span', {
                  key: 't',
                  className: 'dbd-sm-inline',
                  children: treeLoading ? 'Loading…' : 'Refresh'
                })
              ]
            })
          }),
          jsx(Button, {
            key: 'approvals',
            variant: 'ghost',
            size: 'sm',
            title: 'Approvals',
            onClick: () => setApprovalsOpen(true),
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'shield' }),
                jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'Approvals' }),
                approvals.filter((entry) => entry.status === 'pending').length
                  ? jsx('span', {
                      key: 'n',
                      className: 'tabular-nums',
                      children: approvals.filter((entry) => entry.status === 'pending').length
                    })
                  : null
              ]
            })
          }),
          jsx(Button, {
            key: 'audit',
            variant: 'ghost',
            size: 'sm',
            title: 'Audit log',
            onClick: () => setAuditOpen(true),
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'checklist' }),
                jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'Audit' })
              ]
            })
          }),
          jsx(Button, {
            key: 'activity',
            variant: 'ghost',
            size: 'sm',
            title: 'Activity',
            disabled: !activeId,
            onClick: () => setActivityOpen(true),
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'pulse' }),
                jsx('span', { key: 't', className: 'dbd-sm-inline', children: 'Activity' })
              ]
            })
          }),
          jsx(Button, {
            key: 'edit',
            variant: 'secondary',
            size: 'sm',
            title: active ? 'Connection' : 'New connection',
            onClick: editActive,
            children: jsxs('span', {
              className: 'flex items-center gap-1',
              children: [
                jsx(Codicon, { key: 'i', name: 'gear' }),
                jsx('span', {
                  key: 't',
                  className: 'dbd-sm-inline',
                  children: active ? 'Connection' : 'New connection'
                })
              ]
            })
          })
        ]
      }),
      err
        ? jsxs('div', {
            key: 'err',
            className: 'flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive',
            children: [
              jsx('span', { key: 'm', className: 'flex-1', children: err }),
              jsx('button', {
                key: 'x',
                type: 'button',
                className: 'shrink-0 opacity-70 hover:opacity-100',
                onClick: () => setErr(''),
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          })
        : null,
      jsxs('div', {
        key: 'body',
        className: 'relative flex min-h-0 flex-1',
        children: [
          treeOpen
            ? jsx('button', {
                key: 'tree-backdrop',
                type: 'button',
                'aria-label': 'Close tables',
                className: 'dbd-backdrop',
                onClick: () => setTreeOpen(false)
              })
            : null,
          jsxs('aside', {
            key: 'side',
            'data-open': treeOpen ? 'true' : 'false',
            className:
              'dbd-sidebar flex shrink-0 flex-col border-r border-(--ui-stroke-secondary) bg-(--ui-bg-sidebar) shadow-xl',
            children: [
              jsxs('div', {
                key: 'conns',
                className: 'flex flex-col gap-0.5 border-b border-(--ui-stroke-secondary) p-1.5',
                children: [
                  jsxs('div', {
                    key: 'h',
                    className: 'flex items-center justify-between px-1 py-0.5',
                    children: [
                      jsx('span', {
                        className: 'text-[10px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase',
                        children: 'Connections'
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)',
                        title: 'New connection',
                        onClick: () => setDraft(emptyDraft()),
                        children: jsx(Codicon, { name: 'add' })
                      })
                    ]
                  }),
                  ...(connections.length === 0 && loaded
                    ? [
                        jsx('div', {
                          key: 'none',
                          className: 'px-1 py-1 text-[11px] text-(--ui-text-tertiary)',
                          children: 'No connections yet.'
                        })
                      ]
                    : []),
                  ...groupedConnections.flatMap(([group, list]) => [
                    groupedConnections.length > 1 || group !== 'Ungrouped'
                      ? jsx(
                          'div',
                          {
                            className:
                              'px-1 pt-1 text-[9.5px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase',
                            children: group
                          },
                          `g:${group}`
                        )
                      : null,
                    ...list.map((conn) =>
                      jsx(
                        'button',
                        {
                          type: 'button',
                          className: cn(
                            'flex w-full items-center gap-1.5 rounded-[3px] border-l-2 border-transparent px-1.5 py-1 text-left text-[11.5px]',
                            conn.id === activeId
                              ? 'border-primary bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                              : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
                          ),
                          onClick: () => {
                            setActiveId(conn.id)
                            setSelected(null)
                            setData(null)
                            setEditor(null)
                            setInsertOpen(false)
                            setTreeOpen(false)
                            setTabs([])
                            setActiveTabId(null)
                            setSelection(null)
                          },
                          children: [
                            jsx(Codicon, {
                              key: 'd',
                              name: 'database',
                              className: 'shrink-0 opacity-70'
                            }),
                            jsxs('span', {
                              key: 'n',
                              className: 'flex min-w-0 flex-1 flex-col',
                              children: [
                                jsx('span', { className: 'truncate', children: conn.name }),
                                jsx('span', {
                                  className: 'truncate font-mono text-[10px] text-(--ui-text-tertiary)',
                                  children: conn.dbname
                                })
                              ]
                            })
                          ]
                        },
                        conn.id
                      )
                    )
                  ]),
                ]
              }),
              databases.length > 1
                ? jsxs('div', {
                    key: 'db',
                    className:
                      'flex items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                    children: [
                      jsx('span', {
                        className:
                          'text-[10px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase',
                        children: 'DB'
                      }),
                      jsx('select', {
                        value: activeDb,
                        title: 'Active database',
                        onChange: (event) => pickDb(event.target.value),
                        className:
                          'h-6 min-w-0 flex-1 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1 font-mono text-[10.5px] outline-none',
                        children: databases.map((db) =>
                          jsx(
                            'option',
                            {
                              value: db.name,
                              children: db.label ? `${db.label} — ${db.name}` : db.name
                            },
                            db.name
                          )
                        )
                      }),
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'icon-xs',
                        title: 'Database labels',
                        onClick: () => setLabelsOpen(true),
                        children: jsx(Codicon, { name: 'tag' })
                      })
                    ]
                  })
                : null,
              jsx('div', {
                key: 'search',
                className: 'p-1.5',
                children: jsx(Input, {
                  value: filter,
                  placeholder: 'Filter tables…',
                  onChange: (event) => setFilter(event.target.value)
                })
              }),
              jsxs('div', {
                key: 'tree',
                className: 'min-h-0 flex-1 overflow-auto pb-2',
                children: [
                  ...(treeLoading
                    ? [
                        jsx('div', {
                          key: 'loading',
                          className: 'px-2 py-1 text-[11px] text-(--ui-text-tertiary)',
                          children: 'Loading schema…'
                        })
                      ]
                    : []),
                  ...(active && !treeLoading && filteredTree.length === 0
                    ? [
                        jsx('div', {
                          key: 'empty',
                          className: 'px-2 py-1 text-[11px] text-(--ui-text-tertiary)',
                          children: filter ? 'No matching tables.' : 'No tables.'
                        })
                      ]
                    : []),
                  ...filteredTree.map((schema) => {
                    const isCollapsed = Boolean(collapsed[schema.name])
                    return jsxs(
                      'div',
                      {
                        key: schema.name,
                        children: [
                          jsxs('button', {
                            type: 'button',
                            className: 'flex w-full items-center gap-1 px-1.5 py-1 text-left text-[11px] font-semibold text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                            onClick: () =>
                              setCollapsed((current) => ({
                                ...current,
                                [schema.name]: !current[schema.name]
                              })),
                            children: [
                              jsx(Codicon, {
                                key: 'c',
                                name: isCollapsed ? 'chevron-right' : 'chevron-down',
                                className: 'opacity-70'
                              }),
                              jsx('span', { key: 'n', className: 'truncate', children: schema.name }),
                              jsx('span', {
                                key: 'k',
                                className: 'ml-auto font-normal text-(--ui-text-tertiary)',
                                children: schema.tables.length
                              })
                            ]
                          }),
                          ...(isCollapsed
                            ? []
                            : schema.tables.map((table) =>
                                jsxs(
                                  'button',
                                  {
                                    type: 'button',
                                    className: cn(
                                      'flex w-full items-center gap-1.5 py-1 pr-2 pl-6 text-left text-[11.5px]',
                                      selected &&
                                        selected.schema === schema.name &&
                                        selected.table === table.name
                                        ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                                        : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
                                    ),
                                    title: `${schema.name}.${table.name} · ~${table.est_rows} rows`,
                                    onClick: () => pickTable(schema.name, table.name),
                                    children: [
                                      jsx(Codicon, {
                                        key: 'i',
                                        name:
                                          table.kind === 'view'
                                            ? 'eye'
                                            : table.kind === 'materialized view'
                                              ? 'layers'
                                              : 'table',
                                        className: 'shrink-0 opacity-60'
                                      }),
                                      jsx('span', {
                                        key: 'n',
                                        className: 'truncate',
                                        children: table.name
                                      })
                                    ]
                                  },
                                  table.name
                                )
                              ))
                        ]
                      },
                      schema.name
                    )
                  })
                ]
              })
            ]
          }),
          jsxs('main', {
            key: 'main',
            className: 'flex min-h-0 min-w-0 flex-1 flex-col',
            children: [
              tabs.length > 0
                ? jsx('div', {
                    key: 'tables',
                    className:
                      'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--ui-stroke-secondary) px-2 py-1',
                    children: tabs.map((tab) =>
                      jsxs(
                        'div',
                        {
                          className: cn(
                            'flex shrink-0 items-center gap-0.5 rounded-[3px] border px-1.5 py-0.5 text-[11px]',
                            tab.id === activeTabId
                              ? 'border-primary/40 bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                              : 'border-(--ui-stroke-secondary)/60 text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                          ),
                          children: [
                            jsx('button', {
                              type: 'button',
                              className: 'max-w-[150px] truncate',
                              title: tab.id,
                              onClick: () => switchTab(tab.id),
                              children: tab.table
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'rounded-[2px] p-0.5 opacity-60 hover:opacity-100',
                              title: 'Close tab',
                              onClick: (event) => {
                                event.stopPropagation()
                                closeTab(tab.id)
                              },
                              children: jsx(Codicon, { name: 'close' })
                            })
                          ]
                        },
                        tab.id
                      )
                    )
                  })
                : null,
              jsxs('div', {
                key: 'tabs',
                className:
                  'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--ui-stroke-secondary) px-2',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      '-mb-px border-b-2 px-2 py-1.5 text-[11.5px]',
                      tab === 'data'
                        ? 'border-primary text-(--ui-text-primary)'
                        : 'border-transparent text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                    ),
                    onClick: () => setTab('data'),
                    children: 'Data'
                  }),
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      '-mb-px border-b-2 px-2 py-1.5 text-[11.5px]',
                      tab === 'sql'
                        ? 'border-primary text-(--ui-text-primary)'
                        : 'border-transparent text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                    ),
                    onClick: () => setTab('sql'),
                    children: 'SQL'
                  }),
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      '-mb-px border-b-2 px-2 py-1.5 text-[11.5px]',
                      tab === 'schema'
                        ? 'border-primary text-(--ui-text-primary)'
                        : 'border-transparent text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                    ),
                    onClick: () => setTab('schema'),
                    children: 'Schema'
                  }),
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      '-mb-px border-2 border-transparent border-b-2 px-2 py-1.5 text-[11.5px]',
                      tab === 'site'
                        ? 'border-b-primary text-(--ui-text-primary)'
                        : 'text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                    ),
                    onClick: () => setTab('site'),
                    children: 'Site'
                  }),
                  jsx('div', { className: 'flex-1' }),
                  selected
                    ? jsx('span', {
                        className: 'truncate pr-1 font-mono text-[11px] text-(--ui-text-tertiary)',
                        children: `${selected.schema}.${selected.table}`
                      })
                    : null
                ]
              }),
              tab === 'data'
                ? jsxs('div', {
                    key: 'data',
                    className: 'flex min-h-0 flex-1 flex-col',
                    children: [
                      jsxs('div', {
                        key: 'bar',
                        className: cn(
                          'shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-2',
                          selected ? 'flex' : 'hidden'
                        ),
                        children: [
                          jsx(Button, {
                            variant: 'secondary',
                            size: 'sm',
                            onClick: () => void loadRows(offset),
                            disabled: !selected || dataLoading,
                            children: dataLoading ? 'Loading…' : 'Run'
                          }),
                          jsxs('label', {
                            className: 'flex items-center gap-1 text-[11px] text-(--ui-text-tertiary)',
                            children: [
                              'Limit',
                              jsx('select', {
                                className: 'h-7 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                value: limit,
                                onChange: (event) => {
                                  setOffset(0)
                                  setLimit(Number(event.target.value))
                                },
                                children: [50, 100, 250, 500].map((n) =>
                                  jsx('option', { value: n, children: n }, n)
                                )
                              })
                            ]
                          }),
                          jsxs(Button, {
                            key: 'filter',
                            variant: filters.length ? 'secondary' : 'ghost',
                            size: 'sm',
                            title: 'Filter rows',
                            onClick: () => setFilterOpen((open) => !open),
                            children: [
                              jsx(Codicon, { key: 'i', name: 'filter' }),
                              jsx('span', {
                                key: 't',
                                className: 'dbd-sm-inline',
                                children: 'Filter'
                              }),
                              filters.length
                                ? jsx('span', {
                                    key: 'n',
                                    className: 'tabular-nums',
                                    children: filters.length
                                  })
                                : null
                            ]
                          }),
                          data && data.columns
                            ? jsx('span', {
                                key: 'meta',
                                className:
                                  'dbd-meta min-w-0 truncate text-[11px] whitespace-nowrap text-(--ui-text-tertiary)',
                                children: `${data.columns.length} columns · ${data.duration_ms} ms${
                                  data.truncated ? ' · more rows' : ''
                                }`
                              })
                            : null,
                          jsx('span', {
                            key: 'sep-actions',
                            className:
                              'mx-0.5 h-4 w-px shrink-0 bg-(--ui-stroke-secondary)'
                          }),
                          canInsert
                            ? jsx(Button, {
                                key: 'insert',
                                variant: 'secondary',
                                size: 'sm',
                                onClick: () => setInsertOpen(true),
                                children: '+ Row'
                              })
                            : null,
                          canInsert
                            ? jsx(Button, {
                                key: 'import',
                                variant: 'ghost',
                                size: 'sm',
                                title: 'Import CSV',
                                onClick: () => {
                                  if (importFileRef.current) importFileRef.current.click()
                                },
                                children: jsxs('span', {
                                  className: 'flex items-center gap-1',
                                  children: [
                                    jsx(Codicon, { key: 'i', name: 'cloud-upload' }),
                                    jsx('span', {
                                      key: 't',
                                      className: 'dbd-sm-inline',
                                      children: 'Import'
                                    })
                                  ]
                                })
                              })
                            : null,
                          selected
                            ? jsx(Button, {
                                key: 'csv',
                                variant: 'ghost',
                                size: 'sm',
                                title: 'Export the whole table as CSV (up to 50k rows)',
                                onClick: () => void exportTable(),
                                disabled: exporting,
                                children: exporting ? 'Exporting…' : 'Export CSV'
                              })
                            : null,
                          jsx('span', {
                            key: 'sep-tools',
                            className:
                              'mx-0.5 h-4 w-px shrink-0 bg-(--ui-stroke-secondary)'
                          }),
                          jsx(Button, {
                            key: 'views',
                            variant: tableViews.length ? 'secondary' : 'ghost',
                            size: 'sm',
                            title: 'Saved views for this table',
                            onClick: () => setViewsOpen(true),
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'bookmark' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'Views'
                                }),
                                tableViews.length
                                  ? jsx('span', {
                                      key: 'n',
                                      className: 'tabular-nums',
                                      children: tableViews.length
                                    })
                                  : null
                              ]
                            })
                          }),
                          jsx(CopyMenu, {
                            key: 'copy',
                            disabled: !selection && selectedRows.length === 0,
                            canInsert: true,
                            onCopy: copySelection
                          }),
                          jsx(Button, {
                            key: 'chart',
                            variant: chartOpen ? 'secondary' : 'ghost',
                            size: 'sm',
                            title: 'Chart results',
                            onClick: () => setChartOpen((open) => !open),
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'graph' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'Chart'
                                })
                              ]
                            })
                          }),
                          jsx(ColumnsMenu, {
                            key: 'columns',
                            columns: columnsMeta,
                            hidden: hiddenColumns,
                            onToggle: toggleColumn
                          }),
                          selectedRows.length > 0
                            ? jsx('span', {
                                key: 'selected',
                                className:
                                  'text-[10.5px] whitespace-nowrap text-(--ui-text-secondary)',
                                children: `${selectedRows.length} selected`
                              })
                            : null,
                          selectedRows.length > 0 && rowsEditable
                            ? jsx(Button, {
                                key: 'bulk-delete',
                                variant: 'ghost',
                                size: 'sm',
                                className: 'text-destructive',
                                onClick: () => void deleteSelected(),
                                children: 'Delete selected'
                              })
                            : null,
                          selectedRows.length > 0
                            ? jsx(Button, {
                                key: 'bulk-clear',
                                variant: 'ghost',
                                size: 'sm',
                                onClick: () => setSelectedRows([]),
                                children: 'Clear'
                              })
                            : null,
                          rowsEditable
                            ? jsx('span', {
                                key: 'hint',
                                className: 'hidden text-[10.5px] whitespace-nowrap text-(--ui-text-tertiary) xl:inline',
                                children: 'double-click a cell to edit'
                              })
                            : selected && active && !active.readonly && pkColumns.length === 0
                              ? jsx('span', {
                                  key: 'nopk',
                                  className: 'text-[10.5px] whitespace-nowrap text-amber-600 dark:text-amber-300',
                                  children: 'no primary key · use SQL to edit'
                                })
                              : null,
                          jsx('div', { className: 'flex-1' }),
                          jsxs('div', {
                            className: 'flex shrink-0 items-center gap-1 text-[11px] text-(--ui-text-tertiary)',
                            children: [
                              !appended
                                ? jsx(Button, {
                                    variant: 'ghost',
                                    size: 'icon-xs',
                                    disabled: offset === 0 || dataLoading,
                                    onClick: () => setOffset(Math.max(0, offset - limit)),
                                    children: jsx(Codicon, { name: 'chevron-left' })
                                  })
                                : null,
                              jsx('span', {
                                className: 'tabular-nums',
                                children: appended
                                  ? `1–${data ? data.rows.length : 0}`
                                  : `${offset + 1}–${offset + (data ? data.rows.length : 0)}`
                              }),
                              !appended
                                ? jsx(Button, {
                                    variant: 'ghost',
                                    size: 'icon-xs',
                                    disabled: !data || !data.truncated || dataLoading,
                                    onClick: () => setOffset(offset + limit),
                                    children: jsx(Codicon, { name: 'chevron-right' })
                                  })
                                : null,
                              data && data.truncated
                                ? jsx(Button, {
                                    variant: 'ghost',
                                    size: 'xs',
                                    disabled: dataLoading,
                                    onClick: () => void loadMore(),
                                    children: 'Load more'
                                  })
                                : null,
                              appended
                                ? jsx(Button, {
                                    variant: 'ghost',
                                    size: 'xs',
                                    onClick: () => {
                                      setAppended(false)
                                      setOffset(0)
                                      void loadRows(0)
                                    },
                                    children: 'Reset'
                                  })
                                : null
                            ]
                          })
                        ]
                      }),
                      aiOpen
                        ? jsx(AiPanel, {
                            key: 'ai',
                            connectionId: activeId,
                            database: activeDb,
                            schema: selected ? selected.schema : '',
                            table: selected ? selected.table : '',
                            onClose: () => setAiOpen(false),
                            onUseSql: (sql) => {
                              setAiOpen(false)
                              setTab('sql')
                              setSql(sql)
                            }
                          })
                        : null,
                      selected && filterOpen
                        ? jsxs('div', {
                            key: 'filter-panel',
                            className:
                              'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                            children: [
                              jsx('select', {
                                key: 'col',
                                title: 'Filter column',
                                className:
                                  'h-7 max-w-[210px] rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                value: filterDraft.column || (columnsMeta[0] ? columnsMeta[0].name : ''),
                                onChange: (event) =>
                                  setFilterDraft((current) => ({
                                    ...current,
                                    column: event.target.value
                                  })),
                                children: columnsMeta.map((column) =>
                                  jsx(
                                    'option',
                                    {
                                      value: column.name,
                                      children: `${column.name} (${shortenType(column.type)})`
                                    },
                                    column.name
                                  )
                                )
                              }),
                              jsx('select', {
                                key: 'op',
                                title: 'Operator',
                                className:
                                  'h-7 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                value: filterDraft.op,
                                onChange: (event) =>
                                  setFilterDraft((current) => ({
                                    ...current,
                                    op: event.target.value
                                  })),
                                children: [
                                  ['contains', 'contains'],
                                  ['eq', '='],
                                  ['neq', '≠'],
                                  ['gt', '>'],
                                  ['lt', '<'],
                                  ['gte', '≥'],
                                  ['lte', '≤'],
                                  ['isnull', 'is null'],
                                  ['notnull', 'is not null']
                                ].map(([value, label]) =>
                                  jsx('option', { value, children: label }, value)
                                )
                              }),
                              jsx(Input, {
                                key: 'value',
                                className: 'h-7 w-40',
                                value: filterDraft.value,
                                disabled: ['isnull', 'notnull'].includes(filterDraft.op),
                                placeholder: 'value',
                                onChange: (event) =>
                                  setFilterDraft((current) => ({
                                    ...current,
                                    value: event.target.value
                                  })),
                                onKeyDown: (event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    addFilter()
                                  }
                                }
                              }),
                              ['contains', 'startswith'].includes(filterDraft.op)
                                ? jsxs('label', {
                                    key: 'ci',
                                    className:
                                      'flex items-center gap-1 text-[10px] text-(--ui-text-tertiary)',
                                    children: [
                                      jsx('input', {
                                        type: 'checkbox',
                                        checked: filterDraft.insensitive !== false,
                                        onChange: (event) =>
                                          setFilterDraft((current) => ({
                                            ...current,
                                            insensitive: event.target.checked
                                          }))
                                      }),
                                      jsx('span', { children: 'ignore case' })
                                    ]
                                  })
                                : null,
                              jsx(Button, {
                                key: 'add',
                                variant: 'secondary',
                                size: 'sm',
                                onClick: addFilter,
                                children: 'Add'
                              }),
                              filters.length
                                ? jsx(Button, {
                                    key: 'clear',
                                    variant: 'ghost',
                                    size: 'sm',
                                    onClick: () => {
                                      setFilters([])
                                      setOffset(0)
                                    },
                                    children: 'Clear'
                                  })
                                : null
                            ]
                          })
                        : null,
                      filters.length
                        ? jsxs('div', {
                            key: 'filter-chips',
                            className:
                              'flex shrink-0 flex-wrap items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1',
                            children: [
                              jsx('span', {
                                key: 'label',
                                className: 'text-[10px] text-(--ui-text-tertiary)',
                                children: 'WHERE'
                              }),
                              ...filters.map((filter, index) =>
                                jsxs(
                                  'span',
                                  {
                                    className:
                                      'inline-flex max-w-[260px] items-center gap-1 rounded-[3px] bg-(--ui-bg-quaternary) px-1.5 py-0.5 font-mono text-[10.5px]',
                                    title: `${filter.column} ${opLabel(filter.op)}${
                                      ['contains', 'startswith'].includes(filter.op) &&
                                      filter.insensitive !== false
                                        ? ' (ci)'
                                        : ''
                                    } ${
                                      ['isnull', 'notnull'].includes(filter.op) ? '' : filter.value
                                    }`,
                                    children: [
                                      jsx('span', {
                                        key: 't',
                                        className: 'truncate',
                                        children: `${filter.column} ${opLabel(filter.op)}${
                                          ['contains', 'startswith'].includes(filter.op) &&
                                          filter.insensitive !== false
                                            ? ' (ci)'
                                            : ''
                                        }${
                                          ['isnull', 'notnull'].includes(filter.op)
                                            ? ''
                                            : ` ${filter.value}`
                                        }`
                                      }),
                                      jsx('button', {
                                        key: 'x',
                                        type: 'button',
                                        className: 'shrink-0 opacity-60 hover:opacity-100',
                                        onClick: () => removeFilter(index),
                                        children: jsx(Codicon, { name: 'close' })
                                      })
                                    ]
                                  },
                                  index
                                )
                              )
                            ]
                          })
                        : null,
                      chartOpen && data && data.columns.length > 0
                        ? jsx(ResultChart, {
                            key: `chart-${data.columns.map((column) => column.name).join(',')}`,
                            columns: data.columns,
                            rows: data.rows,
                            type: chartType,
                            onType: setChartType
                          })
                        : null,
                      selected
                        ? jsx(Grid, {
                            key: 'grid',
                            columns: data ? data.columns : null,
                            rows: data ? data.rows : [],
                            emptyText: dataLoading ? 'Loading…' : 'No rows.',
                            onSort: sortBy,
                            pk: pkColumns.map((column) => column.name),
                            editable: rowsEditable,
                            onEditCell: editCell,
                            onDeleteRow: rowsEditable ? deleteRow : undefined,
                            selection,
                            onSelectCell: selectCell,
                            onSelectRow: selectRow,
                            fkMap,
                            onFollowFk: followFk,
                            onLongPress: openCellMenu,
                            hiddenColumns,
                            selectable: true,
                            selectedRows,
                            onToggleRow: toggleRow,
                            onToggleAll: toggleAllRows
                          })
                        : jsx('div', {
                            key: 'none',
                            className: 'flex flex-1 flex-col items-center justify-center gap-2 text-xs text-(--ui-text-tertiary)',
                            children: [
                              jsx(Codicon, { key: 'i', name: 'database', className: 'text-3xl opacity-40' }),
                              jsx('div', {
                                key: 't',
                                children: active
                                  ? 'Pick a table on the left, or switch to SQL.'
                                  : 'Add a connection to get started.'
                              })
                            ]
                          })
                    ]
                  })
                : tab === 'sql'
                ? jsxs('div', {
                    key: 'sql',
                    className: 'flex min-h-0 flex-1 flex-col',
                    children: [
                      jsx('div', {
                        key: 'editor',
                        className: 'relative shrink-0 border-b border-(--ui-stroke-secondary) p-2',
                        children: [
                          jsx('textarea', {
                            key: 'input',
                            ref: sqlRef,
                            value: sql,
                            spellCheck: false,
                            className:
                              'h-32 w-full resize-y rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[12px] leading-5 outline-none focus:border-primary/60',
                            placeholder: 'select * from public.users limit 50;',
                            onChange: (event) => {
                              setSql(event.target.value)
                              updateSuggestions(event.target.value, event.target.selectionStart)
                            },
                            onClick: (event) =>
                              updateSuggestions(sql, event.currentTarget.selectionStart),
                            onBlur: () => setSuggestOpen(false),
                            onKeyDown: (event) => {
                              if (suggestOpen && suggestions.length > 0) {
                                if (event.key === 'ArrowDown') {
                                  event.preventDefault()
                                  setSuggestIndex((index) => (index + 1) % suggestions.length)
                                  return
                                }
                                if (event.key === 'ArrowUp') {
                                  event.preventDefault()
                                  setSuggestIndex(
                                    (index) => (index - 1 + suggestions.length) % suggestions.length
                                  )
                                  return
                                }
                                if (event.key === 'Enter' || event.key === 'Tab') {
                                  event.preventDefault()
                                  acceptSuggestion(suggestions[suggestIndex] || suggestions[0])
                                  return
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setSuggestOpen(false)
                                  return
                                }
                              }
                              if ((event.metaKey || event.ctrlKey) && event.key === ' ') {
                                event.preventDefault()
                                setSuggestPrefix('')
                                setSuggestOpen(true)
                                return
                              }
                              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                event.preventDefault()
                                void runQuery()
                              }
                            }
                          }),
                          suggestOpen && suggestions.length > 0
                            ? jsx('div', {
                                key: 'suggest',
                                className:
                                  'absolute top-full left-2 z-30 mt-1 flex w-64 flex-col rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                                children: suggestions.map((item, index) =>
                                  jsx(
                                    'button',
                                    {
                                      type: 'button',
                                      className: cn(
                                        'rounded-[2px] px-2 py-1 text-left font-mono text-[11px]',
                                        index === suggestIndex
                                          ? 'bg-(--ui-bg-quaternary)'
                                          : 'hover:bg-(--chrome-action-hover)'
                                      ),
                                      onMouseDown: (event) => {
                                        event.preventDefault()
                                        acceptSuggestion(item)
                                      },
                                      children: item
                                    },
                                    item
                                  )
                                )
                              })
                            : null
                        ]
                      }),
                      jsxs('div', {
                        key: 'bar',
                        className:
                          'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                        children: [
                          jsx(Button, {
                            variant: 'default',
                            size: 'sm',
                            onClick: () => void runQuery(),
                            disabled: !activeId || queryLoading,
                            children: queryLoading ? 'Running…' : 'Run'
                          }),
                          jsx('span', {
                            key: 'hint',
                            className: 'text-[11px] text-(--ui-text-tertiary)',
                            children: '⌘/Ctrl + Enter'
                          }),
                          query && query.columns
                            ? jsx(Button, {
                                key: 'csv',
                                variant: 'ghost',
                                size: 'sm',
                                onClick: () =>
                                  downloadCsv(
                                    `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
                                    toCsv(query.columns, query.rows)
                                  ),
                                children: 'CSV'
                              })
                            : null,
                          jsx(CopyMenu, {
                            key: 'copy',
                            disabled: !selection,
                            onCopy: copySelection
                          }),
                          jsx(Button, {
                            key: 'history',
                            variant: 'ghost',
                            size: 'sm',
                            title: 'Query history',
                            onClick: () => setQueriesOpen(true),
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'history' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'History'
                                })
                              ]
                            })
                          }),
                          jsx(Button, {
                            key: 'format',
                            variant: 'ghost',
                            size: 'sm',
                            title: 'Format SQL',
                            onClick: () => setSql(formatSqlText(sql)),
                            children: 'Format'
                          }),
                          jsx(Button, {
                            key: 'chart',
                            variant: chartOpen ? 'secondary' : 'ghost',
                            size: 'sm',
                            title: 'Chart results',
                            onClick: () => setChartOpen((open) => !open),
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'graph' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'Chart'
                                })
                              ]
                            })
                          }),
                          query
                            ? jsx('span', {
                                key: 'meta',
                                className: 'whitespace-nowrap text-[11px] text-(--ui-text-tertiary)',
                                children: `${query.rows.length} rows · ${query.duration_ms} ms${
                                  query.truncated ? ' · truncated' : ''
                                }`
                              })
                            : null,
                          jsx('div', { className: 'flex-1' }),
                          active && !active.readonly
                            ? jsx(Badge, { variant: 'warn', size: 'xs', children: 'writes allowed' })
                            : jsx(Badge, { variant: 'outline', size: 'xs', children: 'read-only' })
                        ]
                      }),
                      chartOpen && query && query.columns.length > 0
                        ? jsx(ResultChart, {
                            key: `chart-${query.columns.map((column) => column.name).join(',')}`,
                            columns: query.columns,
                            rows: query.rows,
                            type: chartType,
                            onType: setChartType
                          })
                        : null,
                      jsx(Grid, {
                        key: 'grid',
                        columns: query ? query.columns : null,
                        rows: query ? query.rows : [],
                        emptyText: queryLoading ? 'Running…' : 'Run a query to see results.',
                        selection,
                        onSelectCell: selectCell,
                        onSelectRow: selectRow,
                        onLongPress: openCellMenu
                      })
                    ]
                  })
                : tab === 'site'
                ? jsxs('div', {
                    key: 'site',
                    className: 'flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3',
                    children: [
                      jsxs('div', {
                        key: 'bar',
                        className: 'flex items-center gap-2',
                        children: [
                          jsx('div', {
                            key: 't',
                            className: 'text-sm font-semibold',
                            children: 'WordPress site'
                          }),
                          jsx('div', { key: 's', className: 'flex-1' }),
                          jsx(Button, {
                            key: 'r',
                            variant: 'secondary',
                            size: 'sm',
                            onClick: () => setSiteVersion((version) => version + 1),
                            disabled: siteLoading,
                            children: siteLoading ? 'Loading…' : 'Refresh'
                          })
                        ]
                      }),
                      siteInfo && siteInfo.found
                        ? jsxs('div', {
                            key: 'cards',
                            className: 'flex flex-wrap gap-2',
                            children: [
                              ['Site URL', siteInfo.siteurl],
                              ['Home', siteInfo.home],
                              ['Name', siteInfo.blogname],
                              ['Theme', siteInfo.theme],
                              ['Posts', siteInfo.counts.post],
                              ['Pages', siteInfo.counts.page],
                              ['Users', siteInfo.counts.users],
                              ['Plugins', (siteInfo.plugins || []).length]
                            ].map(([label, value]) =>
                              jsxs(
                                'div',
                                {
                                  className:
                                    'min-w-[130px] rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                                  children: [
                                    jsx('div', {
                                      className:
                                        'text-[9px] tracking-wide text-(--ui-text-tertiary) uppercase',
                                      children: label
                                    }),
                                    jsx('div', {
                                      className: 'truncate font-mono text-[11.5px]',
                                      title: String(value ?? ''),
                                      children: String(value ?? '—')
                                    })
                                  ]
                                },
                                label
                              )
                            )
                          })
                        : jsx('div', {
                            key: 'none',
                            className: 'text-[12px] text-(--ui-text-tertiary)',
                            children: siteLoading
                              ? 'Loading…'
                              : (siteInfo && siteInfo.message) || 'No WordPress data.'
                          }),
                      siteInfo && siteInfo.found && (siteInfo.plugins || []).length > 0
                        ? jsxs('div', {
                            key: 'plugins',
                            className: 'flex flex-col gap-1',
                            children: [
                              jsx('div', {
                                className: 'text-[11px] font-medium text-(--ui-text-secondary)',
                                children: `Active plugins (${siteInfo.plugins.length})`
                              }),
                              ...siteInfo.plugins.map((plugin) =>
                                jsx(
                                  'div',
                                  {
                                    className:
                                      'font-mono text-[10.5px] text-(--ui-text-tertiary)',
                                    children: plugin
                                  },
                                  plugin
                                )
                              )
                            ]
                          })
                        : null
                    ]
                  })
                : jsxs('div', {
                    key: 'schema',
                    className: 'flex min-h-0 flex-1 flex-col',
                    children: [
                      jsxs('div', {
                        key: 'bar',
                        className:
                          'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                        children: [
                          jsx('span', {
                            key: 'title',
                            className: 'min-w-0 truncate font-mono text-[11px] text-(--ui-text-tertiary)',
                            children: selected ? `${selected.schema}.${selected.table}` : 'No table selected'
                          }),
                          jsx('div', { className: 'flex-1' }),
                          selected
                            ? jsx(Button, {
                                variant: 'ghost',
                                size: 'xs',
                                title: 'Rename column',
                                onClick: () =>
                                  setAlter({
                                    mode: 'rename',
                                    name: columnsMeta[0] ? columnsMeta[0].name : '',
                                    newName: ''
                                  }),
                                children: 'Rename'
                              })
                            : null,
                          selected
                            ? jsx(Button, {
                                variant: 'ghost',
                                size: 'xs',
                                title: 'Indexes',
                                onClick: () => setIndexesOpen(true),
                                children: 'Indexes'
                              })
                            : null,
                          selected
                            ? jsx(Button, {
                                variant: 'ghost',
                                size: 'xs',
                                title: 'Compare this table with another',
                                onClick: () => setDiffOpen(true),
                                children: 'Diff'
                              })
                            : null,
                          selected
                            ? jsx(Button, {
                                variant: 'ghost',
                                size: 'xs',
                                title: 'Add column',
                                onClick: () =>
                                  setAlter({
                                    mode: 'add',
                                    name: '',
                                    type: '',
                                    default: '',
                                    nullable: true
                                  }),
                                children: '+ Column'
                              })
                            : null,
                          selected
                            ? jsx(Button, {
                                variant: 'ghost',
                                size: 'xs',
                                title: 'Drop column',
                                onClick: () =>
                                  setAlter({
                                    mode: 'drop',
                                    name: columnsMeta[0] ? columnsMeta[0].name : ''
                                  }),
                                children: '− Column'
                              })
                            : null,
                          jsx(Button, {
                            variant: 'ghost',
                            size: 'xs',
                            disabled: !ddl || ddlLoading,
                            onClick: () => {
                              void writeClipboardText(ddl)
                              host.notify({ kind: 'info', message: 'DDL copied' })
                            },
                            children: 'Copy'
                          }),
                          jsx(Button, {
                            variant: 'secondary',
                            size: 'sm',
                            disabled: !selected || ddlLoading,
                            onClick: () => setTreeVersion((v) => v + 1),
                            children: ddlLoading ? 'Loading…' : 'Refresh'
                          })
                        ]
                      }),
                      alter
                        ? jsxs('div', {
                            key: 'alter',
                            className:
                              'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                            children: [
                              alter.mode === 'add'
                                ? jsxs('div', {
                                    className: 'flex flex-wrap items-center gap-2',
                                    children: [
                                      jsx(Input, {
                                        className: 'h-7 w-36',
                                        value: alter.name,
                                        placeholder: 'column name',
                                        onChange: (event) =>
                                          setAlter({ ...alter, name: event.target.value })
                                      }),
                                      jsx(Input, {
                                        className: 'h-7 w-44',
                                        value: alter.type,
                                        placeholder: 'type e.g. varchar(100)',
                                        onChange: (event) =>
                                          setAlter({ ...alter, type: event.target.value })
                                      }),
                                      jsx(Input, {
                                        className: 'h-7 w-36',
                                        value: alter.default,
                                        placeholder: 'default (optional)',
                                        onChange: (event) =>
                                          setAlter({ ...alter, default: event.target.value })
                                      }),
                                      jsxs('label', {
                                        className:
                                          'flex items-center gap-1 text-[10px] text-(--ui-text-tertiary)',
                                        children: [
                                          jsx('input', {
                                            type: 'checkbox',
                                            checked: alter.nullable,
                                            onChange: (event) =>
                                              setAlter({
                                                ...alter,
                                                nullable: event.target.checked
                                              })
                                          }),
                                          'nullable'
                                        ]
                                      })
                                    ]
                                  })
                                : alter.mode === 'drop'
                                  ? jsx('select', {
                                      className:
                                        'h-7 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                      value: alter.name,
                                      onChange: (event) =>
                                        setAlter({ ...alter, name: event.target.value }),
                                      children: columnsMeta.map((column) =>
                                        jsx('option', { value: column.name, children: column.name }, column.name)
                                      )
                                    })
                                  : jsxs('div', {
                                      className: 'flex items-center gap-2',
                                      children: [
                                        jsx('select', {
                                          className:
                                            'h-7 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                          value: alter.name,
                                          onChange: (event) =>
                                            setAlter({ ...alter, name: event.target.value }),
                                          children: columnsMeta.map((column) =>
                                            jsx('option', { value: column.name, children: column.name }, column.name)
                                          )
                                        }),
                                        jsx('span', {
                                          className: 'text-[11px] text-(--ui-text-tertiary)',
                                          children: '→'
                                        }),
                                        jsx(Input, {
                                          className: 'h-7 w-40',
                                          value: alter.newName || '',
                                          placeholder: 'new name',
                                          onChange: (event) =>
                                            setAlter({ ...alter, newName: event.target.value })
                                        })
                                      ]
                                    }),
                              jsx(Button, {
                                variant: 'secondary',
                                size: 'sm',
                                onClick: () => void previewAlter(),
                                disabled:
                                  alter.mode === 'add'
                                    ? !alter.name || !alter.type
                                    : alter.mode === 'rename'
                                      ? !alter.name || !alter.newName
                                      : !alter.name,
                                children: 'Preview'
                              }),
                              jsx(Button, {
                                variant: 'ghost',
                                size: 'sm',
                                onClick: () => setAlter(null),
                                children: 'Cancel'
                              })
                            ]
                          })
                        : null,
                      jsx('pre', {
                        key: 'ddl',
                        className:
                          'min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-5 whitespace-pre',
                        children: selected
                          ? ddl || (ddlLoading ? 'Loading schema…' : '')
                          : 'Pick a table to see its DDL.'
                      })
                    ]
                  })
            ]
          })
        ]
      }),
      jsx('input', {
        key: 'import-file',
        type: 'file',
        accept: '.csv,text/csv',
        style: { display: 'none' },
        ref: importFileRef,
        onChange: onImportFile
      }),
      cellMenu
        ? jsx(CellMenu, {
            key: 'cell-menu',
            menu: cellMenu,
            onClose: () => setCellMenu(null),
            onEdit: () => editCell(cellMenu.rowIndex, cellMenu.columnIndex, cellMenu.value, cellMenu.rect),
            onCopy: menuCopyValue,
            onCopyRow: menuCopyRow,
            onFollow: () => followFk(cellMenu.fk, cellMenu.value),
            onRowDetail: () => setRowDetail(cellMenu.rowIndex)
          })
        : null,
      pending
        ? jsx(SqlConfirm, { key: 'confirm', pending, onCancel: () => setPending(null) })
        : null,
      indexesOpen && selected
        ? jsx(IndexesDrawer, {
            key: 'indexes',
            connectionId: activeId,
            database: activeDb,
            schema: selected.schema,
            table: selected.table,
            columns: columnsMeta,
            version: indexVersion,
            onCreate: (body) =>
              void previewIndex(
                body,
                `Create index ${body.name} on ${selected.schema}.${selected.table}`
              ),
            onDrop: (body) =>
              void previewIndex(
                body,
                `Drop index ${body.name} on ${selected.schema}.${selected.table}`
              ),
            onClose: () => setIndexesOpen(false)
          })
        : null,
      diffOpen && selected
        ? jsx(SchemaDiffDrawer, {
            key: 'diff',
            connectionId: activeId,
            database: activeDb,
            source: { schema: selected.schema, table: selected.table },
            sourceColumns: columnsMeta,
            tables: allTables,
            connections,
            onClose: () => setDiffOpen(false)
          })
        : null,
      rowDetail != null && data
        ? jsx(RowDrawer, {
            key: 'row-detail',
            columns: data.columns,
            row: data.rows[rowDetail] || [],
            onClose: () => setRowDetail(null)
          })
        : null,
      approvalWait
        ? jsx(ApprovalWait, {
            key: 'approval-wait',
            wait: approvalWait,
            onDecide: (decision) => void decideApproval(approvalWait.id, decision)
          })
        : null,
      approvalsOpen
        ? jsx(ApprovalsDrawer, {
            key: 'approvals',
            approvals,
            onDecide: (id, decision) => void decideApproval(id, decision),
            onRefresh: () => {
              call('/approvals?limit=50')
                .then((result) => setApprovals(result.approvals || []))
                .catch(() => {})
            },
            onClose: () => setApprovalsOpen(false)
          })
        : null,
      auditOpen
        ? jsx(AuditDrawer, { key: 'audit', onClose: () => setAuditOpen(false) })
        : null,
      activityOpen
        ? jsx(ActivityDrawer, {
            key: 'activity',
            connectionId: activeId,
            onClose: () => setActivityOpen(false)
          })
        : null,
      importOpen && importData
        ? jsx(ImportDrawer, {
            key: 'import',
            data: importData,
            tableLabel: selected ? `${selected.schema}.${selected.table}` : '',
            nullEmpty: importNullEmpty,
            onToggleNull: setImportNullEmpty,
            onImport: runImport,
            onClose: () => {
              setImportOpen(false)
              setImportData(null)
            }
          })
        : null,
      viewsOpen
        ? jsx(ViewsDrawer, {
            key: 'views',
            label: selected ? `${selected.schema}.${selected.table}` : '',
            views: tableViews,
            canSave: Boolean(selected),
            onApply: applyView,
            onSave: saveView,
            onDelete: (id) => void deleteView(id),
            onClose: () => setViewsOpen(false)
          })
        : null,
      queriesOpen
        ? jsx(QueriesDrawer, {
            key: 'queries',
            connectionId: activeId,
            currentSql: sql,
            onPick: (text) => {
              setSql(text)
              setQueriesOpen(false)
              setTab('sql')
            },
            onClose: () => setQueriesOpen(false)
          })
        : null,
      labelsOpen && active
        ? jsx(LabelsDrawer, {
            key: 'labels',
            connection: active,
            databases,
            onClose: () => setLabelsOpen(false),
            onSaved: async () => {
              setLabelsOpen(false)
              await loadConnections()
              setDbVersion((v) => v + 1)
              host.notify({ kind: 'info', message: 'Database labels saved' })
            }
          })
        : null,
      insertOpen && selected
        ? jsx(InsertDrawer, {
            key: 'insert',
            schema: selected.schema,
            table: selected.table,
            columns: columnsMeta,
            onClose: () => setInsertOpen(false),
            onInsert: insertRow
          })
        : null,
      editor
        ? jsx(CellEditor, {
            key: 'editor',
            editor,
            column: editor.column,
            onCancel: () => setEditor(null),
            onSave: saveEdit
          })
        : null,
      draft
        ? jsx(ConnectionDrawer, {
            key: 'drawer',
            draft,
            onDraft: setDraft,
            onClose: () => setDraft(null),
            onSaved,
            onDeleted
          })
        : null
    ]
  })
}

export default {
  id: 'dbdesk',
  name: 'DB Desk',
  register(ctx) {
    rest = ctx.rest
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dbdesk', '')
      styleEl.textContent = STYLES
      document.head.appendChild(styleEl)
      ctx.onDispose(() => {
        styleEl.remove()
        styleEl = null
      })
    }
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/dbdesk' },
        render: () => jsx(DbDesk, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/dbdesk', label: 'DB Desk', codicon: 'database' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'dbdesk.open',
          label: 'Open DB Desk',
          keywords: ['db', 'sql', 'postgres', 'database', 'tableplus'],
          run: () => host.navigate('/dbdesk')
        }
      }
    ])
  }
}
