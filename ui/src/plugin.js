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

// Shortcut labels follow the platform: ⌘ on macOS, Ctrl everywhere else. This file is
// also copied verbatim into the Hermes plugin, so the helpers live here rather than in
// a shared module that the plugin build could not resolve.
function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  // navigator.platform is non-empty on every browser, so it can never fall back to the
  // user agent — check the modern hint first, then platform, then the UA string.
  const data = navigator.userAgentData
  if (data && typeof data.platform === 'string' && data.platform) {
    return /mac/i.test(data.platform)
  }
  if (navigator.platform) return /mac/i.test(navigator.platform)
  return /mac/i.test(navigator.userAgent || '')
}

// In a browser tab Ctrl+T and Ctrl+W belong to the browser and cannot be intercepted,
// so the "new SQL tab" shortcut moves to Alt+T whenever we are not inside the Tauri
// shell (the hosted server mode).
function inBrowserTab() {
  return typeof window !== 'undefined' && !window.__TAURI_INTERNALS__
}

// "⌘F" on macOS, "Ctrl+F" elsewhere — the separator differs too, so build the whole
// chord rather than pasting a modifier in front of a symbol.
function chord(keys) {
  return (isMacPlatform() ? '\u2318' : 'Ctrl+') + keys
}

function zoomKey() {
  return isMacPlatform() ? '\u2318 + / \u2212 / 0' : 'Ctrl + / \u2212 / 0'
}

function newTabKey() {
  // ⌘T/Ctrl+T is the browser's own new-tab shortcut and cannot be cancelled by a page.
  if (inBrowserTab()) return isMacPlatform() ? '\u2325T' : 'Alt+T'
  return chord('T')
}

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
/* Flat, high-contrast selects: the native macOS popup button draws a glossy
 * gradient that is hard to read against our toolbar backgrounds. */
