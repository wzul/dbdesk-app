import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

import { Badge, Button, Codicon, Input, cn, rest, writeClipboardText } from './sdk-shim.jsx'

function Overlay({ title, onClose, children, width = 'max-w-[520px]' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={cn(
          'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-[6px] border',
          'border-(--ui-stroke-secondary) bg-background shadow-2xl',
          width
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
          <div className="text-[13px] font-semibold">{title}</div>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} title="Close">
            <Codicon name="close" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-(--ui-text-secondary)">{label}</span>
      {children}
      {hint ? <span className="text-[10.5px] text-(--ui-text-tertiary)">{hint}</span> : null}
    </label>
  )
}

export function ExportDialog({ connection, onClose }) {
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [bundle, setBundle] = useState('')
  const [qr, setQr] = useState('')
  const [showQr, setShowQr] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const prepare = async () => {
    setError('')
    if (includeSecrets && passphrase.length < 8) {
      setError('Passphrase must be at least 8 characters.')
      throw new Error('passphrase')
    }
    const result = await rest('/connections/export', {
      method: 'POST',
      body: {
        ids: [connection.id],
        include_secrets: includeSecrets,
        passphrase
      }
    })
    setBundle(result.bundle)
    return result.bundle
  }

  const download = async () => {
    setBusy('download')
    try {
      const text = await prepare()
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${(connection.name || 'connection').replace(/[^\w.-]+/g, '-')}.dbdesk`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      if (reason.message !== 'passphrase') setError(String(reason.message || reason))
    } finally {
      setBusy('')
    }
  }

  const copy = async () => {
    setBusy('copy')
    try {
      const text = await prepare()
      await writeClipboardText(text)
    } catch (reason) {
      if (reason.message !== 'passphrase') setError(String(reason.message || reason))
    } finally {
      setBusy('')
    }
  }

  const toggleQr = async () => {
    if (showQr) {
      setShowQr(false)
      return
    }
    setBusy('qr')
    try {
      const text = await prepare()
      if (text.length > 2900) {
        setError('This bundle is too large for a QR code — use the file or copied text instead.')
        setShowQr(false)
        return
      }
      const svg = await QRCode.toString(text, {
        type: 'svg',
        margin: 1,
        width: 300,
        errorCorrectionLevel: 'L',
        color: { dark: '#111111', light: '#ffffff' }
      })
      setQr(svg)
      setShowQr(true)
    } catch (reason) {
      if (reason.message !== 'passphrase') setError(String(reason.message || reason))
    } finally {
      setBusy('')
    }
  }

  return (
    <Overlay title={`Export “${connection.name}”`} onClose={onClose} width="max-w-[440px]">
      <div className="text-[11.5px] text-(--ui-text-secondary)">
        Share this connection with another DB Desk install. Export without passwords to
        keep it safe, or encrypt them with a passphrase.
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={includeSecrets}
          onChange={(event) => {
            setIncludeSecrets(event.target.checked)
            setShowQr(false)
          }}
        />
        <span>Include passwords (encrypted with a passphrase)</span>
      </label>
      {includeSecrets ? (
        <Field label="Passphrase" hint="At least 8 characters. The other side needs it to import.">
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => {
              setPassphrase(event.target.value)
              setShowQr(false)
            }}
            placeholder="••••••••"
          />
        </Field>
      ) : null}
      {error ? (
        <div className="rounded-[4px] bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={download}>
          <Codicon name="desktop-download" />
          {busy === 'download' ? 'Preparing…' : 'Download .dbdesk'}
        </Button>
        <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={copy}>
          <Codicon name="copy" />
          {busy === 'copy' ? 'Copying…' : 'Copy'}
        </Button>
        <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={toggleQr}>
          <Codicon name="device-camera" />
          {showQr ? 'Hide QR' : busy === 'qr' ? 'Building…' : 'Show QR'}
        </Button>
      </div>
      {showQr && qr ? (
        <div className="flex flex-col items-center gap-2 rounded-[4px] border border-(--ui-stroke-secondary) bg-white p-3">
          <div className="size-[300px]" dangerouslySetInnerHTML={{ __html: qr }} />
          <div className="text-[10.5px] text-(--ui-text-tertiary)">
            Scan with a QR reader and paste the text into Import.
          </div>
        </div>
      ) : null}
    </Overlay>
  )
}

export function ImportDialog({ onClose, onImported }) {
  const [text, setText] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  const readFile = async (file) => {
    if (!file) return
    setText(await file.text())
    setPreview(null)
    setError('')
  }

  const runPreview = async () => {
    setBusy('preview')
    setError('')
    try {
      const result = await rest('/connections/import', {
        method: 'POST',
        body: { bundle: text, passphrase, preview: true }
      })
      setPreview(result)
    } catch (reason) {
      setPreview(null)
      setError(String(reason.message || reason))
    } finally {
      setBusy('')
    }
  }

  const runImport = async () => {
    setBusy('import')
    setError('')
    try {
      const result = await rest('/connections/import', {
        method: 'POST',
        body: { bundle: text, passphrase }
      })
      onImported(result)
    } catch (reason) {
      setError(String(reason.message || reason))
    } finally {
      setBusy('')
    }
  }

  return (
    <Overlay title="Import connections" onClose={onClose} width="max-w-[560px]">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          <Codicon name="folder-opened" />
          Choose file
        </Button>
        <span className="text-[10.5px] text-(--ui-text-tertiary)">
          or paste a bundle / `dbdesk://` link below
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".dbdesk,.json,application/json,text/plain"
          className="hidden"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </div>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setPreview(null)
        }}
        rows={5}
        placeholder='{"format":"dbdesk.connections", …}'
        className="w-full rounded-[4px] border border-(--ui-stroke-secondary) bg-background p-2 font-mono text-[11px] outline-none focus:border-primary/60"
      />
      <Field label="Passphrase" hint="Only needed when the bundle includes encrypted passwords.">
        <Input
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="••••••••"
        />
      </Field>
      {error ? (
        <div className="rounded-[4px] bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}
      {preview ? (
        <div className="flex flex-col gap-1 rounded-[4px] border border-(--ui-stroke-secondary) p-2">
          <div className="text-[11px] font-medium">
            {preview.count} connection{preview.count === 1 ? '' : 's'} ready
          </div>
          {preview.connections.map((item, index) => (
            <div key={index} className="flex items-center gap-2 text-[11px]">
              <Codicon name="database" className="text-(--ui-text-tertiary)" />
              <span className="truncate font-medium">{item.name}</span>
              <Badge variant="muted" size="xs">
                {item.kind}
              </Badge>
              <span className="truncate text-(--ui-text-tertiary)">
                {item.dbname || item.host}
              </span>
              {item.has_password ? (
                <Badge variant="outline" size="xs">
                  password
                </Badge>
              ) : null}
              {item.production ? (
                <Badge variant="destructive" size="xs">
                  PROD
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!text.trim() || Boolean(busy)}
          onClick={runPreview}
        >
          {busy === 'preview' ? 'Checking…' : 'Preview'}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!preview || Boolean(busy)}
          onClick={runImport}
        >
          {busy === 'import' ? 'Importing…' : `Import ${preview ? preview.count : ''}`}
        </Button>
      </div>
    </Overlay>
  )
}