.dbd-app select {
  -webkit-appearance: none;
  appearance: none;
  background-color: var(--background, #fff);
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 3.25L4 5.75L6.5 3.25' fill='none' stroke='%2364748b' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  background-size: 8px 8px;
  padding-right: 20px;
  color: var(--ui-text-primary, #0f172a);
  border-color: var(--ui-stroke-secondary, #e2e8f0);
  cursor: pointer;
  transition: border-color .12s ease, background-color .12s ease;
}
.dbd-app select:hover { border-color: var(--ui-stroke-strong, #cbd5e1); background-color: var(--ui-bg-secondary, #f8fafc); }
.dbd-app select:focus { outline: none; border-color: var(--primary, #2563eb); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary, #2563eb) 22%, transparent); }
.dark .dbd-app select {
  background-color: var(--ui-bg-chrome, #0f1115);
  color: var(--ui-text-primary, #e8ecf3);
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 3.25L4 5.75L6.5 3.25' fill='none' stroke='%2394a3b8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
.dark .dbd-app select:hover { background-color: var(--ui-bg-quaternary, #1a1f2b); }
.dbd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dbd-grid-table { border-collapse: collapse; font-size: 12px; }
.dbd-grid-table tbody tr { height: 26px; }
.dbd-grid-table tbody td { height: 26px; }
.dbd-grid-table thead th { box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); }
.dbd-col-resize {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 5;
  width: 7px; cursor: col-resize;
}
.dbd-col-resize:hover { background: color-mix(in srgb, var(--primary) 35%, transparent); }
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
.dbd-sidebar-resize {
  position: absolute; top: 0; bottom: 0; right: -3px; z-index: 30;
  width: 6px; cursor: col-resize; touch-action: none;
}
.dbd-sidebar-resize:hover, .dbd-sidebar-resize[data-active="true"] {
  background: color-mix(in srgb, var(--primary) 40%, transparent);
}
@media (max-width: 767px) { .dbd-sidebar-resize { display: none; } }
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
  .dbd-sidebar {
    position: relative; width: var(--dbd-sidebar-width, 16rem);
    transform: none; z-index: auto; box-shadow: none;
  }
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

function downloadFile(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function downloadCsv(filename, text) {
  downloadFile(filename, text, 'text/csv;charset=utf-8')
}

const SQL_ALIAS_STOPWORDS = new Set(
  `where join left right inner outer full cross on using group order limit offset having union
   except intersect set values returning as natural lateral window with select from update into
   delete insert and or not null case when then else end default asc desc fetch`.split(/\s+/)
)

const SQL_ALIAS_RE =
  /\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi

function sqlAliases(text) {
  if (!text) return []
  const found = []
  const seen = new Set()
  SQL_ALIAS_RE.lastIndex = 0
  let match
  while ((match = SQL_ALIAS_RE.exec(text))) {
    const reference = match[1]
    const candidate = match[2]
    const alias =
      candidate && !SQL_ALIAS_STOPWORDS.has(candidate.toLowerCase()) ? candidate : ''
    const parts = reference.split('.')
    const schema = parts.length > 1 ? parts[0] : ''
    const table = parts.length > 1 ? parts[1] : parts[0]
    const key = `${alias.toLowerCase()}|${schema.toLowerCase()}.${table.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ schema, table, alias })
  }
  return found
}

function fuzzyScore(value, query) {
  const text = String(value || '').toLowerCase()
  const needle = String(query || '').toLowerCase()
  if (!needle) return 1
  if (text === needle) return 130
  if (text.startsWith(needle)) return 110 - Math.min(20, text.length - needle.length)
  const boundary = new RegExp(
    `(^|[_.])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  )
  if (boundary.test(text)) return 85
  if (text.includes(needle)) return 60
  let index = 0
  for (const char of needle) {
    index = text.indexOf(char, index)
    if (index === -1) return 0
    index += 1
  }
  return 30
}

const SQL_HIGHLIGHT_WORDS = new Set(
  `select from where join left right inner outer full cross on using group by order having limit offset
   insert into values update set delete create table alter drop index view materialized with as and or not
   null is in like ilike between case when then else end distinct union all exists true false default
   primary key foreign references constraint unique check returning asc desc over partition window
   begin commit rollback transaction explain analyze show describe truncate grant revoke cascade
   serial bigserial int bigint smallint integer numeric decimal real double float boolean date time
   timestamp interval varchar char text uuid json jsonb array`.split(/\s+/)
)

function highlightSql(text) {
  if (!text) return null
  const parts = []
  const regex =
    /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g
  let match
  let key = 0
  while ((match = regex.exec(text))) {
    const [raw, comment, string, number, word] = match
    let className = ''
    if (comment) className = 'text-(--ui-text-tertiary) italic'
    else if (string) className = 'text-emerald-600 dark:text-emerald-400'
    else if (number) className = 'text-amber-600 dark:text-amber-400'
    else if (word) {
      if (SQL_HIGHLIGHT_WORDS.has(word.toUpperCase())) {
        className = 'font-semibold text-sky-600 dark:text-sky-400'
      } else if (/^\s*\(/.test(text.slice(regex.lastIndex))) {
        className = 'text-purple-600 dark:text-purple-400'
      }
    }
    parts.push(jsx('span', { className: className || undefined, children: raw }, key++))
  }
  return parts
}

function isEqualityType(type) {
  const text = String(type || '').toLowerCase()
  if (!text) return false
  return /(^|[^a-z])(tinyint|smallint|mediumint|bigint|integer|int|int2|int4|int8|serial|smallserial|bigserial|numeric|decimal|double|float|real|money|number|bool|boolean|bit|date|time|timestamp|datetime)([^a-z]|$)/.test(
    text
  )
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

function TableMenu({ menu, onClose, onOpen, onExport, onDrop, onCopy, sqlKind, canWrite }) {
  const item =
    'flex w-full items-center gap-2 rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover) disabled:opacity-40'
  const action = (fn) => () => {
    onClose()
    fn()
  }
  return jsxs('div', {
    children: [
      jsx('button', {
        key: 'bg',
        type: 'button',
        'aria-label': 'Close table menu',
        className: 'fixed inset-0 z-40 cursor-default',
        onClick: onClose
      }),
      jsxs('div', {
        key: 'panel',
        className:
          'fixed z-50 flex w-52 flex-col rounded-[5px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-2xl',
        style: {
          left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)),
          top: Math.max(8, Math.min(menu.y, window.innerHeight - 280))
        },
        children: [
          jsx('div', {
            key: 'h',
            className:
              'truncate px-2 py-1 text-[10px] font-medium tracking-wide text-(--ui-text-tertiary) uppercase',
            children: `${menu.schema}.${menu.table}`
          }),
          jsx('button', { type: 'button', className: item, onClick: action(onOpen), children: 'Open' }),
          jsx('div', { className: 'my-1 h-px bg-(--ui-stroke-secondary)' }),
          jsx('button', { type: 'button', className: item, onClick: action(() => onExport('csv')), children: 'Export as CSV' }),
          jsx('button', { type: 'button', className: item, onClick: action(() => onExport('json')), children: 'Export as JSON' }),
          sqlKind
            ? jsx('button', { type: 'button', className: item, onClick: action(() => onExport('sql')), children: 'Export as SQL' })
            : null,
          jsx('div', { className: 'my-1 h-px bg-(--ui-stroke-secondary)' }),
          jsx('button', { type: 'button', className: item, onClick: action(onCopy), children: 'Copy name' }),
          sqlKind && canWrite
            ? jsx('button', {
                type: 'button',
                className: item + ' text-destructive',
                onClick: action(onDrop),
                children: 'Delete table…'
              })
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
  showTypes = false,
  onSort,
  pk,
  editable,
  onEditCell,
  onDeleteRow,
  selection,
  onSelectCell,
  onSelectRow,
  onOpenRow,
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
  const [colWidths, setColWidths] = useState({})
  const colSignature = (columns || []).map((column) => column.name).join('\u0001')
  useEffect(() => {
    setColWidths({})
  }, [colSignature])
  const startColResize = (event, name) => {
    event.preventDefault()
    event.stopPropagation()
    const header = event.currentTarget.parentElement
    if (!header) return
    const startX = event.clientX
    const startWidth = colWidths[name] || header.getBoundingClientRect().width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent) => {
      const next = Math.max(56, startWidth + moveEvent.clientX - startX)
      setColWidths((current) => ({ ...current, [name]: next }))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
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

  // Keyboard navigation of the grid: one cell holds the tab stop, the arrow keys move it, and
  // Ctrl+C copies the cell you are on. Virtualised rows are scrolled into view before focusing.
  const [keyboardCell, setKeyboardCell] = useState(null)

  const onGridKeyDown = (event) => {
    // `current`, not `start`: the outer `start` is the first rendered row, and a local of the
    // same name would be in its own temporal dead zone here.
    const current = keyboardCell || { r: start, c: 0 }
    const lastRow = Math.max(0, rows.length - 1)
    const lastCol = Math.max(0, visibleCount - 1)
    let next = null
    if (event.key === 'ArrowDown') next = { r: Math.min(lastRow, current.r + 1), c: current.c }
    else if (event.key === 'ArrowUp') next = { r: Math.max(0, current.r - 1), c: current.c }
    else if (event.key === 'ArrowRight') next = { r: current.r, c: Math.min(lastCol, current.c + 1) }
    else if (event.key === 'ArrowLeft') next = { r: current.r, c: Math.max(0, current.c - 1) }
    else if (event.key === 'Home') next = { r: current.r, c: 0 }
    else if (event.key === 'End') next = { r: current.r, c: lastCol }
    else if (event.key === 'PageDown') next = { r: Math.min(lastRow, current.r + 10), c: current.c }
    else if (event.key === 'PageUp') next = { r: Math.max(0, current.r - 10), c: current.c }
    else if ((event.metaKey || event.ctrlKey) && (event.key === 'c' || event.key === 'C')) {
      const cell = document.activeElement
      if (cell && cell.dataset && cell.dataset.cell) {
        const text = cell.innerText
        event.preventDefault()
        navigator.clipboard?.writeText(text).catch(() => {})
      }
      return
    }
    if (!next) return
    event.preventDefault()
    setKeyboardCell(next)
    // the row may be virtualised away: scroll it in, then focus the cell
    const scroller = scrollRef.current
    if (scroller) {
      const top = 30 + next.r * ROW_HEIGHT
      if (top < scroller.scrollTop + 30) scroller.scrollTop = Math.max(0, top - 60)
      else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight + 30
      }
    }
    requestAnimationFrame(() => {
      const target = document.querySelector(`[data-cell="${next.r}:${next.c}"]`)
      if (target) target.focus()
    })
  }
  if (!columns || columns.length === 0) {
    return jsx('div', {
      className: 'flex flex-1 items-center justify-center p-8 text-xs text-(--ui-text-tertiary)',
      children: emptyText || 'No columns.'
    })
  }

  const ROW_HEIGHT = 24
  const OVERSCAN = 8
  // Above this many rows, render only what the viewport can show plus the overscan.
  const virtual = rows.length > 100
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
    // Deliberately not throttled with requestAnimationFrame. Measured on a 2000-row page with a
    // 10-position-per-frame scroll burst: 60 scroll events, 57-58 render batches and 423-514 DOM
    // mutations either way — the browser already dispatches at most one scroll event per frame, so
    // a rAF wrapper adds a callback and changes nothing. If scrolling ever does get slow here, the
    // cost is the per-frame re-render of ~40 rows, not the event rate.
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
    onKeyDown: onGridKeyDown,
    className: 'min-h-0 flex-1 overflow-auto',
    children: jsxs('table', {
      role: 'grid',
      'aria-rowcount': rows.length,
      'aria-colcount': columnCount,
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
                      style: colWidths[col.name]
                        ? {
                            width: colWidths[col.name],
                            minWidth: colWidths[col.name],
                            maxWidth: colWidths[col.name]
                          }
                        : undefined,
                      title: `${col.name} · ${col.type || 'unknown type'}`,
                      onClick: onSort ? () => onSort(col.name) : undefined,
                      children: [jsxs('span', {
                        className: 'block overflow-hidden text-ellipsis',
                        children: [
                          pkSet.has(col.name)
                            ? jsx(Codicon, {
                                key: 'k',
                                name: 'key',
                                className: 'mr-1 text-(--ui-text-tertiary)'
                              })
                            : null,
                          jsx('span', { key: 'n', children: col.name }),
                          showTypes && col.type
                            ? jsx('span', {
                                key: 't',
                                className: 'ml-1.5 font-normal text-(--ui-text-tertiary)',
                                children: shortenType(col.type)
                              })
                            : null
                        ]
                      }),
                      jsx('span', {
                        key: 'resize',
                        className: 'dbd-col-resize',
                        title: 'Drag to resize column',
                        onMouseDown: (event) => startColResize(event, col.name),
                        onClick: (event) => event.stopPropagation()
                      })
                    ]
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
                      onClick: (event) => {
                        if (onSelectRow) onSelectRow(ri, event.shiftKey)
                        if (onOpenRow && !event.shiftKey) onOpenRow(ri)
                      },
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
                            'data-cell': `${ri}:${ci}`,
                            tabIndex:
                              keyboardCell && keyboardCell.r === ri && keyboardCell.c === ci ? 0 : -1,
                            onFocus: () => setKeyboardCell({ r: ri, c: ci }),
                            className: cn(
                              TD,
                              isNumeric(value) && 'text-right tabular-nums',
                              isNull && 'italic text-(--ui-text-tertiary)',
                              editable && 'cursor-text hover:bg-(--chrome-action-hover)',
                              inSel(ri, ci) && 'dbd-selected',
                              sel && sel.r0 === ri && sel.c0 === ci && 'dbd-selected-anchor'
                            ),
                            style: columns[ci] && colWidths[columns[ci].name]
                              ? {
                                  width: colWidths[columns[ci].name],
                                  minWidth: colWidths[columns[ci].name],
                                  maxWidth: colWidths[columns[ci].name],
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis'
                                }
                              : undefined,
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
    if (kind !== 'json' || editor.value === null || editor.value === undefined) return
    try {
      setValue(JSON.stringify(JSON.parse(String(editor.value)), null, 2))
    } catch {
      /* keep the original text */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  if (kind === 'json') {
    return jsxs('div', {
      key: 'json-editor',
      className: 'fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4',
      children: [
        jsx('button', {
          key: 'bg',
          type: 'button',
          'aria-label': 'Cancel editing',
          className: 'absolute inset-0 cursor-default',
          onClick: onCancel
        }),
        jsxs('div', {
          key: 'panel',
          className:
            'relative flex max-h-[86vh] w-full max-w-[560px] flex-col gap-3 overflow-auto rounded-[6px] border border-(--ui-stroke-secondary) bg-background p-3 shadow-2xl',
          children: [
            jsxs('div', {
              key: 'head',
              className: 'flex items-center gap-2',
              children: [
                jsx(Codicon, {
                  key: 'i',
                  name: column.pk ? 'key' : 'json',
                  className: 'text-(--ui-text-tertiary)'
                }),
                jsx('span', {
                  key: 'n',
                  className: 'min-w-0 flex-1 truncate font-mono text-[12px] font-semibold',
                  children: column.name
                }),
                jsx('span', {
                  key: 't',
                  className: 'shrink-0 text-[10.5px] text-(--ui-text-tertiary)',
                  children: shortenType(column.type)
                }),
                jsx(Button, {
                  key: 'close',
                  variant: 'ghost',
                  size: 'icon-xs',
                  title: 'Close',
                  onClick: onCancel,
                  children: jsx(Codicon, { name: 'close' })
                })
              ]
            }),
            jsx('textarea', {
              key: 'input',
              autoFocus: true,
              spellCheck: false,
              rows: 16,
              value: isNull ? '' : value,
              disabled: isNull,
              className:
                'min-h-[260px] w-full resize-y rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[12px] leading-5 outline-none focus:border-primary/60 disabled:opacity-40',
              onChange: (event) => setValue(event.target.value),
              onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void commit()
                }
              }
            }),
            err
              ? jsx('div', {
                  key: 'err',
                  className: 'font-mono text-[10.5px] whitespace-pre-wrap text-destructive',
                  children: err
                })
              : null,
            jsxs('div', {
              key: 'actions',
              className: 'flex flex-wrap items-center gap-1.5',
              children: [
                jsx(Button, {
                  key: 'null',
                  variant: isNull ? 'default' : 'ghost',
                  size: 'xs',
                  onClick: () => setIsNull((current) => !current),
                  children: 'NULL'
                }),
                jsx(Button, {
                  key: 'format',
                  variant: 'ghost',
                  size: 'xs',
                  disabled: isNull,
                  onClick: () => {
                    try {
                      setValue(JSON.stringify(JSON.parse(value), null, 2))
                      setErr('')
                    } catch {
                      setErr('Invalid JSON')
                    }
                  },
                  children: 'Format'
                }),
                jsx('div', { key: 'sp', className: 'flex-1' }),
                jsx(Button, {
                  key: 'cancel',
                  variant: 'ghost',
                  size: 'xs',
                  onClick: onCancel,
                  children: 'Cancel'
                }),
                jsx(Button, {
                  key: 'save',
                  variant: 'default',
                  size: 'xs',
                  disabled: busy,
                  onClick: () => void commit(),
                  children: busy ? 'Preparing…' : 'Save'
                })
              ]
            })
          ]
        })
      ]
    })
  }

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
    className: 'absolute inset-0 z-40 flex justify-end',
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
    className: 'absolute inset-x-0 bottom-0 top-[44px] z-40 flex justify-end',
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
              jsx('div', { className: 'text-sm font-semibold', children: 'Record' }),
              jsx(Button, {
                variant: 'ghost',
                size: 'icon-xs',
                title: 'Close',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsx('div', {
            key: 'fields',
            className: 'flex flex-col gap-3',
            children: columns.map((column, index) => {
              const value = row[index]
              const text =
                value === null
                  ? 'NULL'
                  : typeof value === 'object'
                    ? JSON.stringify(value)
                    : String(value)
              return jsxs(
                'div',
                {
                  className: 'flex flex-col gap-1',
                  children: [
                    jsxs('div', {
                      key: 'label',
                      className: 'flex items-baseline justify-between gap-2',
                      children: [
                        jsx('span', {
                          className: 'text-[11px] font-medium text-(--ui-text-secondary)',
                          children: column.name
                        }),
                        jsx('span', {
                          className: 'text-[10px] font-mono text-(--ui-text-tertiary)',
                          children: column.type || ''
                        })
                      ]
                    }),
                    jsx('div', {
                      key: 'value',
                      className: cn(
                        'rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap',
                        value === null && 'italic text-(--ui-text-tertiary)'
                      ),
                      children: text
                    })
                  ]
                },
                column.name
              )
            })
          })
        ]
      })
    ]
  })
}

function RedisValueDrawer({ connectionId, database, redisKey, onClose }) {
  const [state, setState] = useState({ loading: true, value: null, type: '', ttl: -1, error: '' })
  useEffect(() => {
    let alive = true
    setState({ loading: true, value: null, type: '', ttl: -1, error: '' })
    call(
      `/connections/${connectionId}/redis/value?key=${encodeURIComponent(redisKey)}` +
        `&database=${encodeURIComponent(database || '')}`
    )
      .then((data) => {
        if (alive) setState({ loading: false, error: '', ...data })
      })
      .catch((error) => {
        if (alive) {
          setState({ loading: false, value: null, type: '', ttl: -1, error: errText(error) })
        }
      })
    return () => {
      alive = false
    }
  }, [connectionId, database, redisKey])
  const text =
    state.value === null || state.value === undefined
      ? '—'
      : typeof state.value === 'object'
        ? JSON.stringify(state.value, null, 2)
        : String(state.value)
  return jsxs('div', {
    className: 'absolute inset-x-0 bottom-0 top-[44px] z-40 flex justify-end',
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
            className: 'flex items-center justify-between gap-2',
            children: [
              jsx('div', {
                key: 't',
                className: 'truncate font-mono text-[12px] font-semibold',
                title: redisKey,
                children: redisKey
              }),
              jsx(Button, {
                key: 'close',
                variant: 'ghost',
                size: 'icon-xs',
                title: 'Close',
                onClick: onClose,
                children: jsx(Codicon, { name: 'close' })
              })
            ]
          }),
          jsxs('div', {
            key: 'meta',
            className: 'flex flex-wrap items-center gap-2 text-[11px]',
            children: [
              jsx(Badge, { key: 'type', variant: 'outline', size: 'xs', children: state.type || '…' }),
              jsx('span', {
                key: 'ttl',
                className: 'text-(--ui-text-tertiary)',
                children: state.ttl > 0 ? `expires in ${state.ttl}s` : 'no expiry'
              })
            ]
          }),
          state.loading
            ? jsx('div', {
                key: 'loading',
                className: 'text-[12px] text-(--ui-text-tertiary)',
                children: 'Loading…'
              })
            : state.error
              ? jsx('div', {
                  key: 'error',
                  className: 'text-[12px] text-red-600 dark:text-red-400',
                  children: state.error
                })
              : jsx('pre', {
                  key: 'value',
                  className:
                    'min-h-24 rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap',
                  children: text
                })
        ]
      })
    ]
  })
}

function ColumnsMenu({ columns, hidden, onToggle, showTypes = false, onToggleTypes }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
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
                  'absolute bottom-7 right-0 z-30 flex max-h-64 w-56 flex-col gap-0.5 overflow-auto rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                children: [
                  jsxs('label', {
                    key: 'types',
                    className:
                      'flex items-center gap-2 rounded-[3px] px-2 py-1 text-[11px] text-(--ui-text-secondary)',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: Boolean(showTypes),
                        onChange: () => onToggleTypes && onToggleTypes()
                      }),
                      jsx('span', { children: 'Show data types' })
                    ]
                  }),
                  jsx('div', {
                    key: 'sep',
                    className: 'mx-1 my-0.5 h-px bg-(--ui-stroke-secondary)'
                  }),
                  ...columns.map((column) =>
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
                ]
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

function QueriesDrawer({ connectionId, currentSql, onPick, onClose, initialTab = 'history' }) {
  const [tab, setTab] = useState(initialTab)
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
                    children: `${pending.length} pending · writes and agent actions`
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


const DB_LOGO_DATA = {"sqlserver":{"hex":"CC2927","path":"M12 2.2c-3.9 0-7 1.2-7 2.7v14.2c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V4.9c0-1.5-3.1-2.7-7-2.7zm0 1.8c3.2 0 5.2.8 5.2 1.3s-2 1.3-5.2 1.3-5.2-.8-5.2-1.3 2-1.3 5.2-1.3zm5.2 15.1c0 .5-2 1.3-5.2 1.3s-5.2-.8-5.2-1.3v-2.6c1.2.6 3.1.9 5.2.9s4-.3 5.2-.9zm0-4.7c0 .5-2 1.3-5.2 1.3s-5.2-.8-5.2-1.3v-2.6c1.2.6 3.1.9 5.2.9s4-.3 5.2-.9zm0-4.7c0 .5-2 1.3-5.2 1.3s-5.2-.8-5.2-1.3V6.9c1.2.6 3.1.9 5.2.9s4-.3 5.2-.9z"},"postgresql":{"hex":"4169E1","path":"M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z"},"mysql":{"hex":"4479A1","path":"M16.405 5.501c-.115 0-.193.014-.274.033v.013h.014c.054.104.146.18.214.273.054.107.1.214.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.695h-.927a50.854 50.854 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.892 72.892 0 00-.195 4.41H0c.055-1.966.192-3.81.41-5.53h1.15l1.335 4.064h.008l1.347-4.064h1.095c.242 2.015.384 3.86.428 5.53zm4.017-4.08c-.378 2.045-.876 3.533-1.492 4.46-.482.716-1.01 1.073-1.583 1.073-.153 0-.34-.046-.566-.138v-.494c.11.017.24.026.386.026.268 0 .483-.075.647-.222.197-.18.295-.382.295-.605 0-.155-.077-.47-.23-.944L6.23 14.615h.91l.727 2.36c.164.536.233.91.205 1.123.4-1.064.678-2.227.835-3.483zm12.325 4.08h-2.63v-5.53h.885v4.85h1.745zm-3.32.135l-1.016-.5c.09-.076.177-.158.255-.25.433-.506.648-1.258.648-2.253 0-1.83-.718-2.746-2.155-2.746-.704 0-1.254.232-1.65.697-.43.508-.646 1.256-.646 2.245 0 .972.19 1.686.574 2.14.35.41.877.615 1.583.615.264 0 .506-.033.725-.098l1.325.772.36-.622zM15.5 17.588c-.225-.36-.337-.94-.337-1.736 0-1.393.424-2.09 1.27-2.09.443 0 .77.167.977.5.224.362.336.936.336 1.723 0 1.404-.424 2.108-1.27 2.108-.445 0-.77-.167-.978-.5zm-1.658-.425c0 .47-.172.856-.516 1.156-.344.3-.803.45-1.384.45-.543 0-1.064-.172-1.573-.515l.237-.476c.438.22.833.328 1.19.328.332 0 .593-.073.783-.22a.754.754 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.163-.657-1.163-.657-.422-.307-.632-.636-.632-1.177 0-.45.157-.81.47-1.085.315-.278.72-.415 1.22-.415.512 0 .98.136 1.4.41l-.213.476a2.726 2.726 0 00-1.064-.23c-.283 0-.502.068-.654.206a.685.685 0 00-.248.524c0 .328.234.61.666.85.393.215 1.187.67 1.187.67.433.305.648.63.648 1.168zm9.382-5.852c-.535-.014-.95.04-1.297.188-.1.04-.26.04-.274.167.055.053.063.14.11.214.08.134.218.313.346.407.14.11.28.216.427.31.26.16.555.255.81.416.145.094.293.213.44.313.073.05.12.14.214.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.223 3.223 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.227-.06.435-.047.67-.106.106-.027.213-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.867 8.867 0 00-1.104-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.163c-.12-.262-.193-.523-.34-.763-.69-1.137-1.437-1.826-2.586-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.364-.76-1.644-.072-.18.434.267.862.422 1.082.115.153.26.328.34.5.047.116.06.235.107.356.106.294.207.622.347.897.073.14.153.287.247.413.054.073.146.107.167.227-.094.136-.1.334-.154.5-.24.757-.146 1.693.194 2.25.107.166.362.534.703.393.3-.12.234-.5.32-.835.02-.08.007-.133.048-.187v.015c.094.188.188.367.274.555.206.328.566.668.867.895.16.12.287.328.487.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.445 3.445 0 01-.35-.4 8.76 8.76 0 01-.747-1.218c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.146-.247.273-.32.453-.127.288-.14.642-.188 1.01-.027.007-.014 0-.027.014-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.238-.06-1.785.047-.14.247-.582.167-.716-.042-.127-.174-.2-.247-.303a2.478 2.478 0 01-.24-.427c-.16-.374-.24-.788-.414-1.162-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.014-.054.042-.075.094-.09.088-.072.335.022.422.062.247.1.455.194.662.334.094.066.195.193.315.226h.14c.214.047.455.014.655.073.355.114.675.28.962.46a5.953 5.953 0 012.085 2.286c.08.154.115.295.188.455.14.33.313.663.455.982.14.315.275.636.476.897.1.14.502.213.682.286.133.06.34.115.46.188.23.14.454.3.67.454.11.076.443.243.463.378z"},"mariadb":{"hex":"003545","path":"M23.157 4.412c-.676.284-.79.31-1.673.372-.65.045-.757.057-1.212.209-.75.246-1.395.75-2.02 1.59-.296.398-1.249 1.913-1.249 1.988 0 .057-.65.998-.915 1.32-.574.713-1.08 1.079-2.14 1.59-.77.36-1.224.524-4.102 1.477-1.073.353-2.133.738-2.367.864-.852.449-1.515 1.036-2.203 1.938-1.003 1.32-.972 1.313-3.042.947a12.264 12.264 0 00-.675-.063c-.644-.05-1.023.044-1.332.334L0 17.193l.177.088c.094.05.353.234.561.398.215.17.461.347.55.391.088.044.17.088.183.101.012.013-.089.17-.228.353-.435.581-.593.871-.574 1.048.019.164.032.17.43.17.517-.006.826-.056 1.261-.208.65-.233 2.058-.94 2.784-1.4.776-.5 1.717-.998 1.956-1.042.082-.02.354-.07.594-.114.58-.107 1.464-.095 2.587.05.108.013.373.045.6.064.227.025.43.057.454.076.026.012.474.037.998.056.934.026 1.104.007 1.3-.189.126-.133.385-.631.498-.985.209-.643.417-.921.366-.492-.113.966-.322 1.692-.713 2.411-.259.499-.663 1.092-.934 1.395-.322.347-.315.36.088.315.619-.063 1.471-.397 2.096-.82.827-.562 1.647-1.691 2.19-3.03.107-.27.22-.22.183.083-.013.094-.038.315-.057.498l-.031.328.353-.202c.833-.48 1.414-1.262 2.127-2.884.227-.518.877-2.922 1.073-3.976a9.64 9.64 0 01.271-1.042c.127-.429.196-.555.48-.858.183-.19.625-.555.978-.808.72-.505.953-.75 1.187-1.205.208-.417.284-1.13.132-1.357-.132-.202-.284-.196-.763.006Z"},"clickhouse":{"hex":"FFCC01","path":"M21.333 10H24v4h-2.667ZM16 1.335h2.667v21.33H16Zm-5.333 0h2.666v21.33h-2.666ZM0 22.665V1.335h2.667v21.33zm5.333-21.33H8v21.33H5.333Z"},"sqlite":{"hex":"003B57","path":"M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z"},"mongodb":{"hex":"47A248","path":"M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"},"redis":{"hex":"FF4438","path":"M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z"}}

function DatabaseLogo({ kind, flavor, size = 22 }) {
  const key =
    flavor === 'mariadb'
      ? 'mariadb'
      : String(kind || '').toLowerCase() === 'postgres'
        ? 'postgresql'
        : String(kind || '').toLowerCase()
  const logo = DB_LOGO_DATA[key]
  if (!logo) {
    return jsx(Codicon, {
      name: kind === 'http' ? 'cloud' : kind === 'mcp' ? 'plug' : 'database',
      className: 'text-(--ui-text-secondary)'
    })
  }
  return jsx('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: `#${logo.hex}`,
    'aria-hidden': 'true',
    className: 'shrink-0',
    children: jsx('path', { d: logo.path })
  })
}

// The cloud warehouses are reached over HTTPS with a signed request, so each one needs a
// couple of settings the generic host/port/user fields cannot carry.
const CLOUD_OPTIONS = {
  athena: {
    hint: 'Region, and the S3 prefix Athena writes every result set to.',
    placeholder: '{"region": "ap-southeast-1", "output": "s3://my-bucket/athena/"}'
  },
  dynamodb: {
    hint: 'Region. Add "endpoint" for DynamoDB Local or a VPC endpoint.',
    placeholder: '{"region": "ap-southeast-1"}'
  },
  bigquery: {
    hint: 'Project and dataset. The user is the service-account e-mail, the password its PEM key.',
    placeholder: '{"project": "my-project", "dataset": "demo"}'
  },
  snowflake: {
    hint: 'Warehouse, role and schema. The host is your account URL.',
    placeholder: '{"warehouse": "COMPUTE_WH", "role": "SYSADMIN", "schema": "PUBLIC"}'
  }
};

// An overlay is only a dialog for a keyboard user if focus goes into it, stays in it while it
// is open, and comes back to the control that opened it. Kept inline because this file is
// copied verbatim into the Hermes plugin, where a sibling import would not exist.
const DIALOG_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function useDialogFocus(containerRef, active) {
  useEffect(() => {
    if (!active) return undefined
    const node = containerRef.current
    if (!node) return undefined
    const previous = document.activeElement
    const focusable = () =>
      Array.from(node.querySelectorAll(DIALOG_FOCUSABLE)).filter(
        (element) => element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0
      )
    const target =
      node.querySelector('[data-autofocus]') ||
      focusable().find((element) => element.matches('input, textarea, select')) ||
      focusable()[0] ||
      node
    if (target && typeof target.focus === 'function') {
      if (target === node && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1')
      target.focus()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const index = items.indexOf(document.activeElement)
      const last = items.length - 1
      if (event.shiftKey && index <= 0) {
        event.preventDefault()
        items[last].focus()
      } else if (!event.shiftKey && (index === -1 || index === last)) {
        event.preventDefault()
        items[0].focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus()
    }
  }, [active, containerRef])
}

const DB_KIND_CARDS = [
  { kind: 'postgres', label: 'PostgreSQL', port: 5432 },
  { kind: 'redshift', label: 'Amazon Redshift', port: 5439 },
  { kind: 'cockroachdb', label: 'CockroachDB', port: 26257 },
  { kind: 'greenplum', label: 'Greenplum', port: 5432 },
  { kind: 'mysql', flavor: 'mysql', label: 'MySQL', port: 3306 },
  { kind: 'mysql', flavor: 'mariadb', label: 'MariaDB', port: 3306 },
  { kind: 'singlestore', label: 'SingleStore', port: 3306 },
  { kind: 'sqlserver', label: 'SQL Server', port: 1433 },
  { kind: 'clickhouse', label: 'ClickHouse', port: 8123 },
  { kind: 'mongodb', label: 'MongoDB', port: 27017 },
  { kind: 'redis', label: 'Redis', port: 6379 },
  { kind: 'sqlite', label: 'SQLite', port: 0 },
  { kind: 'duckdb', label: 'DuckDB', port: 0 },
  { kind: 'elasticsearch', label: 'Elasticsearch', port: 9200 },
  { kind: 'influxdb3', label: 'InfluxDB 3', port: 8181 },
  { kind: 'libsql', label: 'libSQL', port: 443 },
  { kind: 'd1', label: 'Cloudflare D1', port: 443 },
  { kind: 'oracle', label: 'Oracle', port: 1521 },
  { kind: 'vertica', label: 'Vertica', port: 5433 },
  { kind: 'cassandra', label: 'Cassandra', port: 9042 },
  { kind: 'athena', label: 'Amazon Athena', port: 443 },
  { kind: 'dynamodb', label: 'DynamoDB', port: 443 },
  { kind: 'bigquery', label: 'BigQuery', port: 443 },
  { kind: 'snowflake', label: 'Snowflake', port: 443 },
  { kind: 'mcp', label: 'MCP', port: 0 },
  { kind: 'http', label: 'HTTP', port: 0 }
]

function ConnectionDrawer({ draft, onDraft, onClose, onSaved, onDeleted }) {
  const [busy, setBusy] = useState('')
  const [test, setTest] = useState(null)
  const [err, setErr] = useState('')
  const [mcpStatus, setMcpStatus] = useState(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpInspect, setMcpInspect] = useState(null)
  const [mcpDetecting, setMcpDetecting] = useState(false)
  const standalone = Boolean(globalThis.__DBDESK_STANDALONE__)
  const editing = Boolean(draft.id)
  const inspectedTool =
    mcpInspect && mcpInspect.tools
      ? mcpInspect.tools.find((tool) => tool.name === draft.mcp_tool)
      : null
  const sqlArgOptions =
    inspectedTool && inspectedTool.properties && inspectedTool.properties.length
      ? inspectedTool.properties
      : ['sql', 'query', 'statement']

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

  useEffect(() => {
    setMcpInspect(null)
  }, [draft.mcp_url])

  const detectMcp = async () => {
    const url = String(draft.mcp_url || '').trim()
    if (!url) return
    setMcpDetecting(true)
    setErr('')
    try {
      const result = await call('/mcp/inspect', { method: 'POST', body: { url } })
      setMcpInspect(result)
      const suggested = result.suggested || {}
      onDraft({
        ...draft,
        mcp_tool: suggested.name || draft.mcp_tool || 'query',
        mcp_sql_arg: suggested.sql_arg || draft.mcp_sql_arg || 'sql',
        mcp_dialect: suggested.dialect || draft.mcp_dialect || 'postgres',
        dbname: suggested.database || draft.dbname
      })
    } catch (error) {
      setErr(errText(error))
    } finally {
      setMcpDetecting(false)
    }
  }

  const chooseMcpTool = (name) => {
    const found = mcpInspect && mcpInspect.tools
      ? mcpInspect.tools.find((tool) => tool.name === name)
      : null
    onDraft({
      ...draft,
      mcp_tool: name,
      ...(found
        ? {
            mcp_sql_arg: found.sql_arg || draft.mcp_sql_arg || 'sql',
            mcp_dialect: found.dialect || draft.mcp_dialect || 'postgres',
            dbname: found.database || draft.dbname
          }
        : {})
    })
  }

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
      const { _draftId, ...body } = draft
      const result = await call('/connections', { method: 'POST', body })
      if (_draftId) {
        try {
          await call(`/connection-drafts/${_draftId}/applied`, { method: 'POST' })
        } catch {
          /* the draft can stay pending; saving the connection already succeeded */
        }
      }
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
              jsxs('div', {
                className: 'flex min-w-0 items-center gap-2',
                children: [
                  jsx(DatabaseLogo, {
                    kind: draft.kind || 'postgres',
                    flavor: draft.flavor,
                    size: 18
                  }),
                  jsx('div', {
                    className: 'text-sm font-semibold',
                    children: editing ? 'Edit connection' : 'New connection'
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
            key: 'name',
            className: 'flex flex-col gap-3',
            children: [
              jsxs('div', {
                key: 'kind',
                className: 'flex flex-col gap-1.5',
                children: [
                  jsx('div', {
                    className:
                      'text-[11px] font-medium text-(--ui-text-secondary)',
                    children: 'Type'
                  }),
                  jsx('div', {
                    className: 'grid grid-cols-3 gap-1.5',
                    children: DB_KIND_CARDS.filter(
                      (card) => card.kind !== 'mcp' || !globalThis.__DBDESK_NO_MCP__
                    ).map((card) => {
                      const activeFlavor =
                        (draft.kind || 'postgres') === 'mysql'
                          ? draft.flavor || 'mysql'
                          : ''
                      const selected =
                        (draft.kind || 'postgres') === card.kind &&
                        (card.kind !== 'mysql' || activeFlavor === card.flavor)
                      return jsxs(
                        'button',
                        {
                          type: 'button',
                          onClick: () => {
                            const defaults = {
                              postgres: 5432,
                              mysql: 3306,
                              clickhouse: 8123,
                              mongodb: 27017,
                              redis: 6379,
                              mcp: 0,
                              http: 0,
                              sqlite: 0
                            }
                            const oldDefault = defaults[draft.kind || 'postgres']
                            const current = Number(draft.port)
                            const nextPort =
                              !draft.port ||
                              current === oldDefault ||
                              [5432, 3306, 8123, 27017, 6379].includes(current)
                                ? card.port
                                : draft.port
                            onDraft({
                              ...draft,
                              kind: card.kind,
                              flavor: card.flavor || '',
                              port: nextPort
                            })
                          },
                          className: cn(
                            'flex flex-col items-center gap-1 rounded-[5px] border px-1 py-2 text-[10px]',
                            selected
                              ? 'border-primary bg-primary/5 text-(--ui-text-primary)'
                              : 'border-(--ui-stroke-secondary) text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)'
                          ),
                          children: [
                            jsx(DatabaseLogo, {
                              kind: card.kind,
                              flavor: card.flavor,
                              size: 24
                            }),
                            jsx('span', {
                              className: 'truncate',
                              children: card.label
                            })
                          ]
                        },
                        `${card.kind}:${card.flavor || ''}`
                      )
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
                  placeholder:
                    (draft.kind || 'postgres') === 'mongodb'
                      ? 'Local MongoDB'
                      : (draft.kind || 'postgres') === 'redis'
                        ? 'Local Redis'
                        : 'Local Postgres',
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
                              jsx(Button, {
                                variant: 'secondary',
                                size: 'sm',
                                disabled: mcpDetecting || !draft.mcp_url,
                                onClick: detectMcp,
                                children: mcpDetecting ? 'Detecting…' : 'Detect tools'
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
                      mcpInspect
                        ? jsxs('div', {
                            key: 'detected',
                            className:
                              'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                            children: [
                              jsx('div', {
                                key: 'summary',
                                className: 'text-[11px] text-(--ui-text-tertiary)',
                                children: `${mcpInspect.tool_count} tools · ${mcpInspect.query_tools.length} SQL candidate${
                                  mcpInspect.query_tools.length === 1 ? '' : 's'
                                }`
                              }),
                              mcpInspect.query_tools.length
                                ? jsx(Field, {
                                    key: 'pick',
                                    label: 'Detected query tools',
                                    hint: 'Pick the tool that runs SQL; the name usually tells you the database.',
                                    children: jsxs('select', {
                                      className:
                                        'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                                      value: draft.mcp_tool || '',
                                      onChange: (event) => chooseMcpTool(event.target.value),
                                      children: [
                                        jsx('option', { value: '', children: '— pick a tool —' }, ''),
                                        ...mcpInspect.query_tools.map((tool) =>
                                          jsx(
                                            'option',
                                            {
                                              value: tool.name,
                                              children: `${tool.name}${
                                                tool.database ? ` · ${tool.database}` : ''
                                              }${tool.dialect ? ` · ${tool.dialect}` : ''}`
                                            },
                                            tool.name
                                          )
                                        )
                                      ]
                                    })
                                  })
                                : jsx('div', {
                                    key: 'none',
                                    className: 'text-[11px] text-(--ui-text-tertiary)',
                                    children:
                                      'No obvious SQL tool detected; type the tool name manually.'
                                  })
                            ]
                          })
                        : null,
                      jsxs('div', {
                        key: 'tool',
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            label: 'Query tool',
                            hint: 'Often ends with _query. Use Detect tools to list them.',
                            children: jsxs('div', {
                              className: 'flex flex-col gap-1',
                              children: [
                                jsx(Input, {
                                  value: draft.mcp_tool || 'query',
                                  placeholder: 'query',
                                  list: 'mcp-tool-names',
                                  onChange: (event) => chooseMcpTool(event.target.value)
                                }),
                                jsx('datalist', {
                                  id: 'mcp-tool-names',
                                  children: (mcpInspect && mcpInspect.tools
                                    ? mcpInspect.tools
                                    : []
                                  ).map((tool) =>
                                    jsx(
                                      'option',
                                      { value: tool.name, label: tool.description },
                                      tool.name
                                    )
                                  )
                                })
                              ]
                            })
                          }),
                          jsx(Field, {
                            label: 'SQL argument',
                            children: jsxs('div', {
                              className: 'flex flex-col gap-1',
                              children: [
                                jsx(Input, {
                                  value: draft.mcp_sql_arg || 'sql',
                                  placeholder: 'sql',
                                  list: 'mcp-sql-args',
                                  onChange: set('mcp_sql_arg')
                                }),
                                jsx('datalist', {
                                  id: 'mcp-sql-args',
                                  children: sqlArgOptions.map((name) =>
                                    jsx('option', { value: name }, name)
                                  )
                                })
                              ]
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
                      hint:
                        (draft.kind || 'postgres') === 'clickhouse'
                          ? 'Hostname or https:// URL. For Cloudflare use port 443 and SSL require.'
                          : undefined,
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
                    label:
                      (draft.kind || 'postgres') === 'sqlite'
                        ? 'Database file'
                        : (draft.kind || 'postgres') === 'mcp'
                          ? 'Database label'
                          : 'Database',
                    hint:
                      (draft.kind || 'postgres') === 'sqlite'
                        ? 'Absolute path to the .db/.sqlite file on the machine running Hermes.'
                        : (draft.kind || 'postgres') === 'mcp'
                          ? 'Display name only. The chosen tool determines the real database; if the tool needs a database argument, add it to Extra arguments.'
                          : undefined,
                    children: jsx(Input, {
                      value: draft.dbname || '',
                      placeholder:
                        (draft.kind || 'postgres') === 'sqlite'
                          ? '/root/data/app.db'
                          : (draft.kind || 'postgres') === 'mongodb'
                            ? 'mydb'
                            : (draft.kind || 'postgres') === 'redis'
                              ? '0'
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
              draft._draftId
                ? jsx('div', {
                    className:
                      'rounded-[3px] border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-(--ui-text-secondary)',
                    children:
                      'Drafted by the agent. Type the password here — it is never sent to the AI provider.'
                  })
                : null,
              (draft.kind || 'postgres') === 'mongodb'
                ? jsxs('div', {
                    key: 'mongo',
                    className: 'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                    children: [
                      jsx('div', {
                        key: 't',
                        className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
                        children: 'MongoDB options'
                      }),
                      jsxs('label', {
                        key: 'srv',
                        className: 'flex items-center gap-2 text-[11px]',
                        children: [
                          jsx('input', {
                            type: 'checkbox',
                            checked: Boolean(draft.mongo_srv),
                            onChange: (event) =>
                              onDraft({ ...draft, mongo_srv: event.target.checked }),
                          }),
                          jsx('span', {
                            children: 'SRV record (mongodb+srv:// host, no port)'
                          })
                        ]
                      }),
                      jsx(Field, {
                        key: 'auth',
                        label: 'Auth source',
                        hint: 'Database that holds the user (admin by default).',
                        children: jsx(Input, {
                          value: draft.auth_source || 'admin',
                          placeholder: 'admin',
                          onChange: set('auth_source')
                        })
                      })
                    ]
                  })
                : null,
              (draft.kind || 'postgres') === 'redis'
                ? jsx(Field, {
                    key: 'redisdb',
                    label: 'Redis database',
                    hint: 'Logical database index, 0–15 by default.',
                    children: jsx(Input, {
                      type: 'number',
                      value: draft.redis_db || 0,
                      onChange: set('redis_db')
                    })
                  })
                : null,
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
              (draft.kind || 'postgres') === 'sqlserver'
                ? jsx(Field, {
                    key: 'ms-encryption',
                    label: 'Encryption',
                    hint: 'Azure SQL needs require. default lets the driver negotiate.',
                    children: jsxs('select', {
                      className:
                        'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                      value: draft.encryption || 'default',
                      onChange: set('encryption'),
                      children: ['default', 'off', 'request', 'require'].map((mode) =>
                        jsx('option', { value: mode, children: mode }, mode)
                      )
                    })
                  })
                : null,
              !['mysql', 'mcp', 'http', 'sqlite', 'sqlserver',
                'athena', 'dynamodb', 'bigquery', 'snowflake'].includes(draft.kind || 'postgres')
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
              CLOUD_OPTIONS[draft.kind || 'postgres']
                ? jsx(Field, {
                    key: 'engine-options',
                    label: 'Options (JSON)',
                    hint: CLOUD_OPTIONS[draft.kind || 'postgres'].hint,
                    children: jsx(Input, {
                      value: draft.options || '',
                      placeholder: CLOUD_OPTIONS[draft.kind || 'postgres'].placeholder,
                      onChange: set('options')
                    })
                  })
                : null,
              (draft.kind || 'postgres') === 'clickhouse'
                ? jsxs('div', {
                    key: 'ch-http',
                    className:
                      'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                    children: [
                      jsx('div', {
                        key: 't',
                        className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
                        children: 'ClickHouse HTTP interface'
                      }),
                      jsx(Field, {
                        key: 'path',
                        label: 'HTTP path',
                        hint: 'Use / unless the endpoint is mounted on a subpath.',
                        children: jsx(Input, {
                          value: draft.ch_path || '/',
                          placeholder: '/',
                          onChange: set('ch_path')
                        })
                      }),
                      jsx(Field, {
                        key: 'headers',
                        label: 'Custom HTTP headers',
                        hint: draft.ch_headers_set
                          ? 'Typing new lines replaces the saved set. Leave blank to keep it.'
                          : 'One Name: value per line. Stored encrypted, e.g. Cloudflare Access.',
                        children: jsx('textarea', {
                          value: draft.ch_headers || '',
                          rows: 3,
                          placeholder:
                            'CF-Access-Client-Id: ...\nCF-Access-Client-Secret: ...',
                          className:
                            'w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[11px] outline-none focus:border-primary/60',
                          onChange: set('ch_headers')
                        })
                      }),
                      draft.ch_headers_set && (draft.ch_header_names || []).length
                        ? jsxs('div', {
                            key: 'saved-names',
                            className: 'flex flex-wrap items-center gap-1 text-[10px] text-(--ui-text-tertiary)',
                            children: [
                              jsx('span', { key: 'l', children: 'Saved:' }),
                              ...(draft.ch_header_names || []).map((name) =>
                                jsx(
                                  'span',
                                  {
                                    className:
                                      'rounded-[3px] border border-(--ui-stroke-secondary) px-1 py-0.5 font-mono',
                                    children: name
                                  },
                                  name
                                )
                              )
                            ]
                          })
                        : null,
                      draft.ch_headers_set
                        ? jsxs('label', {
                            key: 'clear',
                            className:
                              'flex items-center gap-2 text-[10.5px] text-(--ui-text-tertiary)',
                            children: [
                              jsx('input', {
                                type: 'checkbox',
                                checked: Boolean(draft.ch_headers_clear),
                                onChange: (event) =>
                                  onDraft({ ...draft, ch_headers_clear: event.target.checked })
                              }),
                              jsx('span', { children: 'Remove saved headers' })
                            ]
                          })
                        : null
                    ]
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
              !['mcp', 'http', 'redis'].includes(draft.kind || 'postgres')
                ? jsxs('div', {
                    key: 'decrypt',
                    className:
                      'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                    children: [
                      jsx('div', {
                        key: 't',
                        className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
                        children: 'Encrypted columns (optional)'
                      }),
                      jsx(Field, {
                        key: 'columns',
                        label: 'Columns',
                        hint: 'Comma-separated names, or * for every text column.',
                        children: jsx(Input, {
                          value: draft.decrypt_columns || '',
                          placeholder: 'account_number, card_no',
                          onChange: set('decrypt_columns')
                        })
                      }),
                      jsxs('div', {
                        key: 'keyrow',
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            key: 'key',
                            label: 'Key',
                            hint: draft.decrypt_key_set
                              ? 'A key is saved. Leave blank to keep it.'
                              : 'Raw 32-byte key, base64: Laravel APP_KEY, or passphrase.',
                            children: jsx(Input, {
                              type: 'password',
                              value: draft.decrypt_key || '',
                              placeholder: draft.decrypt_key_set ? '••••••••' : '',
                              onChange: set('decrypt_key')
                            })
                          }),
                          jsx(Field, {
                            key: 'algo',
                            label: 'Algorithm',
                            children: jsxs('select', {
                              className:
                                'h-8 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-xs outline-none',
                              value: draft.decrypt_algo || 'auto',
                              onChange: set('decrypt_algo'),
                              children: [
                                jsx('option', { value: 'auto', children: 'Auto' }, 'auto'),
                                jsx('option', { value: 'aes-256-gcm', children: 'AES-256-GCM' }, 'aes-256-gcm'),
                                jsx('option', { value: 'aes-256-cbc', children: 'AES-256-CBC' }, 'aes-256-cbc')
                              ]
                            })
                          })
                        ]
                      }),
                      draft.decrypt_key_set
                        ? jsxs('label', {
                            key: 'clear',
                            className:
                              'flex items-center gap-2 text-[10.5px] text-(--ui-text-tertiary)',
                            children: [
                              jsx('input', {
                                type: 'checkbox',
                                checked: Boolean(draft.decrypt_key_clear),
                                onChange: (event) =>
                                  onDraft({ ...draft, decrypt_key_clear: event.target.checked })
                              }),
                              jsx('span', { children: 'Remove the saved decryption key' })
                            ]
                          })
                        : null
                    ]
                  })
                : null,
              !['mcp', 'http', 'redis'].includes(draft.kind || 'postgres')
                ? jsxs('div', {
                    key: 'timezone',
                    className:
                      'flex flex-col gap-2 rounded-[3px] border border-(--ui-stroke-secondary)/60 p-2',
                    children: [
                      jsx('div', {
                        key: 't',
                        className: 'text-[11px] font-medium text-(--ui-text-tertiary)',
                        children: 'Timezone'
                      }),
                      jsxs('div', {
                        key: 'zones',
                        className: 'dbd-grid-2',
                        children: [
                          jsx(Field, {
                            key: 'display',
                            label: 'Display timezone',
                            hint: 'IANA name. Empty shows raw database values.',
                            children: jsx(Input, {
                              value: draft.display_tz || '',
                              placeholder: 'Asia/Kuala_Lumpur',
                              onChange: set('display_tz')
                            })
                          }),
                          jsx(Field, {
                            key: 'storage',
                            label: 'Naive timestamps stored in',
                            hint: 'UTC by default.',
                            children: jsx(Input, {
                              value: draft.storage_tz || '',
                              placeholder: 'UTC',
                              onChange: set('storage_tz')
                            })
                          })
                        ]
                      })
                    ]
                  })
                : null,
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
              }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-xs',
                children: [
                  jsx('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: draft.ai_schema !== false,
                    onChange: (event) =>
                      onDraft({ ...draft, ai_schema: event.target.checked })
                  }),
                  jsx('span', {
                    key: 't',
                    children: 'AI can see this schema and let the agent inspect it'
                  })
                ]
              }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-xs',
                children: [
                  jsx('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: draft.ai_query !== false,
                    onChange: (event) =>
                      onDraft({ ...draft, ai_query: event.target.checked })
                  }),
                  jsx('span', {
                    key: 't',
                    children: 'AI can run read-only queries (turn off for inspect-only)'
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
    encryption: 'default',
    readonly: true,
    production: false,
    ai_schema: true,
    ai_query: true,
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
    tunnel_timeout: 25,
    flavor: '',
    ch_path: '/',
    ch_headers: '',
    ch_headers_set: false,
    ch_headers_clear: false
  }
}

function AiPanel({ connectionId, database, schema, table, onClose, onUseSql }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState([])
  const [config, setConfig] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState([])
  const [detecting, setDetecting] = useState(false)
  const [aiComplete, setAiComplete] = useState(true)
  const [customModel, setCustomModel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState([])
  const [scope, setScope] = useState([])
  const [scopeOpen, setScopeOpen] = useState(false)
  const endRef = useRef(null)

  useEffect(() => {
    call('/ai/config')
      .then((value) => {
        setConfig(value)
        setBaseUrl(value.base_url || '')
        setModel(value.model || '')
        setAiComplete(Boolean(value.ai_complete))
        if (!value.configured) setSettingsOpen(true)
      })
      .catch(() => {})
  }, [])

  const detectModels = async () => {
    setDetecting(true)
    setError('')
    try {
      const value = await call('/ai/models', {
        method: 'POST',
        body: { base_url: baseUrl, api_key: apiKey }
      })
      const list = (value && value.models) || []
      setModels(list)
      setCustomModel(list.length === 0)
      if (list.length === 1) setModel(list[0])
      if (list.length === 0) setError('The provider returned no models')
    } catch (reason) {
      setError(errText(reason))
    } finally {
      setDetecting(false)
    }
  }

  useEffect(() => {
    call('/ai/catalog')
      .then((value) => {
        const entries = (value && value.connections) || []
        setCatalog(entries)
        setScope((current) => (current.length ? current : entries.map((entry) => entry.id)))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setMessages([])
    setPrompt('')
    setError('')
  }, [connectionId, schema, table])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const toggleScope = (id) => {
    setScope((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    )
  }

  const ask = async () => {
    const question = prompt.trim()
    if (!question || busy) return
    if (config && !config.configured) {
      setSettingsOpen(true)
      return
    }
    if (!scope.length) {
      setError('Pick at least one AI-enabled database in the scope bar.')
      return
    }
    const history = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map((message) => ({
        role: message.role,
        content:
          message.role === 'user'
            ? message.text
            : JSON.stringify({
                sql:
                  message.sql ||
                  (message.sources && message.sources[0] && message.sources[0].sql) ||
                  '',
                explanation: message.explanation
              })
      }))
    setMessages((current) => [...current, { role: 'user', text: question }])
    setPrompt('')
    setBusy(true)
    setError('')
    try {
      const value = await call('/ai/agent', {
        method: 'POST',
        body: {
          connection_id: connectionId,
          connection_ids: scope,
          database,
          schema: schema || '',
          table: table || '',
          question,
          history,
          execute: true
        }
      })
      setMessages((current) => [...current, { role: 'assistant', ...value }])
    } catch (reason) {
      setMessages((current) => [...current, { role: 'error', text: errText(reason) }])
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
        body: { base_url: baseUrl, model, api_key: apiKey, ai_complete: aiComplete }
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

  const sourceBlock = (source, index) =>
    jsxs('div', {
      key: `src-${index}`,
      className: 'flex flex-col gap-1.5 rounded-[6px] border border-(--ui-stroke-secondary) p-2',
      children: [
        jsxs('div', {
          key: 'head',
          className: 'flex items-center gap-1.5 text-[10.5px] text-(--ui-text-tertiary)',
          children: [
            jsx(Codicon, { key: 'i', name: 'database' }),
            jsx('span', {
              key: 'n',
              className: 'truncate font-medium text-(--ui-text-secondary)',
              children: source.name
            }),
            jsx('span', { key: 'k', children: source.kind }),
            jsx('span', { key: 'r', className: 'ml-auto', children: `${source.rows || 0} row(s)` })
          ]
        }),
        jsx('pre', {
          key: 'sql',
          className:
            'overflow-auto rounded-[5px] bg-(--ui-bg-secondary) p-2 font-mono text-[10.5px] leading-5 whitespace-pre-wrap',
          children: source.sql
        }),
        jsxs('div', {
          key: 'acts',
          className: 'flex items-center gap-1',
          children: [
            jsx(Button, {
              key: 'copy',
              variant: 'ghost',
              size: 'xs',
              onClick: () => void writeClipboardText(source.sql),
              children: jsxs('span', {
                className: 'flex items-center gap-1',
                children: [jsx(Codicon, { name: 'copy' }), 'Copy SQL']
              })
            }),
            source.connection === connectionId
              ? jsx(Button, {
                  key: 'open',
                  variant: 'ghost',
                  size: 'xs',
                  onClick: () => onUseSql(source.sql),
                  children: jsxs('span', {
                    className: 'flex items-center gap-1',
                    children: [jsx(Codicon, { name: 'go-to-file' }), 'Open in SQL']
                  })
                })
              : null
          ]
        })
      ]
    })

  const resultTable = (message) => {
    if (!message.columns || !message.rows || !message.rows.length) return null
    return jsxs('div', {
      key: 'grid',
      className: 'max-h-56 overflow-auto rounded-[6px] border border-(--ui-stroke-secondary)',
      children: [
        jsx('table', {
          key: 't',
          className: 'dbd-grid-table dbd-mono min-w-full',
          children: [
            jsx('thead', {
              key: 'h',
              children: jsx('tr', {
                children: message.columns.map((column) =>
                  jsx('th', { children: column.name }, column.name)
                )
              })
            }),
            jsx('tbody', {
              key: 'b',
              children: message.rows.slice(0, 100).map((row, rowIndex) =>
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
                  rowIndex
                )
              )
            })
          ]
        })
      ]
    })
  }

  const assistantTurn = (message, index) => {
    const sources = message.sources || []
    const primary = message.sql || (sources[0] ? sources[0].sql : '')
    if (!primary && !sources.length) {
      return jsx(
        'div',
        {
          key: `a-${index}`,
          className: 'text-[12.5px] leading-relaxed whitespace-pre-wrap',
          children: message.explanation || ''
        },
        `a-${index}`
      )
    }
    const ms = message.elapsed_ms || message.duration_ms || 0
    const thought = [`Thought · ${ms} ms`]
    if (sources.length > 1) thought.push(`${sources.length} databases`)
    if (message.join_ms) thought.push(`joined in ${message.join_ms} ms`)
    return jsxs('div', {
      key: `a-${index}`,
      className: 'flex flex-col gap-2 pb-1',
      children: [
        jsxs('div', {
          key: 'thought',
          className: 'flex items-center gap-1.5 text-[11px] text-(--ui-text-tertiary)',
          children: [
            jsx(Codicon, { key: 'i', name: 'sparkle' }),
            jsx('span', {
              key: 't',
              children: thought.join(' · ') + (message.retried ? ' · corrected' : '')
            })
          ]
        }),
        jsx('div', {
          key: 'text',
          className: 'text-[12.5px] leading-relaxed whitespace-pre-wrap',
          children: message.explanation || 'Result'
        }),
        ...(sources.length
          ? sources.map(sourceBlock)
          : [
              jsx('pre', {
                key: 'sql',
                className:
                  'overflow-auto rounded-[6px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2.5 font-mono text-[10.5px] leading-5 whitespace-pre-wrap',
                children: primary
              }),
              jsxs('div', {
                key: 'acts',
                className: 'flex items-center gap-1',
                children: [
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: () => void writeClipboardText(primary),
                    children: jsxs('span', {
                      className: 'flex items-center gap-1',
                      children: [jsx(Codicon, { name: 'copy' }), 'Copy SQL']
                    })
                  }),
                  jsx(Button, {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: () => onUseSql(primary),
                    children: jsxs('span', {
                      className: 'flex items-center gap-1',
                      children: [jsx(Codicon, { name: 'go-to-file' }), 'Open in SQL']
                    })
                  })
                ]
              })
            ]),
        message.join_sql
          ? jsxs('div', {
              key: 'join',
              className:
                'flex flex-col gap-1 rounded-[6px] border border-(--ui-stroke-secondary) p-2',
              children: [
                jsxs('div', {
                  key: 'h',
                  className: 'flex items-center gap-1.5 text-[10.5px] text-(--ui-text-tertiary)',
                  children: [
                    jsx(Codicon, { key: 'i', name: 'link' }),
                    jsx('span', { key: 't', children: 'Local join' }),
                    jsx('span', {
                      key: 'n',
                      className: 'ml-auto',
                      children: 'rows never leave this Mac'
                    })
                  ]
                }),
                jsx('pre', {
                  key: 'sql',
                  className:
                    'overflow-auto rounded-[5px] bg-(--ui-bg-secondary) p-2 font-mono text-[10.5px] leading-5 whitespace-pre-wrap',
                  children: message.join_sql
                }),
                jsx(Button, {
                  key: 'copy',
                  variant: 'ghost',
                  size: 'xs',
                  onClick: () => void writeClipboardText(message.join_sql),
                  children: jsxs('span', {
                    className: 'flex items-center gap-1',
                    children: [jsx(Codicon, { name: 'copy' }), 'Copy join SQL']
                  })
                })
              ]
            })
          : null,
        resultTable(message),
        jsxs('div', {
          key: 'meta',
          className: 'flex flex-col gap-0.5 text-[10px] text-(--ui-text-tertiary)',
          children: [
            jsxs('div', {
              key: 'rows-line',
              className: 'flex items-center gap-1.5',
              children: [
                jsx(Codicon, { key: 'i', name: 'history' }),
                jsx('span', {
                  key: 'rows',
                  children: `${message.rows ? message.rows.length : 0} row(s)${
                    message.truncated ? ' · truncated' : ''
                  }`
                }),
                sources.length > 1
                  ? jsx('span', { key: 'srcs', children: ` · ${sources.length} sources` })
                  : null
              ]
            }),
            message.steps && message.steps.length
              ? jsx('div', {
                  key: 'steps',
                  className: 'truncate',
                  title: message.steps.join(' · '),
                  children: message.steps.join(' · ')
                })
              : null
          ]
        })
      ].filter(Boolean)
    })
  }

  const enabledCount = catalog.filter((entry) => scope.includes(entry.id)).length
  const scopeLabel =
    catalog.length && enabledCount === catalog.length
      ? `All databases (${catalog.length})`
      : `${enabledCount} of ${catalog.length} databases`

  return jsxs('div', {
    key: 'ai-panel',
    className:
      'absolute inset-y-0 right-0 z-30 flex w-[400px] max-w-[88vw] flex-col border-l border-(--ui-stroke-secondary) bg-background shadow-2xl',
    children: [
      jsxs('div', {
        key: 'head',
        className: 'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsx(Codicon, { key: 'i', name: 'sparkle', className: 'text-primary' }),
          jsx('span', { key: 't', className: 'text-[13px] font-semibold', children: 'AI chat' }),
          jsx('span', {
            key: 'm',
            className: 'truncate text-[10.5px] text-(--ui-text-tertiary)',
            children: config && config.model ? config.model : ''
          }),
          jsx('span', { key: 'sp', className: 'flex-1' }),
          jsx(Button, {
            key: 'new',
            variant: 'ghost',
            size: 'sm',
            title: 'New chat',
            disabled: !messages.length,
            onClick: () => setMessages([]),
            children: jsx(Codicon, { name: 'add' })
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
      catalog.length > 1
        ? jsxs('div', {
            key: 'scope',
            className:
              'relative shrink-0 border-b border-(--ui-stroke-secondary) px-3 py-1 text-[10.5px] text-(--ui-text-tertiary)',
            children: [
              jsxs('div', {
                key: 'bar',
                className: 'flex items-center gap-1.5',
                children: [
                  jsx(Codicon, { key: 'i', name: 'server' }),
                  jsx('span', { key: 'l', children: 'Scope' }),
                  jsx('button', {
                    key: 'b',
                    type: 'button',
                    onClick: () => setScopeOpen((open) => !open),
                    className:
                      'flex items-center gap-1 rounded-[3px] border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[10.5px] text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)',
                    children: jsxs('span', {
                      className: 'flex items-center gap-1',
                      children: [
                        scopeLabel,
                        jsx(Codicon, { name: scopeOpen ? 'chevron-up' : 'chevron-down' })
                      ]
                    })
                  }),
                  jsx('span', { key: 'sp', className: 'flex-1' }),
                  jsx('span', {
                    key: 'q',
                    title: 'Read-only: executed statements are recorded in the audit log',
                    children: 'read-only'
                  })
                ]
              }),
              scopeOpen
                ? jsxs('div', {
                    key: 'pop',
                    className:
                      'absolute top-full right-3 left-3 z-40 mt-1 max-h-64 overflow-auto rounded-[6px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-lg',
                    children: [
                      ...catalog.map((entry) =>
                        jsxs('label', {
                          key: entry.id,
                          className:
                            'flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1 text-[11px] hover:bg-(--ui-bg-secondary)',
                          children: [
                            jsx('input', {
                              key: 'cb',
                              type: 'checkbox',
                              checked: scope.includes(entry.id),
                              onChange: () => toggleScope(entry.id)
                            }),
                            jsx('span', {
                              key: 'n',
                              className: 'min-w-0 flex-1 truncate text-(--ui-text-secondary)',
                              children: entry.name
                            }),
                            jsx('span', {
                              key: 'k',
                              className: 'text-[9.5px] uppercase',
                              children: entry.kind
                            }),
                            entry.query
                              ? null
                              : jsx('span', {
                                  key: 'q',
                                  className: 'text-[9.5px] text-amber-600 dark:text-amber-300',
                                  children: 'inspect'
                                })
                          ]
                        })
                      ),
                      jsxs('div', {
                        key: 'acts',
                        className:
                          'mt-1 flex items-center gap-1 border-t border-(--ui-stroke-secondary) pt-1',
                        children: [
                          jsx(Button, {
                            key: 'all',
                            variant: 'ghost',
                            size: 'xs',
                            onClick: () => setScope(catalog.map((entry) => entry.id)),
                            children: 'All'
                          }),
                          jsx(Button, {
                            key: 'only',
                            variant: 'ghost',
                            size: 'xs',
                            disabled: !connectionId,
                            onClick: () => setScope(connectionId ? [connectionId] : []),
                            children: 'Current only'
                          }),
                          jsx(Button, {
                            key: 'none',
                            variant: 'ghost',
                            size: 'xs',
                            onClick: () => setScope([]),
                            children: 'None'
                          })
                        ]
                      })
                    ]
                  })
                : null
            ]
          })
        : null,
      settingsOpen
        ? jsxs('div', {
            key: 'settings',
            className:
              'flex shrink-0 flex-col gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3',
            children: [
              jsxs('div', {
                key: 'fields',
                className: 'grid grid-cols-1 gap-2',
                children: [
                  jsx('input', {
                    key: 'base',
                    value: baseUrl,
                    placeholder: 'Base URL (https://api.openai.com/v1)',
                    onChange: (event) => setBaseUrl(event.target.value),
                    className:
                      'h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                  }),
                  models.length > 0 && !customModel
                    ? jsx('select', {
                        key: 'model',
                        value: model,
                        onChange: (event) => setModel(event.target.value),
                        className:
                          'h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60',
                        children: [
                          model && !models.includes(model)
                            ? jsx('option', { value: model, children: model }, 'saved')
                            : null,
                          ...models.map((name) =>
                            jsx('option', { value: name, children: name }, name)
                          )
                        ]
                      })
                    : jsx('input', {
                        key: 'model',
                        value: model,
                        placeholder: 'Model (gpt-4o-mini)',
                        onChange: (event) => setModel(event.target.value),
                        className:
                          'h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                      }),
                  jsx('input', {
                    key: 'key',
                    type: 'password',
                    value: apiKey,
                    placeholder: config && config.configured ? 'API key saved' : 'API key',
                    onChange: (event) => setApiKey(event.target.value),
                    className:
                      'h-8 rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                  })
                ]
              }),
              jsxs('div', {
                key: 'actions',
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, {
                    key: 'save',
                    variant: 'secondary',
                    size: 'sm',
                    disabled: saving,
                    onClick: () => void saveSettings(),
                    children: saving ? 'Saving…' : 'Save'
                  }),
                  jsx(Button, {
                    key: 'detect',
                    variant: 'ghost',
                    size: 'sm',
                    disabled: detecting,
                    onClick: () => void detectModels(),
                    children: detecting ? 'Detecting…' : 'Detect models'
                  }),
                  models.length > 0 && customModel
                    ? jsx(Button, {
                        key: 'pick',
                        variant: 'ghost',
                        size: 'sm',
                        onClick: () => setCustomModel(false),
                        children: 'Pick from list'
                      })
                    : null,
                  jsxs('label', {
                    key: 'optin',
                    className: 'flex items-center gap-1.5 text-[10.5px] text-(--ui-text-secondary)',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: aiComplete,
                        onChange: (event) => setAiComplete(event.target.checked)
                      }),
                      jsx('span', {
                        children: `AI autocomplete (${chord('I')}, on by default)`
                      })
                    ]
                  }),
                  jsx('span', {
                    key: 'hint',
                    className: 'text-[10px] leading-4 text-(--ui-text-tertiary)',
                    children: 'Schema + questions only. Rows are joined locally, never sent.'
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
              'mx-3 mt-3 rounded-[6px] bg-destructive/10 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive',
            children: error
          })
        : null,
      jsxs('div', {
        key: 'thread',
        className: 'flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4',
        children: [
          ...messages.map((message, index) =>
            message.role === 'user'
              ? jsx(
                  'div',
                  {
                    key: `u-${index}`,
                    className:
                      'rounded-[8px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-3 py-2 text-[12.5px] whitespace-pre-wrap',
                    children: message.text
                  },
                  `u-${index}`
                )
              : message.role === 'error'
                ? jsx(
                    'div',
                    {
                      key: `e-${index}`,
                      className:
                        'rounded-[6px] bg-destructive/10 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive',
                      children: message.text
                    },
                    `e-${index}`
                  )
                : assistantTurn(message, index)
          ),
          busy
            ? jsxs('div', {
                key: 'thinking',
                className: 'flex items-center gap-2 text-[11px] text-(--ui-text-tertiary)',
                children: [
                  jsx(Codicon, { name: 'loading', className: 'animate-spin' }),
                  'Thinking…'
                ]
              })
            : null,
          !messages.length && !busy
            ? jsxs('div', {
                key: 'hint',
                className: 'flex flex-1 flex-col items-center justify-center gap-2 text-center',
                children: [
                  jsx(Codicon, {
                    name: 'sparkle',
                    className: 'text-2xl text-(--ui-text-tertiary) opacity-60'
                  }),
                  jsx('div', {
                    className: 'text-[12px] font-medium text-(--ui-text-secondary)',
                    children: table ? `Ask about ${schema}.${table}` : 'Ask about your data'
                  }),
                  jsx('div', {
                    className: 'max-w-[280px] text-[11px] leading-5 text-(--ui-text-tertiary)',
                    children:
                      catalog.length > 1
                        ? 'Ask across databases: the agent inspects schemas, runs read-only SQL, then joins the rows locally.'
                        : 'Type a question, press Enter, then follow up without losing context.'
                  })
                ]
              })
            : null,
          jsx('div', { key: 'end', ref: endRef })
        ]
      }),
      jsx('div', {
        key: 'composer',
        className: 'shrink-0 border-t border-(--ui-stroke-secondary) p-3',
        children: jsxs('div', {
          className:
            'flex flex-col gap-1 rounded-[10px] border border-(--ui-stroke-secondary) bg-background p-2 shadow-sm focus-within:border-primary/50',
          children: [
            jsx('textarea', {
              value: prompt,
              rows: 3,
              placeholder:
                catalog.length > 1 ? 'Ask across your databases…' : 'Ask about this data…',
              onChange: (event) => setPrompt(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void ask()
                }
              },
              className:
                'w-full resize-none bg-transparent px-1 py-1 text-[12.5px] leading-5 outline-none placeholder:text-(--ui-text-tertiary)'
            }),
            jsxs('div', {
              className: 'flex items-center gap-2',
              children: [
                jsx('span', {
                  className:
                    'rounded-[4px] border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[10px] text-(--ui-text-tertiary)',
                  children: config && config.model ? config.model : 'model'
                }),
                jsx('span', {
                  className: 'truncate text-[10px] text-(--ui-text-tertiary)',
                  children: 'Enter to send · Shift+Enter for a new line'
                }),
                jsx('span', { className: 'flex-1' }),
                jsx(Button, {
                  size: 'sm',
                  disabled:
                    busy || !prompt.trim() || (config && !config.configured) || !scope.length,
                  onClick: () => void ask(),
                  children: busy ? 'Thinking…' : 'Send'
                })
              ]
            })
          ]
        })
      })
    ]
  })
}



const CONNECTION_META = {
  postgres: { icon: 'database', tone: 'text-sky-600 dark:text-sky-400' },
  redshift: { icon: 'cloud', tone: 'text-indigo-600 dark:text-indigo-400' },
  cockroachdb: { icon: 'database', tone: 'text-lime-600 dark:text-lime-400' },
  greenplum: { icon: 'database', tone: 'text-emerald-700 dark:text-emerald-300' },
  singlestore: { icon: 'database', tone: 'text-fuchsia-600 dark:text-fuchsia-400' },
  mysql: { icon: 'database', tone: 'text-amber-600 dark:text-amber-400' },
  clickhouse: { icon: 'graph', tone: 'text-yellow-600 dark:text-yellow-400' },
  sqlite: { icon: 'file', tone: 'text-emerald-600 dark:text-emerald-400' },
  duckdb: { icon: 'graph', tone: 'text-yellow-700 dark:text-yellow-300' },
  elasticsearch: { icon: 'search', tone: 'text-cyan-600 dark:text-cyan-400' },
  influxdb3: { icon: 'graph', tone: 'text-purple-600 dark:text-purple-400' },
  libsql: { icon: 'cloud', tone: 'text-teal-600 dark:text-teal-400' },
  d1: { icon: 'cloud', tone: 'text-orange-600 dark:text-orange-400' },
  mongodb: { icon: 'database', tone: 'text-green-600 dark:text-green-400' },
  redis: { icon: 'key', tone: 'text-rose-600 dark:text-rose-400' },
  mcp: { icon: 'plug', tone: 'text-purple-600 dark:text-purple-400' },
  http: { icon: 'cloud', tone: 'text-blue-600 dark:text-blue-400' }
}

function ConnectionRail({
  connections,
  openIds,
  activeId,
  onSwitch,
  onAdd,
  onRemove,
  onCloseOthers,
  onCloseAll,
  onEdit
}) {
  const items = openIds
    .map((id) => connections.find((connection) => connection.id === id))
    .filter(Boolean)
  const [menu, setMenu] = useState(null)
  useEffect(() => {
    if (!menu) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])
  const menuItem = (label, action, disabled = false) =>
    jsx(
      'button',
      {
        type: 'button',
        disabled,
        className:
          'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover) disabled:opacity-40',
        onClick: () => {
          setMenu(null)
          action()
        },
        children: label
      },
      label
    )
  return jsxs('div', {
    className:
      'flex w-[64px] shrink-0 flex-col overflow-y-auto border-r border-(--ui-stroke-secondary) bg-(--ui-bg-sidebar) py-1',
    children: [
      ...items.map((connection) => {
        const meta = CONNECTION_META[connection.kind] || CONNECTION_META.postgres
        return jsxs(
          'button',
          {
            type: 'button',
            title: `${connection.name}\n${connection.kind} · ${connection.dbname || ''}\nRight-click for options`,
            onClick: () => onSwitch(connection.id),
            onContextMenu: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu({
                x: event.clientX,
                y: event.clientY,
                id: connection.id,
                name: connection.name
              })
            },
            className: cn(
              'flex w-full flex-col items-center gap-1 border-l-2 px-1 py-2 text-center',
              connection.id === activeId
                ? 'border-primary bg-background text-(--ui-text-primary)'
                : 'border-transparent text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)'
            ),
            children: [
              jsx('span', {
                className:
                  'flex size-8 items-center justify-center rounded-[6px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)',
                children: jsx(Codicon, {
                  name: meta.icon,
                  className: cn('text-base', meta.tone)
                })
              }),
              jsx('span', {
                className: 'line-clamp-2 w-full text-[9px] leading-3 break-words',
                children: connection.name
              })
            ]
          },
          connection.id
        )
      }),
      jsx('span', { className: 'flex-1' }),
      jsx('button', {
        type: 'button',
        title: 'Open another connection',
        onClick: onAdd,
        className:
          'mx-auto mb-1 flex size-8 items-center justify-center rounded-[6px] border border-dashed border-(--ui-stroke-secondary) text-(--ui-text-tertiary) hover:bg-(--ui-bg-secondary) hover:text-(--ui-text-primary)',
        children: jsx(Codicon, { name: 'add' })
      }),
      menu
        ? jsxs('div', {
            key: 'menu',
            children: [
              jsx('button', {
                type: 'button',
                'aria-label': 'Close connections menu',
                className: 'fixed inset-0 z-[60] cursor-default',
                onClick: () => setMenu(null)
              }),
              jsxs('div', {
                className:
                  'fixed z-[70] flex w-48 flex-col rounded-[5px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-2xl',
                style: {
                  left: Math.max(8, Math.min(menu.x, window.innerWidth - 200)),
                  top: Math.max(8, Math.min(menu.y, window.innerHeight - 210))
                },
                children: [
                  jsx('div', {
                    className:
                      'truncate px-2 py-1 text-[10px] tracking-wide text-(--ui-text-tertiary) uppercase',
                    children: menu.name
                  }),
                  menuItem('Open', () => onSwitch(menu.id)),
                  menuItem('Edit connection…', () => onEdit && onEdit(menu.id)),
                  jsx('div', { className: 'my-1 h-px bg-(--ui-stroke-secondary)' }),
                  menuItem('Close connection', () => onRemove(menu.id)),
                  menuItem(
                    'Close other connections',
                    () => onCloseOthers && onCloseOthers(menu.id),
                    openIds.length <= 1
                  ),
                  menuItem('Close all connections', () => onCloseAll && onCloseAll())
                ]
              })
            ]
          })
        : null
    ]
  })
}

function ViewSwitcher({ tab, onTab, kind }) {
  const items = [['data', 'Data']]
  if (kind !== 'redis') items.push(['schema', 'Structure'])
  if (kind === 'mysql') items.push(['site', 'Site'])
  return jsxs('div', {
    className:
      'flex shrink-0 items-center gap-0.5 rounded-[4px] border border-(--ui-stroke-secondary) p-0.5',
    children: items.map(([key, label]) =>
      jsx(
        'button',
        {
          type: 'button',
          onClick: () => onTab(key),
          className: cn(
            'rounded-[3px] px-2 py-0.5 text-[11px]',
            tab === key
              ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
              : 'text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
          ),
          children: label
        },
        key
      )
    )
  })
}

export function DbDesk({ onHome, startNew = false, editConnectionId = '', initialDraft = null, onSettings } = {}) {
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
  const [filterRevision, setFilterRevision] = useState(0)
  const [filterOpen, setFilterOpen] = useState(false)
  useEffect(() => {
    if (filterOpen && selected && !filters.length) {
      setFilters([{ mode: 'raw', raw: '', enabled: true }])
    }
  }, [filterOpen, selected, filters.length])
  const [filterDraft, setFilterDraft] = useState({ column: '', op: 'contains', value: '', insensitive: true })
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [columnsMeta, setColumnsMeta] = useState([])
  const [sql, setSql] = useState('select * from ')

  const syncSqlScroll = (event) => {
    const highlight = sqlHighlightRef.current
    if (!highlight) return
    highlight.scrollTop = event.currentTarget.scrollTop
    highlight.scrollLeft = event.currentTarget.scrollLeft
  }
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
  const [openIds, setOpenIds] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem('dbdesk.openConnections') || '[]')
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  })
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

  useEffect(() => {
    if (!initialDraft) return
    setDraft({ ...emptyDraft(), ...initialDraft, password: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraft])
  const [selection, setSelection] = useState(null)
  const [queriesOpen, setQueriesOpen] = useState(false)
  const [views, setViews] = useState([])
  const [viewsOpen, setViewsOpen] = useState(false)
  const [exporting, setExporting] = useState('')
  const [tableMenu, setTableMenu] = useState(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQuery, setQuickQuery] = useState('')
  const [quickIndex, setQuickIndex] = useState(0)
  const [quickFunctions, setQuickFunctions] = useState([])
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [showColumnTypes, setShowColumnTypes] = useState(() => {
    try {
      return localStorage.getItem('dbdesk.showColumnTypes') === '1'
    } catch {
      return false
    }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem('dbdesk.sidebarWidth'))
      return Number.isFinite(value) && value >= 180 && value <= 560 ? value : 256
    } catch {
      return 256
    }
  })
  const activeTabRecord = tabs.find((entry) => entry.id === activeTabId) || null
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
  const [redisView, setRedisView] = useState(null)
  const [decryptOn, setDecryptOn] = useState(false)
  const [hiddenColumns, setHiddenColumns] = useState([])
  const [selectedRows, setSelectedRows] = useState([])
  const [chartOpen, setChartOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
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
  const sqlHighlightRef = useRef(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestPrefix, setSuggestPrefix] = useState('')
  const [suggestQualifier, setSuggestQualifier] = useState('')
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [sqlFunctions, setSqlFunctions] = useState([])
  const [aiConfig, setAiConfig] = useState(null)
  const [aiSuggestion, setAiSuggestion] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [ddl, setDdl] = useState('')
  const [ddlLoading, setDdlLoading] = useState(false)
  const [structureIndexes, setStructureIndexes] = useState([])
  const [structureLoading, setStructureLoading] = useState(false)
  const [columnFilter, setColumnFilter] = useState('')
  const [ddlOpen, setDdlOpen] = useState(false)
  const [queriesTab, setQueriesTab] = useState('history')
  const [saveQueryOpen, setSaveQueryOpen] = useState(false)
  const [saveQueryName, setSaveQueryName] = useState('')
  const [generatedSql, setGeneratedSql] = useState('')
  const [sqlGenOpen, setSqlGenOpen] = useState(false)
  const [openDbOpen, setOpenDbOpen] = useState(false)
  const [openDbQuery, setOpenDbQuery] = useState('')
  const [openDbSelected, setOpenDbSelected] = useState('')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // the shortcut sheet is a dialog: it takes focus, traps Tab, and gives focus back
  const shortcutsPanelRef = useRef(null)
  useDialogFocus(shortcutsPanelRef, shortcutsOpen)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [editor, setEditor] = useState(null)
  const [insertOpen, setInsertOpen] = useState(false)

  const active = connections.find((conn) => conn.id === activeId) || null
  const activeDb = (activeId && dbMap[activeId]) || (active && active.dbname) || ''
  const railIds = openIds.filter((id) => connections.some((conn) => conn.id === id))

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
    if (!activeId) return
    setOpenIds((current) =>
      current.includes(activeId) ? current : [...current, activeId]
    )
  }, [activeId])

  useEffect(() => {
    try {
      localStorage.setItem('dbdesk.openConnections', JSON.stringify(openIds))
    } catch {
      /* private mode */
    }
  }, [openIds])

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
    if (!quickOpen || !activeId) return undefined
    let cancelled = false
    call(
      `/connections/${activeId}/functions?database=${encodeURIComponent(activeDb || '')}`
    )
      .then((result) => {
        if (!cancelled) setQuickFunctions(result.functions || [])
      })
      .catch(() => {
        if (!cancelled) setQuickFunctions([])
      })
    return () => {
      cancelled = true
    }
  }, [quickOpen, activeId, activeDb])

  const toggleTheme = () => {
    const dark = !document.documentElement.classList.contains('dark')
    const next = dark ? 'dark' : 'light'
    if (globalThis.__DBDESK_STANDALONE__) {
      call('/prefs', { method: 'POST', body: { appearance: next } }).catch(() => {})
    }
    window.dispatchEvent(new CustomEvent('dbdesk:appearance', { detail: next }))
  }

  const refreshAiConfig = () => {
    call('/ai/config')
      .then((value) => setAiConfig(value))
      .catch(() => setAiConfig(null))
  }

  useEffect(() => {
    refreshAiConfig()
    window.addEventListener('dbdesk:ai-config', refreshAiConfig)
    return () => window.removeEventListener('dbdesk:ai-config', refreshAiConfig)
  }, [tab])

  useEffect(() => {
    setAiSuggestion(null)
  }, [activeId, activeDb, tab])

  useEffect(() => {
    setDecryptOn(false)
  }, [activeId, activeDb, selected ? selected.table : ''])

  useEffect(() => {
    try {
      localStorage.setItem('dbdesk.sidebarWidth', String(sidebarWidth))
    } catch {
      /* private mode */
    }
  }, [sidebarWidth])

  useEffect(() => {
    try {
      localStorage.setItem('dbdesk.showColumnTypes', showColumnTypes ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [showColumnTypes])

  const startSidebarResize = (event) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent) => {
      setSidebarWidth(Math.max(180, Math.min(560, startWidth + moveEvent.clientX - startX)))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    if (tab !== 'sql' || !activeId) return undefined
    const kind = (active && active.kind) || 'postgres'
    if (!['postgres', 'mysql', 'clickhouse', 'sqlite'].includes(kind)) {
      setSqlFunctions([])
      return undefined
    }
    let cancelled = false
    call(`/connections/${activeId}/functions?database=${encodeURIComponent(activeDb || '')}`)
      .then((result) => {
        if (!cancelled) setSqlFunctions(result.functions || [])
      })
      .catch(() => {
        if (!cancelled) setSqlFunctions([])
      })
    return () => {
      cancelled = true
    }
  }, [tab, activeId, activeDb])

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
            filters: filters.filter((item) => item.enabled !== false)
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
  }, [activeId, selected, offset, limit, order, tab, filterRevision, schemaVersion])

  const sqlAliasMap = useMemo(() => sqlAliases(tab === 'sql' ? sql : ''), [sql, tab])

  const suggestions = useMemo(() => {
    const qualifier = suggestQualifier.toLowerCase()
    const prefix = suggestPrefix
    const entries = []
    const seen = new Set()
    const push = (value, kind, detail) => {
      const key = `${kind}:${value}`
      if (!value || seen.has(key)) return
      seen.add(key)
      entries.push({ value, kind, detail })
    }
    const resolveKey = (schema, table) => {
      if (schema) return `${schema}.${table}`
      const hit = tree
        .flatMap((item) =>
          item.tables.map((entry) => ({ schema: item.name, table: entry.name }))
        )
        .find((entry) => entry.table === table)
      return hit ? `${hit.schema}.${hit.table}` : table
    }
    const pushColumns = (key) => {
      for (const name of columnCacheRef.current[key] || []) push(name, 'column', key)
    }

    if (qualifier) {
      const refs = sqlAliasMap.filter(
        (ref) =>
          (ref.alias || '').toLowerCase() === qualifier ||
          (ref.table || '').toLowerCase() === qualifier
      )
      const keys = new Set(refs.map((ref) => resolveKey(ref.schema, ref.table)))
      for (const key of keys) pushColumns(key)
      const schemaMatch = tree.find((item) => item.name.toLowerCase() === qualifier)
      if (keys.size === 0 && schemaMatch) {
        for (const table of schemaMatch.tables) {
          push(table.name, 'table', `${schemaMatch.name} · ${table.kind || 'table'}`)
        }
      }
    } else {
      for (const word of SQL_HIGHLIGHT_WORDS) push(word.toUpperCase(), 'keyword', 'keyword')
      for (const schema of tree) {
        for (const table of schema.tables) {
          push(table.name, 'table', `${schema.name} · ${table.kind || 'table'}`)
        }
      }
      const keys = new Set(sqlAliasMap.map((ref) => resolveKey(ref.schema, ref.table)))
      if (selected) keys.add(`${selected.schema}.${selected.table}`)
      for (const key of keys) pushColumns(key)
      const selectedLabel = selected ? `${selected.schema}.${selected.table}` : ''
      for (const column of columnsMeta) push(column.name, 'column', selectedLabel)
      for (const fn of sqlFunctions) push(`${fn.name}(`, 'function', `${fn.schema} · function`)
    }

    const ranked = []
    for (const entry of entries) {
      const score = fuzzyScore(entry.value, prefix) + (entry.kind === 'keyword' ? 0 : 6)
      if (score > 6) ranked.push({ ...entry, score })
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score || a.value.length - b.value.length || a.value.localeCompare(b.value)
    )
    return ranked.slice(0, 10)
  }, [
    suggestQualifier,
    suggestPrefix,
    sqlAliasMap,
    tree,
    columnsMeta,
    selected,
    sqlFunctions,
    columnCacheVersion
  ])

  const updateSuggestions = (value, caret) => {
    const position = caret == null ? value.length : caret
    const before = value.slice(0, position)
    const qualified = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(before)
    let qualifier = ''
    let prefix = ''
    if (qualified) {
      qualifier = qualified[1]
      prefix = qualified[2] || ''
    } else {
      const word = /([A-Za-z_][\w$]*)$/.exec(before)
      prefix = word ? word[1] : ''
    }
    setSuggestQualifier(qualifier)
    setSuggestPrefix(prefix)
    setSuggestIndex(0)
    setSuggestOpen(Boolean(qualifier) || prefix.length >= 2)
  }

  const acceptSuggestion = (entry) => {
    const item = entry && typeof entry === 'object' ? entry : { value: entry, kind: 'keyword' }
    const value = item.kind === 'function' ? `${item.value})` : item.value
    const element = sqlRef.current
    const caret = element ? element.selectionStart : sql.length
    const before = sql.slice(0, caret)
    const start = before.replace(/[A-Za-z_][\w$]*$/, '').length
    const next = sql.slice(0, start) + value + sql.slice(caret)
    setSql(next)
    setSuggestOpen(false)
    setSuggestQualifier('')
    requestAnimationFrame(() => {
      if (element) {
        element.focus()
        const position = start + (item.kind === 'function' ? item.value.length : value.length)
        element.setSelectionRange(position, position)
      }
    })
  }

  const requestAiCompletion = async () => {
    if (!activeId || aiBusy) return
    if (!aiConfig || !aiConfig.ai_complete) {
      host.notify({
        kind: 'info',
        message: 'Enable AI autocomplete in the AI panel settings, then save.'
      })
      return
    }
    setAiBusy(true)
    setErr('')
    try {
      const element = sqlRef.current
      const caret = element ? element.selectionStart : sql.length
      const result = await call('/ai/complete', {
        method: 'POST',
        body: { connection_id: activeId, database: activeDb, sql, caret }
      })
      const text = String((result && result.suggestion) || '')
      if (text) {
        setAiSuggestion({ text, caret })
      } else {
        host.notify({ kind: 'info', message: 'No AI suggestion at the caret' })
      }
    } catch (reason) {
      setErr(errText(reason))
      host.notify({ kind: 'error', message: errText(reason) })
    } finally {
      setAiBusy(false)
    }
  }

  const acceptAiSuggestion = () => {
    if (!aiSuggestion) return
    const element = sqlRef.current
    const caret = element ? element.selectionStart : sql.length
    const text = aiSuggestion.text
    const next = sql.slice(0, caret) + text + sql.slice(caret)
    setSql(next)
    setAiSuggestion(null)
    requestAnimationFrame(() => {
      if (element) {
        element.focus()
        const position = caret + text.length
        element.setSelectionRange(position, position)
      }
    })
  }

  const runQuery = useCallback(async () => {
    if (!activeId) return
    setQueryLoading(true)
    setErr('')
    const body = { connection_id: activeId, database: activeDb, sql, limit: 500 }
    try {
      try {
        const result = await call('/query', { method: 'POST', body })
        setQuery(result)
        setTabs((current) =>
          current.map((entry) =>
            entry.id === activeTabId && entry.type === 'sql'
              ? { ...entry, query: result, sql }
              : entry
          )
        )
      } catch (error) {
        const message = errText(error)
        if (!message.includes('approval_required')) throw error
        const approvalId = await ensureApproval(
          'redis',
          body,
          sql,
          active && active.kind === 'redis' ? `Redis: ${sql}` : 'Production query'
        )
        const result = await call('/query', {
          method: 'POST',
          body: approvalId ? { ...body, approval_id: approvalId } : body
        })
        setQuery(result)
        setTabs((current) =>
          current.map((entry) =>
            entry.id === activeTabId && entry.type === 'sql'
              ? { ...entry, query: result, sql }
              : entry
          )
        )
      }
    } catch (error) {
      setQuery(null)
      setErr(errText(error))
    } finally {
      setQueryLoading(false)
    }
  }, [activeId, activeDb, sql, activeTabId])

  useEffect(() => {
    if (!activeTabId) return
    setTabs((current) =>
      current.map((entry) =>
        entry.id === activeTabId && entry.type === 'sql' && entry.sql !== sql
          ? { ...entry, sql }
          : entry
      )
    )
  }, [sql, activeTabId])

  const currentViewState = () => ({ filters, order, limit, offset, hidden: hiddenColumns })

  const applyViewState = (state) => {
    setFilters(Array.isArray(state.filters) ? state.filters : [])
    setFilterRevision((value) => value + 1)
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
    const row = displayRows[cellMenu.rowIndex] || []
    await writeClipboardText(
      data.columns.map((column, index) => `${column.name}=${row[index] === null ? '' : row[index]}`).join('\t')
    )
    host.notify({ kind: 'info', message: 'Row copied' })
  }

  const openTab = (schema, table, state) => {
    const id = `${schema}.${table}`
    let next = tabs.map((tab) => {
      if (tab.id !== activeTabId) return tab
      if (tab.type === 'sql') return { ...tab, sql, query }
      return { ...tab, state: currentViewState() }
    })
    const existing = next.find((tab) => tab.id === id)
    const currentTab = next.find((tab) => tab.id === activeTabId)
    if (!existing) {
      const fresh = state || {
        filters: [],
        order: { by: '', dir: 'asc' },
        limit: DEFAULT_LIMIT,
        offset: 0,
        hidden: []
      }
      if (currentTab && currentTab.type !== 'sql' && !currentTab.dirty && !state) {
        next = next.map((tab) =>
          tab.id === activeTabId ? { id, type: 'table', schema, table, state: fresh, dirty: false } : tab
        )
      } else {
        next = [...next, { id, type: 'table', schema, table, state: fresh, dirty: Boolean(state) }]
      }
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
    const next = tabs.map((tab) => {
      if (tab.id !== activeTabId) return tab
      if (tab.type === 'sql') return { ...tab, sql, query }
      return { ...tab, state: currentViewState() }
    })
    const target = next.find((tab) => tab.id === id)
    if (!target) return
    setTabs(next)
    setActiveTabId(id)
    setSelection(null)
    setEditor(null)
    setInsertOpen(false)
    if (target.type === 'sql') {
      setSelected(null)
      setSql(target.sql || '')
      setQuery(target.query || null)
      setTab('sql')
      return
    }
    setSelected({ schema: target.schema, table: target.table })
    applyViewState(target.state)
    setTab('data')
  }

  const newSqlTab = (initialSql = '') => {
    const id = `sql:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`
    const next = tabs.map((tab) => {
      if (tab.id !== activeTabId) return tab
      if (tab.type === 'sql') return { ...tab, sql, query }
      return { ...tab, state: currentViewState() }
    })
    setTabs([
      ...next,
      {
        id,
        type: 'sql',
        title: 'SQL Query',
        sql: initialSql,
        query: null,
        dirty: false
      }
    ])
    setActiveTabId(id)
    setSelected(null)
    setSql(initialSql)
    setQuery(null)
    setSelection(null)
    setEditor(null)
    setInsertOpen(false)
    setTab('sql')
  }

  const closeTab = (id) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const closingActive = id === activeTabId
    let next = tabs
      .filter((tab) => tab.id !== id)
      .map((tab) => {
        if (tab.id !== activeTabId || closingActive) return tab
        if (tab.type === 'sql') return { ...tab, sql, query }
        return { ...tab, state: currentViewState() }
      })
    setTabs(next)
    if (!closingActive) return
    const fallback = next[Math.max(0, index - 1)]
    if (fallback) {
      setActiveTabId(fallback.id)
      if (fallback.type === 'sql') {
        setSelected(null)
        setSql(fallback.sql || '')
        setQuery(fallback.query || null)
        setTab('sql')
      } else {
        setSelected({ schema: fallback.schema, table: fallback.table })
        applyViewState(fallback.state)
        setTab('data')
      }
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

  useEffect(() => {
    if (tab !== 'schema' || !selected || !activeId) {
      setStructureIndexes([])
      return
    }
    let cancelled = false
    setStructureLoading(true)
    setColumnFilter('')
    call(
      `/connections/${activeId}/indexes?schema=${encodeURIComponent(
        selected.schema
      )}&table=${encodeURIComponent(selected.table)}&database=${encodeURIComponent(activeDb)}`
    )
      .then((result) => {
        if (!cancelled) setStructureIndexes(result.indexes || [])
      })
      .catch(() => {
        if (!cancelled) setStructureIndexes([])
      })
      .finally(() => {
        if (!cancelled) setStructureLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, selected, activeId, activeDb, treeVersion, schemaVersion])

  const sortBy = (column) => {
    markTabDirty()
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
  const rowsEditable = Boolean(
    active &&
      !active.readonly &&
      active.kind !== 'redis' &&
      selected &&
      data &&
      pkColumns.length > 0
  )
  const canInsert = Boolean(
    active &&
      !active.readonly &&
      active.kind !== 'redis' &&
      selected &&
      columnsMeta.length > 0
  )
  const displayRows = data
    ? decryptOn && data.decrypted_rows
      ? data.decrypted_rows
      : data.rows
    : []

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
    if (active && active.kind === 'redis') {
      const key = data && data.rows[rowIndex] ? data.rows[rowIndex][0] : ''
      if (key) setRedisView(String(key))
      return
    }
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
    if (active && active.kind === 'mongodb') {
      const body = {
        connection_id: activeId,
        database: activeDb,
        collection: selected.table,
        filter: pk,
        changes: { [editor.column.name]: nextValue }
      }
      const preview = await previewMutation('/mongo/docs/update', body)
      setEditor(null)
      armMutation('/mongo/docs/update', body, preview, {
        title: `Update ${selected.table}`,
        action: 'update',
        table: selected.table,
        done: `Saved ${editor.column.name}`,
        after: () => loadRows(offset)
      })
      return
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
    if (active && active.kind === 'redis') {
      host.notify({ kind: 'info', message: 'Delete Redis keys with DEL from the command console.' })
      return
    }
    const pk = pkValuesFor(rowIndex)
    if (Object.keys(pk).length === 0) {
      host.notify({ kind: 'error', message: 'This table has no primary key — delete rows from SQL.' })
      return
    }
    if (active && active.kind === 'mongodb') {
      const body = {
        connection_id: activeId,
        database: activeDb,
        collection: selected.table,
        filter: pk
      }
      try {
        const preview = await previewMutation('/mongo/docs/delete', body)
        armMutation('/mongo/docs/delete', body, preview, {
          title: `Delete from ${selected.table}`,
          action: 'delete',
          table: selected.table,
          done: 'Document deleted',
          after: () => loadRows(offset)
        })
      } catch (error) {
        setErr(errText(error))
      }
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
    if (active && active.kind === 'redis') {
      host.notify({ kind: 'info', message: 'Add Redis keys from the command console (SET, HSET, ...).' })
      return
    }
    if (active && active.kind === 'mongodb') {
      const document = { ...values }
      if (document._id === '' || document._id === null) delete document._id
      const body = {
        connection_id: activeId,
        database: activeDb,
        collection: selected.table,
        document
      }
      const preview = await previewMutation('/mongo/docs/insert', body)
      armMutation('/mongo/docs/insert', body, preview, {
        title: `Insert into ${selected.table}`,
        action: 'insert',
        table: selected.table,
        done: 'Document inserted',
        close: () => setInsertOpen(false),
        after: async () => {
          setOffset(0)
          await loadRows(0)
        }
      })
      return
    }
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
    if (active && active.kind === 'redis') {
      const key = data && data.rows[rowIndex] ? data.rows[rowIndex][0] : ''
      if (key) setRedisView(String(key))
      return
    }
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
      const grid =
        tab === 'data'
          ? data && decryptOn && data.decrypted_rows
            ? { ...data, rows: data.decrypted_rows }
            : data
          : query
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
        const qi = (name) =>
          kind === 'mysql' ? `\`${name}\`` : kind === 'sqlserver' ? `[${name}]` : `"${name}"`
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
    [selection, selectedRows, tab, data, query, active, selected, decryptOn]
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
    markTabDirty()
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

  const filterHasValue = (filter) =>
    Boolean(filter) &&
    (filter.mode === 'raw'
      ? String(filter.raw || '').trim() !== ''
      : ['isnull', 'notnull'].includes(filter.op) ||
        String(filter.value === null || filter.value === undefined ? '' : filter.value) !== '')

  const filterValid = (filter) =>
    filterHasValue(filter) && filter.enabled !== false

  const addFilterRow = () => {
    markTabDirty()
    setFilters((current) => [...current, { mode: 'raw', raw: '', enabled: true }])
  }

  const setFilterMode = (index, value) => {
    const filter = filters[index]
    if (!filter) return
    if (value === 'raw') {
      updateFilter(index, { mode: 'raw', raw: filter.raw || '' })
    } else {
      const column = value.replace(/^col:/, '')
      const meta = columnsMeta.find((item) => item.name === column)
      const previous = columnsMeta.find((item) => item.name === filter.column)
      const textOps = ['contains', 'startswith', 'endswith']
      let op = filter.op || 'contains'
      if (isEqualityType(meta && meta.type) && textOps.includes(op)) {
        op = 'eq'
      } else if (!isEqualityType(meta && meta.type) && isEqualityType(previous && previous.type) && op === 'eq') {
        op = 'contains'
      }
      updateFilter(index, {
        mode: 'column',
        column,
        op,
        value: filter.value || '',
        insensitive: filter.insensitive !== false
      })
    }
  }

  useEffect(() => {
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        if (quickOpen) {
          setQuickOpen(false)
          return
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false)
          return
        }
        if (tableMenu) {
          setTableMenu(null)
          return
        }
        if (headerMenuOpen) {
          setHeaderMenuOpen(false)
          return
        }
        if (moreOpen) {
          setMoreOpen(false)
          return
        }
        if (filterOpen) {
          setFilterOpen(false)
          return
        }
      }
      const key = event.key
      // In a browser tab Ctrl/Cmd+T is the browser's own new-tab shortcut and a page
      // cannot cancel it, so the hosted build binds Alt+T instead — which means this one
      // has to be checked before the modifier guard below.
      if ((key === 't' || key === 'T') && inBrowserTab() && event.altKey) {
        event.preventDefault()
        newSqlTab()
        return
      }
      if (!mod) return
      if ((key === 't' || key === 'T') && !event.altKey) {
        event.preventDefault()
        newSqlTab()
        return
      }
      if (key === 'f' || key === 'F') {
        event.preventDefault()
        if (tab === 'data' && selected) {
          setFilterOpen(true)
          setTimeout(() => {
            const input = document.querySelector('[data-filter-input]')
            if (input) input.focus()
          }, 80)
        } else if (tab === 'sql' && sqlRef.current) {
          sqlRef.current.focus()
        } else {
          document.getElementById('dbdesk-table-filter')?.focus()
        }
        return
      }
      if (key === 'r' || key === 'R') {
        event.preventDefault()
        if (tab === 'sql') void runQuery()
        else if (tab === 'data') void loadRows(offset)
        else if (tab === 'schema') setTreeVersion((value) => value + 1)
        else if (tab === 'site') setSiteVersion((value) => value + 1)
        return
      }
      if (key === 'Enter') {
        event.preventDefault()
        if (tab === 'sql') void runQuery()
        else if (tab === 'data') void loadRows(offset)
        return
      }
      if ((key === 's' || key === 'S') && tab === 'sql' && sql.trim()) {
        event.preventDefault()
        setSaveQueryOpen(true)
        return
      }
      if (key === '1' || key === '2' || key === '3' || key === '4') {
        event.preventDefault()
        if (key === '2') newSqlTab()
        else setTab({ '1': 'data', '3': 'schema', '4': 'site' }[key])
        return
      }
      if (key === 'p' || key === 'P') {
        event.preventDefault()
        setQuickQuery('')
        setQuickIndex(0)
        setQuickOpen((open) => !open)
        return
      }
      if (key === '/') {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, selected, offset, filterOpen, shortcutsOpen, quickOpen, headerMenuOpen, moreOpen, tableMenu, loadRows, runQuery, sql, newSqlTab])

  const markTabDirty = () => {
    setTabs((current) =>
      current.map((tab) => (tab.id === activeTabId ? { ...tab, dirty: true } : tab))
    )
  }

  const addFilter = () => {
    const column = filterDraft.column || (columnsMeta[0] && columnsMeta[0].name) || ''
    if (!column) return
    const nullable = ['isnull', 'notnull'].includes(filterDraft.op)
    if (!nullable && filterDraft.value === '') return
    markTabDirty()
    setFilters((current) => [...current, { ...filterDraft, column, enabled: true }])
    setFilterDraft((current) => ({ ...current, column, value: '' }))
    setOffset(0)
    setFilterRevision((value) => value + 1)
  }

  const removeFilter = (index) => {
    setFilters((current) => current.filter((_, i) => i !== index))
    setOffset(0)
    setFilterRevision((value) => value + 1)
  }

  const updateFilter = (index, patch) => {
    markTabDirty()
    setFilters((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  }

  const toggleFilter = (index, enabled) => {
    markTabDirty()
    setFilters((current) =>
      current.map((row, i) => (i === index ? { ...row, enabled } : row))
    )
    setOffset(0)
    setFilterRevision((value) => value + 1)
  }

  const applyFilter = (index) => {
    markTabDirty()
    setFilters((current) =>
      current.map((row, i) => (i === index ? { ...row, enabled: true } : row))
    )
    setOffset(0)
    setFilterRevision((value) => value + 1)
  }

  const applyAllFilters = () => {
    markTabDirty()
    setFilters((current) => current.map((row) => ({ ...row, enabled: true })))
    setOffset(0)
    setFilterRevision((value) => value + 1)
  }

  const clearFilters = () => {
    markTabDirty()
    setFilters((current) =>
      current.map((row) => ({ ...row, enabled: false }))
    )
    setOffset(0)
    setFilterRevision((value) => value + 1)
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

  const generateSql = async () => {
    if (!selected || !activeId) return
    try {
      const result = await call('/table/sql', {
        method: 'POST',
        body: {
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
      setGeneratedSql(result.sql || '')
      setSqlGenOpen(true)
    } catch (error) {
      setErr(errText(error))
    }
  }

  const saveCurrentQuery = async () => {
    const name = saveQueryName.trim()
    if (!name || !sql.trim()) return
    try {
      await call('/queries/saved', {
        method: 'POST',
        body: { name, sql, connection_id: activeId, database: activeDb }
      })
      setSaveQueryOpen(false)
      setSaveQueryName('')
      host.notify({ kind: 'info', message: 'Query saved' })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const applyView = (view) => {
    markTabDirty()
    setFilters(Array.isArray(view.filters) ? view.filters : [])
    setFilterRevision((value) => value + 1)
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

  const exportTable = async (format = 'csv', target = null) => {
    const source = target || selected
    if (!source || !activeId) return
    setExporting(format)
    setErr('')
    try {
      const current =
        selected && selected.schema === source.schema && selected.table === source.table
      const result = await call('/table/export', {
        method: 'POST',
        body: {
          connection_id: activeId,
          database: activeDb,
          schema: source.schema,
          table: source.table,
          format,
          limit: 50000,
          filters: current ? filters.filter(filterValid) : [],
          order_by: current ? order.by : '',
          order_dir: current ? order.dir : 'asc'
        }
      })
      downloadFile(
        result.filename || `${source.table}.${format}`,
        result.content,
        result.mime || 'text/plain;charset=utf-8'
      )
      host.notify({
        kind: 'info',
        message: result.truncated
          ? `Exported first ${result.rows} rows as ${format.toUpperCase()} (cap)`
          : `Exported ${result.rows} rows as ${format.toUpperCase()}`
      })
    } catch (error) {
      setErr(errText(error))
    } finally {
      setExporting('')
    }
  }

  const dropTable = async (schema, table) => {
    if (!activeId) return
    const body = { connection_id: activeId, database: activeDb, schema, table }
    try {
      const preview = await call('/table/drop', {
        method: 'POST',
        body: { ...body, preview: true }
      })
      armMutation('/table/drop', body, preview, {
        title: `Drop ${schema}.${table}`,
        action: 'drop_table',
        table,
        done: 'Table dropped',
        after: async () => {
          if (selected && selected.schema === schema && selected.table === table) {
            setSelected(null)
            setData(null)
            setTabs([])
            setActiveTabId(null)
            setDdl('')
          }
          setTreeVersion((value) => value + 1)
        }
      })
    } catch (error) {
      setErr(errText(error))
    }
  }

  const persistOpenIds = (ids) => {
    try {
      localStorage.setItem('dbdesk.openConnections', JSON.stringify(ids))
    } catch {
      /* private mode */
    }
  }

  const switchConnection = (id) => {
    setActiveId(id)
    setSelected(null)
    setData(null)
    setEditor(null)
    setInsertOpen(false)
    setTreeOpen(false)
    setTabs([])
    setActiveTabId(null)
    setSelection(null)
  }

  const removeOpenConnection = (id) => {
    const remaining = openIds.filter((value) => value !== id)
    setOpenIds(remaining)
    persistOpenIds(remaining)
    if (id === activeId) {
      if (remaining.length) switchConnection(remaining[0])
      else onHome()
    }
  }

  const closeOtherConnections = (id) => {
    setOpenIds([id])
    persistOpenIds([id])
    if (id !== activeId) switchConnection(id)
  }

  const closeAllConnections = () => {
    setOpenIds([])
    persistOpenIds([])
    if (onHome) onHome()
  }

  const editConnection = (id) => {
    const connection = connections.find((entry) => entry.id === id)
    if (!connection) return
    setDraft({ ...emptyDraft(), ...connection, password: '' })
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

  const quickItems = (() => {
    const q = quickQuery.trim().toLowerCase()
    const matches = (value) => !q || String(value || '').toLowerCase().includes(q)
    const items = []
    for (const schema of tree) {
      if (matches(schema.name)) {
        items.push({
          group: 'Schemas',
          label: schema.name,
          detail: 'schema',
          icon: 'symbol-namespace',
          action: () => {
            setFilter(schema.name)
            setTreeOpen(true)
          }
        })
      }
      for (const table of schema.tables) {
        if (matches(table.name) || matches(`${schema.name}.${table.name}`)) {
          items.push({
            group: 'Tables & views',
            label: table.name,
            detail: `${table.kind || 'table'} · ${schema.name}`,
            icon: table.kind === 'view' ? 'eye' : 'table',
            action: () => pickTable(schema.name, table.name)
          })
        }
      }
    }
    for (const fn of quickFunctions) {
      if (matches(fn.name) || matches(`${fn.schema}.${fn.name}`)) {
        items.push({
          group: 'Functions',
          label: fn.name,
          detail: `function · ${fn.schema}`,
          icon: 'symbol-method',
          action: () => newSqlTab(`SELECT ${fn.schema}.${fn.name}(`)
        })
      }
    }
    for (const conn of connections) {
      if (matches(conn.name)) {
        items.push({
          group: 'Connections',
          label: conn.name,
          detail: `${conn.kind} · ${conn.dbname || ''}`,
          icon: 'plug',
          action: () => switchConnection(conn.id)
        })
      }
    }
    const actions = [
      ['Toggle theme', 'Appearance', 'color-mode', toggleTheme],
      ['New SQL tab', 'Editor', 'terminal', () => newSqlTab()],
      ['Settings', 'Preferences', 'settings-gear', () => onSettings && onSettings()],
      [
        'Close connection',
        active ? active.name : 'Current connection',
        'debug-disconnect',
        () => activeId && removeOpenConnection(activeId)
      ]
    ]
    for (const [label, detail, icon, action] of actions) {
      if (matches(label)) items.push({ group: 'Actions', label, detail, icon, action })
    }
    return items.slice(0, 80)
  })()

  const quickGroups = (() => {
    const groups = []
    let index = 0
    for (const item of quickItems) {
      const last = groups[groups.length - 1]
      if (!last || last.name !== item.group) {
        groups.push({ name: item.group, items: [] })
      }
      groups[groups.length - 1].items.push({ ...item, index })
      index += 1
    }
    return groups
  })()

  useEffect(() => {
    setQuickIndex(0)
  }, [quickQuery])

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

  // A tree of a thousand tables cannot be a thousand tab stops: one row is reachable by Tab and
  // the arrow keys move inside the tree, the way every file tree behaves.
  const treeHasSelection = Boolean(selected && selected.table)

  const onTreeKeyDown = (event) => {
    const rows = Array.from(document.querySelectorAll('[data-tree-row]'))
    if (rows.length === 0) return
    const index = rows.indexOf(event.currentTarget)
    if (index < 0) return
    const focusAt = (next) => {
      event.preventDefault()
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))]
      if (target) target.focus()
    }
    const kind = event.currentTarget.dataset.treeKind
    if (event.key === 'ArrowDown') focusAt(index + 1)
    else if (event.key === 'ArrowUp') focusAt(index - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(rows.length - 1)
    else if (event.key === 'ArrowRight' && kind === 'schema') {
      // Right opens a collapsed schema; Left closes an open one, or walks back up to the schema
      // from a table row.
      event.preventDefault()
      if (event.currentTarget.getAttribute('aria-expanded') === 'false') event.currentTarget.click()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (kind === 'schema' && event.currentTarget.getAttribute('aria-expanded') === 'true') {
        event.currentTarget.click()
      } else if (kind === 'table') {
        for (let back = index - 1; back >= 0; back -= 1) {
          if (rows[back].dataset.treeKind === 'schema') {
            rows[back].focus()
            break
          }
        }
      }
    }
  }


  return jsxs('div', {
    className: 'dbd-app relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground',
    children: [
      jsxs('header', {
        key: 'header',
        className: 'flex shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-2 py-1.5',
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
                  jsx('span', {
                    key: 'n',
                    className:
                      'min-w-0 flex-1 cursor-pointer truncate font-medium text-(--ui-text-secondary) hover:underline',
                    title: 'Connection settings',
                    onClick: editActive,
                    children: active.name
                  }),
                  jsx(Button, {
                    key: 'open-db',
                    variant: 'ghost',
                    size: 'icon-xs',
                    title: 'Open database…',
                    onClick: () => {
                      setOpenDbQuery('')
                      setOpenDbSelected(activeDb)
                      setOpenDbOpen(true)
                      setDbVersion((value) => value + 1)
                    },
                    children: jsx(Codicon, { name: 'database' })
                  }),
                  jsx(Badge, {
                    key: 'kind',
                    variant: 'muted',
                    size: 'xs',
                    className: 'dbd-sm-hide',
                    children:
                      {
                        postgres: 'PG',
                        redshift: 'RS',
                        cockroachdb: 'CRDB',
                        greenplum: 'GP',
                        singlestore: 'S2',
                        mysql: active.flavor === 'mariadb' ? 'MariaDB' : 'MySQL',
                        sqlserver: 'MSSQL',
                        clickhouse: 'CH',
                        mongodb: 'Mongo',
                        redis: 'Redis',
                        sqlite: 'SQLite',
                        duckdb: 'DuckDB',
                        elasticsearch: 'ES',
                        influxdb3: 'Influx',
                        libsql: 'libSQL',
                        d1: 'D1',
                        mcp: 'MCP',
                        http: 'HTTP'
                      }[active.kind || 'postgres'] || 'PG'
                  }),
                  active.display_tz
                    ? jsx(Badge, {
                        key: 'tz',
                        variant: 'outline',
                        size: 'xs',
                        title: `Display timezone: ${active.display_tz}`,
                        className: 'dbd-sm-hide',
                        children: active.display_tz
                      })
                    : null,
                  jsx('span', {
                    key: 'h',
                    className: 'hidden min-w-0 truncate font-mono opacity-80 2xl:inline',
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
          active ? null : jsx('div', { key: 'sp', className: 'flex-1' }),
          onSettings
            ? jsx(Button, {
                key: 'settings',
                variant: 'ghost',
                size: 'icon-xs',
                title: `Settings (${chord(',')})`,
                onClick: onSettings,
                children: jsx(Codicon, { name: 'settings-gear' })
              })
            : null,
          active && ['mongodb', 'redis'].includes(active.kind || '')
            ? null
            : jsx(Button, {
                key: 'ai',
                variant: aiOpen ? 'secondary' : 'ghost',
                size: 'icon-xs',
                title: 'Ask AI (read-only)',
                onClick: () => {
                  setTab('data')
                  setAiOpen((open) => !open)
                },
                children: jsx(Codicon, { key: 'i', name: 'sparkle' })
              }),
          jsx(Button, {
            key: 'refresh',
            variant: 'ghost',
            size: 'icon-xs',
            title: `Refresh tree and the current view (${chord('R')})`,
            onClick: () => {
              setTreeVersion((v) => v + 1)
              if (!selected) return
              if (tab === 'data') void loadRows(offset)
              else if (tab === 'schema') setSchemaVersion((v) => v + 1)
              else if (tab === 'site') setSiteVersion((v) => v + 1)
            },
            disabled: !activeId || treeLoading,
            children: jsx(Codicon, {
              key: 'i',
              name: 'refresh',
              className: treeLoading ? 'animate-spin' : ''
            })
          }),
          jsx(Button, {
            key: 'approvals',
            variant: 'ghost',
            size: 'icon-xs',
            title: 'Approvals',
            onClick: () => setApprovalsOpen(true),
            children: jsxs('span', {
              className: 'relative flex items-center',
              children: [
                jsx(Codicon, { key: 'i', name: 'shield' }),
                approvals.filter((entry) => entry.status === 'pending').length
                  ? jsx('span', {
                      key: 'n',
                      className:
                        'absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] leading-none text-white',
                      children: approvals.filter((entry) => entry.status === 'pending').length
                    })
                  : null
              ]
            })
          }),
          jsxs('div', {
            key: 'more',
            className: 'relative',
            children: [
              jsx(Button, {
                variant: headerMenuOpen ? 'secondary' : 'ghost',
                size: 'icon-xs',
                title: 'More',
                onClick: () => setHeaderMenuOpen((open) => !open),
                children: jsx(Codicon, { name: 'ellipsis' })
              }),
              headerMenuOpen
                ? jsx('button', {
                    key: 'bg',
                    type: 'button',
                    'aria-label': 'Close menu',
                    className: 'fixed inset-0 z-40 cursor-default',
                    onClick: () => setHeaderMenuOpen(false)
                  })
                : null,
              headerMenuOpen
                ? jsxs('div', {
                    key: 'panel',
                    className:
                      'absolute top-full right-0 z-50 mt-1 flex w-48 flex-col rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className:
                          'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)',
                        onClick: () => {
                          setHeaderMenuOpen(false)
                          setAuditOpen(true)
                        },
                        children: 'Audit log'
                      }),
                      jsx('button', {
                        type: 'button',
                        disabled: !activeId,
                        className:
                          'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover) disabled:opacity-40',
                        onClick: () => {
                          setHeaderMenuOpen(false)
                          setActivityOpen(true)
                        },
                        children: 'Activity'
                      }),
                      jsx('div', { className: 'my-1 h-px bg-(--ui-stroke-secondary)' }),
                      jsx('button', {
                        type: 'button',
                        className:
                          'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)',
                        onClick: () => {
                          setHeaderMenuOpen(false)
                          editActive()
                        },
                        children: active ? 'Edit connection' : 'New connection'
                      })
                    ]
                  })
                : null
            ]
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
          railIds.length > 1
            ? jsx(ConnectionRail, {
                key: 'rail',
                connections,
                openIds: railIds,
                activeId,
                onSwitch: switchConnection,
                onAdd: onHome,
                onRemove: removeOpenConnection,
                onCloseOthers: closeOtherConnections,
                onCloseAll: closeAllConnections,
                onEdit: editConnection
              })
            : null,
          jsxs('aside', {
            key: 'side',
            'data-open': treeOpen ? 'true' : 'false',
            className:
              'dbd-sidebar flex shrink-0 flex-col border-r border-(--ui-stroke-secondary) bg-(--ui-bg-sidebar) shadow-xl',
            style: { '--dbd-sidebar-width': `${sidebarWidth}px` },
            children: [
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
                  id: 'dbdesk-table-filter',
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
                  ...filteredTree.map((schema, schemaIndex) => {
                    const isCollapsed = Boolean(collapsed[schema.name])
                    return jsxs(
                      'div',
                      {
                        key: schema.name,
                        children: [
                          jsxs('button', {
                            type: 'button',
                            'data-tree-row': '',
                            'data-tree-kind': 'schema',
                            'aria-expanded': !isCollapsed,
                            tabIndex: schemaIndex === 0 && !treeHasSelection ? 0 : -1,
                            onKeyDown: onTreeKeyDown,
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
                            : schema.tables.map((table, tableIndex) =>
                                jsxs(
                                  'button',
                                  {
                                    type: 'button',
                                    'data-tree-row': '',
                                    'data-tree-kind': 'table',
                                    'data-tree-schema': schema.name,
                                    'data-tree-table': table.name,
                                    tabIndex:
                                      selected &&
                                      selected.schema === schema.name &&
                                      selected.table === table.name
                                        ? 0
                                        : !treeHasSelection && schemaIndex === 0 && tableIndex === 0
                                          ? 0
                                          : -1,
                                    onKeyDown: onTreeKeyDown,
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
                                    onContextMenu: (event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      setTableMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        schema: schema.name,
                                        table: table.name
                                      })
                                    },
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
              }),
              jsx('div', {
                key: 'resize',
                className: 'dbd-sidebar-resize',
                title: 'Drag to resize · double-click to reset',
                onMouseDown: startSidebarResize,
                onDoubleClick: () => setSidebarWidth(256)
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
                      'flex shrink-0 items-stretch overflow-x-auto border-b border-(--ui-stroke-secondary) px-1',
                    children: [
                      ...tabs.map((tab) =>
                        jsxs(
                          'div',
                          {
                            className: cn(
                              'group flex shrink-0 items-center gap-1 border-b-2 px-2.5',
                              tab.id === activeTabId
                                ? 'border-primary text-(--ui-text-primary)'
                                : 'border-transparent text-(--ui-text-tertiary) hover:border-(--ui-stroke-secondary) hover:text-(--ui-text-secondary)'
                            ),
                            children: [
                              tab.type === 'sql'
                                ? jsx(Codicon, {
                                    key: 'icon',
                                    name: 'terminal',
                                    className: 'text-[11px] opacity-70'
                                  })
                                : null,
                              jsx('button', {
                                type: 'button',
                                className: 'max-w-[150px] truncate py-1.5 text-[11.5px]',
                                title: tab.type === 'sql' ? 'SQL query tab' : tab.id,
                                onClick: () => switchTab(tab.id),
                                children:
                                  tab.type === 'sql' ? tab.title || 'SQL Query' : tab.table
                              }),
                              jsx('button', {
                                type: 'button',
                                className:
                                  'rounded-[2px] p-0.5 opacity-40 hover:bg-(--ui-bg-secondary) hover:opacity-100',
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
                      ),
                      jsx(
                        'button',
                        {
                          key: 'new-sql-tab',
                          type: 'button',
                          title: `New SQL query tab (${newTabKey()})`,
                          onClick: () => newSqlTab(),
                          className:
                            'ml-1 flex shrink-0 items-center gap-1 self-center rounded-[3px] border border-dashed border-(--ui-stroke-secondary) px-2 py-1 text-[10.5px] text-(--ui-text-tertiary) hover:bg-(--ui-bg-secondary) hover:text-(--ui-text-primary)',
                          children: [
                            jsx(Codicon, { key: 'i', name: 'add' }),
                            jsx('span', { key: 't', children: 'SQL' })
                          ]
                        },
                        'new-sql-tab'
                      )
                    ]
                  })
                : null,
              tab === 'data'
                ? jsxs('div', {
                    key: 'data',
                    className: cn(
                      'flex min-h-0 flex-1 flex-col',
                      aiOpen && 'relative pr-[400px]'
                    ),
                    children: [
                      aiOpen && !['mongodb', 'redis'].includes((active && active.kind) || '')
                        ? jsx(AiPanel, {
                            key: 'ai',
                            connectionId: activeId,
                            database: activeDb,
                            schema: selected ? selected.schema : '',
                            table: selected ? selected.table : '',
                            onClose: () => setAiOpen(false),
                            onUseSql: (sql) => {
                              setAiOpen(false)
                              newSqlTab(sql)
                            }
                          })
                        : null,
                      selected && filterOpen
                        ? jsxs('div', {
                            key: 'filter-panel',
                            className:
                              'flex max-h-[240px] shrink-0 flex-col gap-1 overflow-auto border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                            children: [
                              ...filters.map((filter, index) =>
                                jsxs(
                                  'div',
                                  {
                                    key: `filter-row-${index}`,
                                    className: 'flex items-center gap-1.5',
                                    children: [
                                    jsx('input', {
                                      key: 'on',
                                      type: 'checkbox',
                                      title: 'Include this filter in WHERE',
                                      checked: filter.enabled !== false,
                                      onChange: (event) =>
                                        toggleFilter(index, event.target.checked)
                                    }),
                                    jsx('select', {
                                      key: 'mode',
                                      title: 'Filter column or raw SQL',
                                      className:
                                        'h-7 max-w-[190px] shrink-0 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                      value:
                                        filter.mode === 'raw'
                                          ? 'raw'
                                          : `col:${filter.column || (columnsMeta[0] && columnsMeta[0].name) || ''}`,
                                      onChange: (event) =>
                                        setFilterMode(index, event.target.value),
                                      children: [
                                        jsx(
                                          'option',
                                          { value: 'raw', children: 'Raw SQL' },
                                          'raw'
                                        ),
                                        ...columnsMeta.map((column) =>
                                          jsx(
                                            'option',
                                            {
                                              value: `col:${column.name}`,
                                              children: `${column.name} (${shortenType(column.type)})`
                                            },
                                            `col:${column.name}`
                                          )
                                        )
                                      ]
                                    }),
                                    filter.mode === 'raw'
                                      ? jsx(Input, {
                                          key: 'raw',
                                          'data-filter-input': 'true',
                                          className: 'h-7 min-w-0 flex-1 font-mono',
                                          value: filter.raw || '',
                                          placeholder:
                                            active && active.kind === 'mongodb'
                                              ? 'MongoDB filter JSON, e.g. {"age": {"$gt": 18}, "name": {"$regex": "ali", "$options": "i"}}'
                                              : active && active.kind === 'redis'
                                                ? 'Key pattern, e.g. user:* or session:*'
                                                : "Pattern, e.g. post_author = 1 AND post_date > '2024-01-01'",
                                          onChange: (event) =>
                                            updateFilter(index, { raw: event.target.value }),
                                          onKeyDown: (event) => {
                                            if (event.key === 'Enter') {
                                              event.preventDefault()
                                              applyFilter(index)
                                            }
                                          }
                                        })
                                      : [
                                          jsx(
                                            'select',
                                            {
                                              key: 'op',
                                              title: 'Operator',
                                              className:
                                                'h-7 shrink-0 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                              value: filter.op,
                                              onChange: (event) =>
                                                updateFilter(index, {
                                                  op: event.target.value
                                                }),
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
                                                jsx(
                                                  'option',
                                                  { value, children: label },
                                                  value
                                                )
                                              )
                                            }
                                          ),
                                          jsx(Input, {
                                            key: 'value',
                                            'data-filter-input': 'true',
                                            className: 'h-7 min-w-0 flex-1',
                                            value: filter.value || '',
                                            disabled: ['isnull', 'notnull'].includes(
                                              filter.op
                                            ),
                                            placeholder: 'value',
                                            onChange: (event) =>
                                              updateFilter(index, {
                                                value: event.target.value
                                              }),
                                            onKeyDown: (event) => {
                                              if (event.key === 'Enter') {
                                                event.preventDefault()
                                                applyFilter(index)
                                              }
                                            }
                                          }),
                                          ['contains', 'startswith'].includes(filter.op)
                                            ? jsxs(
                                                'label',
                                                {
                                                  key: 'ci',
                                                  className:
                                                    'flex shrink-0 items-center gap-1 text-[10px] text-(--ui-text-tertiary)',
                                                  children: [
                                                    jsx('input', {
                                                      type: 'checkbox',
                                                      checked:
                                                        filter.insensitive !== false,
                                                      onChange: (event) =>
                                                        updateFilter(index, {
                                                          insensitive:
                                                            event.target.checked
                                                        })
                                                    }),
                                                    jsx('span', { children: 'ci' })
                                                  ]
                                                }
                                              )
                                            : null
                                        ],
                                    jsx(Button, {
                                      key: 'apply',
                                      variant: 'secondary',
                                      size: 'xs',
                                      disabled: !filterHasValue(filter),
                                      onClick: () => applyFilter(index),
                                      children: 'Apply'
                                    }),
                                    jsx(Button, {
                                      key: 'rm',
                                      variant: 'ghost',
                                      size: 'icon-xs',
                                      title: 'Remove filter',
                                      onClick: () => removeFilter(index),
                                      children: jsx(Codicon, { name: 'dash' })
                                    }),
                                    jsx(Button, {
                                      key: 'add',
                                      variant: 'ghost',
                                      size: 'icon-xs',
                                      title: 'Add filter',
                                      onClick: addFilterRow,
                                      children: jsx(Codicon, { name: 'add' })
                                    })
                                  ].flat()
                                })
                              ),
                              !filters.length
                                ? jsx(Button, {
                                    key: 'empty-add',
                                    variant: 'secondary',
                                    size: 'sm',
                                    className: 'self-start',
                                    onClick: addFilterRow,
                                    children: '+ Add filter'
                                  })
                                : null,
                              jsxs(
                                'div',
                                {
                                  key: 'filter-actions',
                                  className: 'flex flex-wrap items-center gap-2 pt-0.5',
                                  children: [
                                  jsx(Codicon, {
                                    key: 'i',
                                    name: 'filter',
                                    className: 'text-(--ui-text-tertiary)'
                                  }),
                                  jsx('span', {
                                    key: 'n',
                                    className: 'text-[10px] text-(--ui-text-tertiary)',
                                    children: `${filters.filter(filterValid).length} active`
                                  }),
                                  jsx('span', { key: 'sp', className: 'flex-1' }),
                                  jsx(Button, {
                                    key: 'sql',
                                    variant: 'secondary',
                                    size: 'xs',
                                    disabled: !filters.filter(filterValid).length,
                                    title: 'Generate SQL from these filters',
                                    onClick: () => void generateSql(),
                                    children: 'SQL'
                                  }),
                                  jsx(Button, {
                                    key: 'clear',
                                    variant: 'ghost',
                                    size: 'xs',
                                    disabled: !filters.length,
                                    title: 'Unapply filters and keep their values',
                                    onClick: clearFilters,
                                    children: 'Clear'
                                  }),
                                  jsx(Button, {
                                    key: 'all',
                                    variant: 'secondary',
                                    size: 'xs',
                                    disabled: !filters.some(filterHasValue),
                                    onClick: applyAllFilters,
                                    children: 'Apply all'
                                  })
                                ]
                              })
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
                            showTypes: showColumnTypes,
                            columns: data ? data.columns : null,
                            rows: displayRows,
                            emptyText: dataLoading ? 'Loading…' : 'No rows.',
                            onSort: sortBy,
                            pk: pkColumns.map((column) => column.name),
                            editable: rowsEditable,
                            onEditCell: editCell,
                            onDeleteRow: rowsEditable ? deleteRow : undefined,
                            selection,
                            onSelectCell: selectCell,
                            onSelectRow: selectRow,
                        onOpenRow: (rowIndex) => setRowDetail(rowIndex),
                            onOpenRow: (rowIndex) => setRowDetail(rowIndex),
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
                                className: 'text-center',
                                children: active
                                  ? 'Pick a table from the list, or switch to SQL.'
                                  : 'Add a connection to get started.'
                              }),
                              active
                                ? jsx('button', {
                                    key: 'browse',
                                    type: 'button',
                                    className:
                                      'dbd-tree-toggle items-center gap-1 rounded-[4px] border border-(--ui-stroke-secondary) bg-background px-2.5 py-1 text-[11px] font-medium text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)',
                                    onClick: () => setTreeOpen(true),
                                    children: 'Browse tables'
                                  })
                                : null
                            ]
                          }),
                      jsxs('div', {
                        key: 'bar',
                        className: cn(
                          'shrink-0 flex-wrap items-center gap-2 gap-y-1 overflow-visible border-t border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-2',
                          selected ? 'flex' : 'hidden'
                        ),
                        children: [
                          jsx(ViewSwitcher, {
                            tab,
                            onTab: setTab,
                            kind: (active && active.kind) || 'postgres'
                          }),
                          jsxs('label', {
                            className: 'flex items-center gap-1 text-[11px] text-(--ui-text-tertiary)',
                            children: [
                              'Limit',
                              jsx('select', {
                                className: 'h-7 rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-1.5 text-[11px]',
                                value: limit,
                                onChange: (event) => {
                                  markTabDirty()
                                  setOffset(0)
                                  setLimit(Number(event.target.value))
                                },
                                children: [50, 100, 250, 500, 1000, 2000].map((n) =>
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
                          jsx(Button, {
                            key: 'table-sql',
                            variant: 'ghost',
                            size: 'sm',
                            title: 'Generate SQL from the current table, filters, order and limit',
                            disabled: !selected,
                            onClick: () => void generateSql(),
                            children: jsx(Codicon, { name: 'code' })
                          }),
                          data && data.decrypted_rows
                            ? jsx(Button, {
                                key: 'decrypt',
                                variant: decryptOn ? 'secondary' : 'ghost',
                                size: 'sm',
                                title: decryptOn
                                  ? 'Hide encrypted values'
                                  : 'Reveal encrypted values',
                                onClick: () => setDecryptOn((value) => !value),
                                children: jsxs('span', {
                                  className: 'flex items-center gap-1',
                                  children: [
                                    jsx(Codicon, {
                                      key: 'i',
                                      name: decryptOn ? 'unlock' : 'lock'
                                    }),
                                    jsx('span', {
                                      key: 't',
                                      className: 'dbd-sm-inline',
                                      children: 'Decrypt'
                                    })
                                  ]
                                })
                              })
                            : null,
                          jsx(ColumnsMenu, {
                            key: 'columns',
                            columns: columnsMeta,
                            hidden: hiddenColumns,
                            onToggle: toggleColumn,
                            showTypes: showColumnTypes,
                            onToggleTypes: () => setShowColumnTypes((value) => !value)
                          }),
                          jsxs('div', {
                            key: 'more',
                            className: 'relative',
                            children: [
                              jsx(Button, {
                                variant: 'ghost',
                                size: 'sm',
                                title: 'More actions',
                                onClick: () => setMoreOpen((open) => !open),
                                children: jsx(Codicon, { name: 'ellipsis' })
                              }),
                              moreOpen
                                ? jsxs('div', {
                                    key: 'menu',
                                    children: [
                                      jsx('button', {
                                        key: 'bg',
                                        type: 'button',
                                        'aria-label': 'Close actions menu',
                                        className: 'fixed inset-0 z-20 cursor-default',
                                        onClick: () => setMoreOpen(false)
                                      }),
                                      jsxs('div', {
                                        key: 'panel',
                                        className:
                                          'absolute bottom-7 right-0 z-30 flex w-52 flex-col rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                                        children: [
                                          ...['csv', 'json', 'sql']
                                            .filter(
                                              (format) =>
                                                format !== 'sql' ||
                                                ['postgres', 'mysql', 'clickhouse', 'sqlite'].includes(
                                                  (active && active.kind) || 'postgres'
                                                )
                                            )
                                            .map((format) =>
                                              jsx(
                                                'button',
                                                {
                                                  key: `export-${format}`,
                                                  type: 'button',
                                                  disabled: !selected || Boolean(exporting),
                                                  className:
                                                    'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover) disabled:opacity-40',
                                                  onClick: () => {
                                                    setMoreOpen(false)
                                                    void exportTable(format)
                                                  },
                                                  children:
                                                    exporting === format
                                                      ? 'Exporting…'
                                                      : `Export as ${format.toUpperCase()}`
                                                },
                                                format
                                              )
                                            ),
                                          jsx('div', {
                                            key: 'sep1',
                                            className: 'my-1 h-px bg-(--ui-stroke-secondary)'
                                          }),
                                          ...[
                                            ['tsv', 'Copy cells (TSV)'],
                                            ['csv', 'Copy CSV'],
                                            ['json', 'Copy rows (JSON)'],
                                            ['insert', 'Copy rows (INSERT)']
                                          ].map(([format, label]) =>
                                            jsx(
                                              'button',
                                              {
                                                key: `copy-${format}`,
                                                type: 'button',
                                                disabled:
                                                  !selection && selectedRows.length === 0,
                                                className:
                                                  'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover) disabled:opacity-40',
                                                onClick: () => {
                                                  setMoreOpen(false)
                                                  copySelection(format)
                                                },
                                                children: label
                                              },
                                              format
                                            )
                                          ),
                                          jsx('div', {
                                            key: 'sep2',
                                            className: 'my-1 h-px bg-(--ui-stroke-secondary)'
                                          }),
                                          jsx('button', {
                                            key: 'chart',
                                            type: 'button',
                                            className:
                                              'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)',
                                            onClick: () => {
                                              setMoreOpen(false)
                                              setChartOpen((open) => !open)
                                            },
                                            children: chartOpen ? 'Hide chart' : 'Show chart'
                                          }),
                                          canInsert
                                            ? jsx('button', {
                                                key: 'import',
                                                type: 'button',
                                                className:
                                                  'rounded-[3px] px-2 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)',
                                                onClick: () => {
                                                  setMoreOpen(false)
                                                  if (importFileRef.current) {
                                                    importFileRef.current.click()
                                                  }
                                                },
                                                children: 'Import CSV…'
                                              })
                                            : null
                                        ]
                                      })
                                    ]
                                  })
                                : null
                            ]
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
                                children: 'double-click a cell to edit · click # for record'
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
                          jsx('pre', {
                            key: 'highlight',
                            ref: sqlHighlightRef,
                            'aria-hidden': true,
                            className:
                              'pointer-events-none absolute inset-0 overflow-hidden rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-(--ui-text-primary)',
                            children: highlightSql(sql)
                          }),
                          jsx('textarea', {
                            key: 'input',
                            ref: sqlRef,
                            value: sql,
                            spellCheck: false,
                            onScroll: syncSqlScroll,
                            className:
                              'relative h-32 w-full resize-y rounded-[3px] border border-transparent bg-transparent p-2 font-mono text-[12px] leading-5 text-transparent caret-(--ui-text-primary) outline-none placeholder:text-(--ui-text-tertiary) focus:border-primary/60',
                            placeholder:
                              active && active.kind === 'mongodb'
                                ? '{"collection": "users", "find": {"age": {"$gt": 18}}, "limit": 50}'
                                : active && active.kind === 'redis'
                                  ? 'GET user:1   ·   HGETALL user:2   ·   KEYS *   ·   SCAN 0 MATCH user:* COUNT 100'
                                  : 'select * from public.users limit 50;',
                            onChange: (event) => {
                              setSql(event.target.value)
                              setAiSuggestion(null)
                              updateSuggestions(event.target.value, event.target.selectionStart)
                            },
                            onClick: (event) =>
                              updateSuggestions(sql, event.currentTarget.selectionStart),
                            onBlur: () => setSuggestOpen(false),
                            onKeyDown: (event) => {
                              if (aiSuggestion) {
                                if (event.key === 'Tab' || event.key === 'Enter') {
                                  event.preventDefault()
                                  acceptAiSuggestion()
                                  return
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setAiSuggestion(null)
                                  return
                                }
                              }
                              if ((event.metaKey || event.ctrlKey) && (event.key === 'i' || event.key === 'I')) {
                                event.preventDefault()
                                void requestAiCompletion()
                                return
                              }
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
                              // Ctrl/Cmd+Space. Alt is allowed through as an alias
                              // because some Windows input methods swallow Ctrl+Space
                              // to switch IME and never deliver the key to the page.
                              if ((event.metaKey || event.ctrlKey) && event.key === ' ') {
                                event.preventDefault()
                                setSuggestPrefix('')
                                setSuggestQualifier('')
                                setSuggestIndex(0)
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
                                  'absolute top-9 left-2 z-30 flex max-h-[230px] w-72 flex-col overflow-auto rounded-[3px] border border-(--ui-stroke-secondary) bg-background p-1 shadow-xl',
                                children: suggestions.map((item, index) =>
                                  jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      className: cn(
                                        'flex w-full items-center gap-2 rounded-[2px] px-2 py-1 text-left',
                                        index === suggestIndex
                                          ? 'bg-(--ui-bg-quaternary)'
                                          : 'hover:bg-(--chrome-action-hover)'
                                      ),
                                      onMouseDown: (event) => {
                                        event.preventDefault()
                                        acceptSuggestion(item)
                                      },
                                      children: [
                                        jsx(Codicon, {
                                          key: 'icon',
                                          name:
                                            item.kind === 'column'
                                              ? 'symbol-field'
                                              : item.kind === 'table'
                                                ? 'table'
                                                : item.kind === 'function'
                                                  ? 'symbol-method'
                                                  : 'symbol-keyword',
                                          className: 'shrink-0 opacity-60'
                                        }),
                                        jsx('span', {
                                          key: 'value',
                                          className: 'min-w-0 flex-1 truncate font-mono text-[11px]',
                                          children: item.value
                                        }),
                                        jsx('span', {
                                          key: 'detail',
                                          className:
                                            'max-w-[110px] shrink-0 truncate text-[9.5px] text-(--ui-text-tertiary)',
                                          children: item.detail
                                        })
                                      ]
                                    },
                                    `${item.kind}-${item.value}-${index}`
                                  )
                                )
                              })
                            : null,
                      aiSuggestion || aiBusy
                        ? jsxs('div', {
                            key: 'ai-suggest',
                            className:
                              'absolute right-2 bottom-2 left-2 z-30 flex items-center gap-2 rounded-[4px] border border-primary/40 bg-background px-2 py-1 shadow-lg',
                            children: [
                              jsx('span', {
                                key: 'badge',
                                className:
                                  'shrink-0 rounded-[2px] bg-primary/15 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-primary uppercase',
                                children: 'AI'
                              }),
                              jsx('span', {
                                key: 'text',
                                className:
                                  'min-w-0 flex-1 truncate font-mono text-[11px] text-(--ui-text-secondary)',
                                children: aiBusy ? 'Thinking…' : aiSuggestion.text
                              }),
                              aiSuggestion
                                ? jsx('span', {
                                    key: 'hint',
                                    className: 'shrink-0 text-[9.5px] text-(--ui-text-tertiary)',
                                    children: 'Tab to insert · Esc to dismiss'
                                  })
                                : null
                            ]
                          })
                        : null,
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
                            children: `${chord('Enter')} to run`
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
                            onClick: () => {
                              setQueriesTab('history')
                              setQueriesOpen(true)
                            },
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
                            key: 'save-query',
                            variant: 'ghost',
                            size: 'sm',
                            title: 'Save this SQL as a snippet',
                            disabled: !sql.trim(),
                            onClick: () => {
                              setSaveQueryName('')
                              setSaveQueryOpen(true)
                            },
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'save' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'Save'
                                })
                              ]
                            })
                          }),
                          jsx(Button, {
                            key: 'saved-queries',
                            variant: 'ghost',
                            size: 'sm',
                            title: 'Saved queries',
                            onClick: () => {
                              setQueriesTab('saved')
                              setQueriesOpen(true)
                            },
                            children: jsxs('span', {
                              className: 'flex items-center gap-1',
                              children: [
                                jsx(Codicon, { key: 'i', name: 'bookmark' }),
                                jsx('span', {
                                  key: 't',
                                  className: 'dbd-sm-inline',
                                  children: 'Saved'
                                })
                              ]
                            })
                          }),
                          active && ['mongodb', 'redis'].includes(active.kind || '')
                            ? null
                            : jsx(Button, {
                                key: 'format',
                                variant: 'ghost',
                                size: 'sm',
                                title: 'Format SQL',
                                onClick: () => setSql(formatSqlText(sql)),
                                children: 'Format'
                              }),
                          (active && active.kind === 'redis')
                            ? null
                            : jsx(Button, {
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
                        showTypes: showColumnTypes,
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
                          jsx(ViewSwitcher, {
                            key: 'switcher',
                            tab,
                            onTab: setTab,
                            kind: (active && active.kind) || 'postgres'
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
                            onClick: () => setDdlOpen(true),
                            children: 'DDL'
                          }),
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
jsxs('div', {
                        key: 'structure',
                        className: 'flex min-h-0 flex-1 flex-col overflow-hidden',
                        children: [
                          jsxs('div', {
                            key: 'head',
                            className:
                              'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
                            children: [
                              jsx('span', {
                                key: 'nl',
                                className: 'text-[10px] tracking-wide text-(--ui-text-tertiary) uppercase',
                                children: 'Name'
                              }),
                              jsx('span', {
                                key: 'nv',
                                className:
                                  'rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 py-0.5 font-mono text-[11.5px]',
                                children: selected ? selected.table : '—'
                              }),
                              jsx('span', {
                                key: 'pl',
                                className:
                                  'ml-2 text-[10px] tracking-wide text-(--ui-text-tertiary) uppercase',
                                children: 'Primary'
                              }),
                              jsx('span', {
                                key: 'pv',
                                className:
                                  'rounded-[3px] border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11.5px] text-primary',
                                children:
                                  columnsMeta
                                    .filter((column) => column.pk)
                                    .map((column) => column.name)
                                    .join(', ') || '—'
                              }),
                              jsx('span', { key: 'sp', className: 'flex-1' }),
                              jsx('input', {
                                key: 'search',
                                value: columnFilter,
                                placeholder: 'Search for column…',
                                onChange: (event) => setColumnFilter(event.target.value),
                                className:
                                  'h-7 w-[190px] rounded-[3px] border border-(--ui-stroke-secondary) bg-background px-2 text-[11px] outline-none focus:border-primary/60'
                              })
                            ]
                          }),
                          jsx('div', {
                            key: 'columns-wrap',
                            className: 'min-h-0 flex-1 overflow-auto',
                            children: jsxs('table', {
                              className: 'dbd-grid-table dbd-mono min-w-full text-[11.5px]',
                              children: [
                                jsx('thead', {
                                  key: 'h',
                                  className: 'sticky top-0 z-10',
                                  children: jsx('tr', {
                                    children: [
                                      '#',
                                      'column_name',
                                      'data_type',
                                      'character_set',
                                      'collation',
                                      'is_nullable',
                                      'column_default',
                                      'extra',
                                      'foreign_key',
                                      'comment'
                                    ].map((label) =>
                                      jsx('th', {
                                        key: label,
                                        className:
                                          'border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2.5 py-1.5 text-left text-[10px] font-semibold tracking-wide whitespace-nowrap text-(--ui-text-tertiary) uppercase',
                                        children: label
                                      })
                                    )
                                  })
                                }),
                                jsx('tbody', {
                                  key: 'b',
                                  children: columnsMeta
                                    .filter((column) =>
                                      column.name
                                        .toLowerCase()
                                        .includes(columnFilter.trim().toLowerCase())
                                    )
                                    .map((column, index) =>
                                      jsx(
                                        'tr',
                                        {
                                          className: index % 2 ? 'bg-(--ui-bg-secondary)/40' : '',
                                          children: [
                                          jsx('td', {
                                            className:
                                              'px-2.5 py-1.5 text-(--ui-text-tertiary)',
                                            children: index + 1
                                          }),
                                          jsx('td', {
                                            className: 'px-2.5 py-1.5 font-medium whitespace-nowrap',
                                            children: column.name
                                          }),
                                          jsx('td', {
                                            className: 'px-2.5 py-1.5 whitespace-nowrap',
                                            children: column.type || '—'
                                          }),
                                          jsx('td', {
                                            className:
                                              'px-2.5 py-1.5 text-(--ui-text-tertiary)',
                                            children: column.charset || '—'
                                          }),
                                          jsx('td', {
                                            className:
                                              'px-2.5 py-1.5 text-(--ui-text-tertiary)',
                                            children: column.collation || '—'
                                          }),
                                          jsx('td', {
                                            className: 'px-2.5 py-1.5',
                                            children: column.nullable ? 'YES' : 'NO'
                                          }),
                                          jsx('td', {
                                            className:
                                              'max-w-[220px] truncate px-2.5 py-1.5',
                                            title: column.default === null || column.default === undefined ? '' : String(column.default),
                                            children:
                                              column.default === null || column.default === undefined
                                                ? jsx('span', {
                                                    className:
                                                      'text-(--ui-text-tertiary) italic',
                                                    children: 'NULL'
                                                  })
                                                : String(column.default)
                                          }),
                                          jsx('td', {
                                            className:
                                              'px-2.5 py-1.5 text-(--ui-text-tertiary)',
                                            children: column.extra || '—'
                                          }),
                                          jsx('td', {
                                            className:
                                              'px-2.5 py-1.5 text-(--ui-text-tertiary) whitespace-nowrap',
                                            children: column.fk
                                              ? `${column.fk.table}.${column.fk.column}`
                                              : '—'
                                          }),
                                          jsx('td', {
                                            className:
                                              'max-w-[200px] truncate px-2.5 py-1.5 text-(--ui-text-tertiary)',
                                            title: column.comment || '',
                                            children: column.comment || '—'
                                          })
                                        ]
                                      },
                                      column.name
                                      )
                                    )
                                })
                              ]
                            })
                          }),
                          jsxs('div', {
                            key: 'indexes',
                            className:
                              'flex max-h-[190px] shrink-0 flex-col border-t border-(--ui-stroke-secondary)',
                            children: [
                              jsxs('div', {
                                key: 'ih',
                                className:
                                  'flex shrink-0 items-center gap-2 bg-(--ui-bg-secondary) px-3 py-1 text-[10px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase',
                                children: [
                                  jsx('span', { key: 't', children: 'Indexes' }),
                                  jsx('span', {
                                    key: 'c',
                                    className: 'font-normal normal-case',
                                    children: structureLoading
                                      ? 'loading…'
                                      : `${structureIndexes.length}`
                                  })
                                ]
                              }),
                              jsx('div', {
                                key: 'ib',
                                className: 'min-h-0 overflow-auto',
                                children: structureIndexes.length
                                  ? jsxs('table', {
                                      className:
                                        'dbd-grid-table dbd-mono min-w-full text-[11.5px]',
                                      children: [
                                        jsx('thead', {
                                          key: 'h',
                                          children: jsx('tr', {
                                            children: [
                                              'index_name',
                                              'index_algorithm',
                                              'is_unique',
                                              'column_name'
                                            ].map((label) =>
                                              jsx('th', {
                                                key: label,
                                                className:
                                                  'border-b border-(--ui-stroke-secondary) bg-background px-2.5 py-1 text-left text-[10px] font-semibold tracking-wide whitespace-nowrap text-(--ui-text-tertiary) uppercase',
                                                children: label
                                              })
                                            )
                                          })
                                        }),
                                        jsx('tbody', {
                                          key: 'b',
                                          children: structureIndexes.flatMap((entry) => {
                                            const names =
                                              Array.isArray(entry.column_names) &&
                                              entry.column_names.length
                                                ? entry.column_names
                                                : ['']
                                            return names.map((name, index) =>
                                              jsx(
                                                'tr',
                                                {
                                                  children: [
                                                    jsx('td', {
                                                      className:
                                                        'px-2.5 py-1 font-medium whitespace-nowrap',
                                                      children: index === 0 ? entry.name : ''
                                                    }),
                                                    jsx('td', {
                                                      className: 'px-2.5 py-1',
                                                      children:
                                                        index === 0
                                                          ? (entry.algorithm || '—').toUpperCase()
                                                          : ''
                                                    }),
                                                    jsx('td', {
                                                      className: 'px-2.5 py-1',
                                                      children:
                                                        index === 0
                                                          ? entry.unique
                                                            ? 'TRUE'
                                                            : 'FALSE'
                                                          : ''
                                                    }),
                                                    jsx('td', {
                                                      className:
                                                        'px-2.5 py-1 text-(--ui-text-secondary)',
                                                      children: name
                                                    })
                                                  ]
                                                },
                                                `${entry.name}-${name}-${index}`
                                              )
                                            )
                                          })
                                        })
                                      ]
                                    })
                                  : jsx('div', {
                                      className:
                                        'px-3 py-3 text-[11px] text-(--ui-text-tertiary)',
                                      children: structureLoading
                                        ? 'Loading indexes…'
                                        : 'No indexes on this table.'
                                    })
                              })
                            ]
                          }),
                          jsx('div', {
                            key: 'switcher',
                            className:
                              'flex shrink-0 items-center border-t border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1.5',
                            children: jsx(ViewSwitcher, {
                              tab,
                              onTab: setTab,
                              kind: (active && active.kind) || 'postgres'
                            })
                          })
                        ]
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
      quickOpen
        ? jsxs('div', {
            key: 'quick',
            className:
              'fixed inset-0 z-[85] flex items-start justify-center bg-black/40 px-4 pt-[12vh]',
            children: [
              jsx('button', {
                key: 'bg',
                type: 'button',
                'aria-label': 'Close quick panel',
                className: 'absolute inset-0 cursor-default',
                onClick: () => setQuickOpen(false)
              }),
              jsxs('div', {
                key: 'panel',
                className:
                  'relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className:
                      'flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
                    children: [
                      jsx(Codicon, { name: 'search', className: 'text-(--ui-text-tertiary)' }),
                      jsx('input', {
                        autoFocus: true,
                        value: quickQuery,
                        placeholder: 'Jump to a table, view, schema, function…',
                        className:
                          'h-7 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-(--ui-text-tertiary)',
                        onChange: (event) => setQuickQuery(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault()
                            setQuickIndex((index) => Math.min(quickItems.length - 1, index + 1))
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault()
                            setQuickIndex((index) => Math.max(0, index - 1))
                          } else if (event.key === 'Enter') {
                            event.preventDefault()
                            const item = quickItems[quickIndex]
                            if (item) {
                              setQuickOpen(false)
                              item.action()
                            }
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            setQuickOpen(false)
                          }
                        }
                      }),
                      jsx('kbd', {
                        className:
                          'rounded-[3px] border border-(--ui-stroke-secondary) px-1.5 py-0.5 font-mono text-[9px] text-(--ui-text-tertiary)',
                        children: 'esc'
                      })
                    ]
                  }),
                  jsx('div', {
                    key: 'list',
                    className: 'max-h-[420px] overflow-auto p-1',
                    children: quickGroups.length
                      ? quickGroups.map((group) =>
                          jsxs(
                            'div',
                            {
                              children: [
                                jsx('div', {
                                  key: 'h',
                                  className:
                                    'px-2 pt-2 pb-1 text-[9px] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase',
                                  children: group.name
                                }),
                                ...group.items.map((item) =>
                                  jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      onClick: () => {
                                        setQuickOpen(false)
                                        item.action()
                                      },
                                      onMouseEnter: () => setQuickIndex(item.index),
                                      className: cn(
                                        'flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[11.5px]',
                                        item.index === quickIndex
                                          ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                                          : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
                                      ),
                                      children: [
                                        jsx(Codicon, {
                                          key: 'i',
                                          name: item.icon,
                                          className: 'shrink-0 opacity-70'
                                        }),
                                        jsx('span', {
                                          key: 'l',
                                          className: 'min-w-0 flex-1 truncate',
                                          children: item.label
                                        }),
                                        jsx('span', {
                                          key: 'd',
                                          className:
                                            'shrink-0 text-[10px] text-(--ui-text-tertiary)',
                                          children: item.detail
                                        })
                                      ]
                                    },
                                    `${group.name}-${item.index}`
                                  )
                                )
                              ]
                            },
                            group.name
                          )
                        )
                      : jsx('div', {
                          className: 'px-3 py-6 text-center text-[11.5px] text-(--ui-text-tertiary)',
                          children: 'No matches'
                        })
                  }),
                  jsxs('div', {
                    key: 'foot',
                    className:
                      'flex items-center gap-3 border-t border-(--ui-stroke-secondary) px-3 py-1.5 text-[10px] text-(--ui-text-tertiary)',
                    children: ['↑↓ navigate', '⏎ open', 'esc close'].map((text) =>
                      jsx('span', { children: text }, text)
                    )
                  })
                ]
              })
            ]
          })
        : null,
      tableMenu
        ? jsx(TableMenu, {
            key: 'table-menu',
            menu: tableMenu,
            onClose: () => setTableMenu(null),
            onOpen: () => pickTable(tableMenu.schema, tableMenu.table),
            onExport: (format) =>
              exportTable(format, { schema: tableMenu.schema, table: tableMenu.table }),
            onDrop: () => dropTable(tableMenu.schema, tableMenu.table),
            onCopy: () => writeClipboardText(`${tableMenu.schema}.${tableMenu.table}`),
            sqlKind:
              active &&
              ['postgres', 'mysql', 'clickhouse', 'sqlite'].includes(active.kind || 'postgres'),
            canWrite: Boolean(active && !active.readonly)
          })
        : null,
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
      sqlGenOpen
        ? jsxs('div', {
            key: 'sqlgen-modal',
            className: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4',
            children: [
              jsxs('div', {
                key: 'panel',
                className:
                  'flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className:
                      'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-4 py-2.5',
                    children: [
                      jsx(Codicon, { key: 'i', name: 'code', className: 'text-primary' }),
                      jsx('span', {
                        key: 't',
                        className: 'text-[13px] font-semibold',
                        children: 'Generated SQL'
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'copy',
                        variant: 'secondary',
                        size: 'sm',
                        onClick: () => {
                          void writeClipboardText(generatedSql)
                          host.notify({ kind: 'info', message: 'SQL copied' })
                        },
                        children: 'Copy'
                      }),
                      jsx(Button, {
                        key: 'open',
                        size: 'sm',
                        onClick: () => {
                          setSqlGenOpen(false)
                          setFilterOpen(false)
                          newSqlTab(generatedSql)
                        },
                        children: 'Open in SQL'
                      }),
                      jsx(Button, {
                        key: 'close',
                        variant: 'ghost',
                        size: 'sm',
                        title: 'Close',
                        onClick: () => setSqlGenOpen(false),
                        children: jsx(Codicon, { name: 'close' })
                      })
                    ]
                  }),
                  jsx('pre', {
                    key: 'sql',
                    className:
                      'min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-6 whitespace-pre',
                    children: generatedSql
                  })
                ]
              })
            ]
          })
        : null,
      openDbOpen
        ? jsxs('div', {
            key: 'open-db',
            className: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4',
            children: [
              jsxs('div', {
                key: 'panel',
                className:
                  'flex h-[min(560px,82vh)] w-full max-w-[480px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className:
                      'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-4 py-2.5',
                    children: [
                      jsx(Codicon, { key: 'i', name: 'database', className: 'text-primary' }),
                      jsx('span', {
                        key: 't',
                        className: 'text-[13px] font-semibold',
                        children: 'Open database'
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'close',
                        variant: 'ghost',
                        size: 'sm',
                        title: 'Close',
                        onClick: () => setOpenDbOpen(false),
                        children: jsx(Codicon, { name: 'close' })
                      })
                    ]
                  }),
                  jsx('div', {
                    key: 'search',
                    className: 'shrink-0 p-3 pb-2',
                    children: jsx('input', {
                      autoFocus: true,
                      value: openDbQuery,
                      placeholder: 'Search for database…',
                      onChange: (event) => setOpenDbQuery(event.target.value),
                      className:
                        'h-9 w-full rounded-[5px] border border-(--ui-stroke-secondary) bg-background px-2.5 text-[12px] outline-none focus:border-primary/60'
                    })
                  }),
                  jsx('div', {
                    key: 'list',
                    className: 'min-h-0 flex-1 overflow-auto px-2 pb-2',
                    children: databases.filter((db) =>
                      `${db.name} ${db.label || ''}`
                        .toLowerCase()
                        .includes(openDbQuery.trim().toLowerCase())
                    ).map((db) =>
                      jsxs(
                        'button',
                        {
                          type: 'button',
                          onClick: () => setOpenDbSelected(db.name),
                          onDoubleClick: () => {
                            pickDb(db.name)
                            setOpenDbOpen(false)
                          },
                          className: cn(
                            'flex w-full items-center gap-2 rounded-[4px] px-2 py-2 text-left text-[12px]',
                            openDbSelected === db.name
                              ? 'bg-primary/10 text-(--ui-text-primary)'
                              : 'text-(--ui-text-secondary) hover:bg-(--ui-bg-secondary)'
                          ),
                          children: [
                            jsx(Codicon, { key: 'i', name: 'database', className: 'shrink-0 opacity-60' }),
                            jsx('span', { key: 'n', className: 'min-w-0 flex-1 truncate font-mono', children: db.name }),
                            db.label
                              ? jsx('span', { key: 'l', className: 'truncate text-[10.5px] text-(--ui-text-tertiary)', children: db.label })
                              : null
                          ]
                        },
                        db.name
                      )
                    )
                  }),
                  jsxs('div', {
                    key: 'actions',
                    className:
                      'flex shrink-0 items-center gap-2 border-t border-(--ui-stroke-secondary) px-4 py-2.5',
                    children: [
                      jsx(Button, {
                        key: 'cancel',
                        variant: 'ghost',
                        size: 'sm',
                        onClick: () => setOpenDbOpen(false),
                        children: 'Cancel'
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'new',
                        variant: 'secondary',
                        size: 'sm',
                        onClick: () => {
                          setOpenDbOpen(false)
                          setDraft(emptyDraft())
                        },
                        children: 'New…'
                      }),
                      jsx(Button, {
                        key: 'open',
                        size: 'sm',
                        disabled: !openDbSelected,
                        onClick: () => {
                          pickDb(openDbSelected)
                          setOpenDbOpen(false)
                        },
                        children: 'Open'
                      })
                    ]
                  })
                ]
              })
            ]
          })
        : null,
      shortcutsOpen
        ? jsxs('div', {
            key: 'shortcuts',
            className: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4',
            children: [
              jsxs('div', {
                key: 'panel',
                ref: shortcutsPanelRef,
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': 'Keyboard shortcuts',
                className:
                  'flex w-full max-w-[420px] flex-col gap-2 rounded-[8px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { key: 'i', name: 'keyboard', className: 'text-primary' }),
                      jsx('span', {
                        key: 't',
                        className: 'text-[13px] font-semibold',
                        children: 'Keyboard shortcuts'
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'close',
                        variant: 'ghost',
                        size: 'sm',
                        title: 'Close',
                        onClick: () => setShortcutsOpen(false),
                        children: jsx(Codicon, { name: 'close' })
                      })
                    ]
                  }),
                  ...[
                    [chord('F'), 'Filter the current table / search tables'],
                    [chord('R'), 'Refresh the current view'],
                    [chord('⏎'), 'Run the query / reload rows'],
                    [chord('S'), 'Save the current SQL'],
                    [chord('1 / 3 / 4'), 'Data / Structure / Site'],
                    [`${chord('2')} / ${newTabKey()}`, 'New SQL query tab'],
                    [chord('I'), 'AI autocomplete at the caret (opt-in)'],
                    [chord('Space'), 'Complete at the caret (also Ctrl Alt Space, for IMEs)'],
                    [chord('P'), 'Quick panel — jump to a table or run an action'],
                    [zoomKey(), 'Zoom in / out / reset'],
                    [chord(','), 'Settings'],
                    [chord('/'), 'This list'],
                    ['Esc', 'Close the filter panel or this list']
                  ].map(([keys, label]) =>
                    // jsxs(type, props, key) takes the key third: children belong in
                    // props, or React renders an empty row.
                    jsxs('div', {
                      key: keys,
                      className:
                        'flex items-center gap-3 rounded-[3px] px-1 py-1 text-[11.5px]',
                      children: [
                        jsx('kbd', {
                          key: 'k',
                          className:
                            'min-w-[74px] rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-1.5 py-0.5 text-center font-mono text-[10.5px]',
                          children: keys
                        }),
                        jsx('span', {
                          key: 'l',
                          className: 'text-(--ui-text-secondary)',
                          children: label
                        })
                      ]
                    })
                  )
                ]
              })
            ]
          })
        : null,
      saveQueryOpen
        ? jsxs('div', {
            key: 'save-query-modal',
            className: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4',
            children: [
              jsxs('div', {
                key: 'panel',
                className:
                  'flex w-full max-w-[420px] flex-col gap-3 rounded-[8px] border border-(--ui-stroke-secondary) bg-background p-4 shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Codicon, { key: 'i', name: 'save', className: 'text-primary' }),
                      jsx('span', {
                        key: 't',
                        className: 'text-[13px] font-semibold',
                        children: 'Save query'
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'close',
                        variant: 'ghost',
                        size: 'sm',
                        title: 'Close',
                        onClick: () => setSaveQueryOpen(false),
                        children: jsx(Codicon, { name: 'close' })
                      })
                    ]
                  }),
                  jsx(Input, {
                    key: 'name',
                    autoFocus: true,
                    value: saveQueryName,
                    placeholder: 'Name, e.g. daily revenue',
                    onChange: (event) => setSaveQueryName(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') void saveCurrentQuery()
                    }
                  }),
                  jsx('div', {
                    key: 'preview',
                    className:
                      'max-h-28 overflow-auto rounded-[4px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 font-mono text-[10.5px] whitespace-pre-wrap text-(--ui-text-secondary)',
                    children: sql
                  }),
                  jsxs('div', {
                    key: 'actions',
                    className: 'flex items-center gap-2',
                    children: [
                      jsx(Button, {
                        key: 'save',
                        size: 'sm',
                        disabled: !saveQueryName.trim() || !sql.trim(),
                        onClick: () => void saveCurrentQuery(),
                        children: 'Save query'
                      }),
                      jsx(Button, {
                        key: 'cancel',
                        variant: 'ghost',
                        size: 'sm',
                        onClick: () => setSaveQueryOpen(false),
                        children: 'Cancel'
                      })
                    ]
                  })
                ]
              })
            ]
          })
        : null,
      ddlOpen && selected
        ? jsxs('div', {
            key: 'ddl-modal',
            className: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4',
            children: [
              jsxs('div', {
                key: 'panel',
                className:
                  'flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary) bg-background shadow-2xl',
                children: [
                  jsxs('div', {
                    key: 'head',
                    className:
                      'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-4 py-2.5',
                    children: [
                      jsx('span', {
                        key: 't',
                        className: 'font-mono text-[12px] font-semibold',
                        children: `${selected.schema}.${selected.table}`
                      }),
                      jsx('span', { key: 'sp', className: 'flex-1' }),
                      jsx(Button, {
                        key: 'copy',
                        variant: 'secondary',
                        size: 'sm',
                        disabled: !ddl,
                        onClick: () => {
                          void writeClipboardText(ddl)
                          host.notify({ kind: 'info', message: 'DDL copied' })
                        },
                        children: 'Copy'
                      }),
                      jsx(Button, {
                        key: 'close',
                        variant: 'ghost',
                        size: 'sm',
                        title: 'Close',
                        onClick: () => setDdlOpen(false),
                        children: jsx(Codicon, { name: 'close' })
                      })
                    ]
                  }),
                  jsx('pre', {
                    key: 'ddl',
                    className:
                      'min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-5 whitespace-pre',
                    children: ddl || (ddlLoading ? 'Loading schema…' : '')
                  })
                ]
              })
            ]
          })
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
      redisView != null
        ? jsx(RedisValueDrawer, {
            key: 'redis-value',
            connectionId: activeId,
            database: activeDb,
            redisKey: redisView,
            onClose: () => setRedisView(null)
          })
        : null,
      rowDetail != null && data
        ? jsx(RowDrawer, {
            key: 'row-detail',
            columns: data.columns,
            row: displayRows[rowDetail] || [],
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
            initialTab: queriesTab,
            onPick: (text) => {
              setQueriesOpen(false)
              newSqlTab(text)
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
