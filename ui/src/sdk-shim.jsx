/* Standalone shim for `@hermes/plugin-sdk`.
 *
 * The DB Desk page was written against the Hermes plugin SDK, which provides a
 * handful of UI primitives, a REST helper and a host bridge. The standalone app
 * reuses the exact same page component, so this module supplies those pieces on
 * top of React + plain HTML.
 */
import React from 'react'
import { twMerge } from 'tailwind-merge'

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar'
export const PALETTE_AREA = 'palette'

export function cn(...parts) {
  return twMerge(parts.filter(Boolean).join(' '))
}

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[3px] border text-xs font-medium ' +
  'transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none ' +
  'focus-visible:ring-1 focus-visible:ring-primary/50'

const BUTTON_VARIANTS = {
  default: 'border-primary bg-primary text-white hover:opacity-90',
  secondary:
    'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) text-(--ui-text-primary) hover:bg-(--ui-bg-quaternary)',
  outline:
    'border-(--ui-stroke-secondary) bg-transparent text-(--ui-text-primary) hover:bg-(--ui-bg-secondary)',
  ghost: 'border-transparent bg-transparent hover:bg-(--ui-bg-secondary)',
  destructive: 'border-destructive bg-destructive text-white hover:opacity-90',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300'
}

const BUTTON_SIZES = {
  xs: 'h-6 px-1.5 text-[11px]',
  sm: 'h-7 px-2 text-xs'
}

export const Button = React.forwardRef(function Button(
  { variant = 'default', size = 'sm', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.default,
        BUTTON_SIZES[size] || BUTTON_SIZES.sm,
        className
      )}
      {...props}
    />
  )
})

const BADGE_VARIANTS = {
  muted:
    'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) text-(--ui-text-secondary)',
  outline: 'border-(--ui-stroke-secondary) text-(--ui-text-secondary)',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

const BADGE_SIZES = {
  xs: 'px-1 py-0 text-[10px]'
}

export function Badge({ variant = 'muted', size = 'xs', className, children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[3px] border font-medium whitespace-nowrap',
        BADGE_VARIANTS[variant] || BADGE_VARIANTS.muted,
        BADGE_SIZES[size] || BADGE_SIZES.xs,
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export const Input = React.forwardRef(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-8 w-full min-w-0 rounded-[3px] border border-(--ui-stroke-secondary) bg-background ' +
          'px-2 text-xs text-foreground outline-none placeholder:text-(--ui-text-tertiary) ' +
          'focus:border-primary/60 disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
})

export function Codicon({ name, className, ...props }) {
  return <i aria-hidden="true" className={cn('codicon', `codicon-${name}`, className)} {...props} />
}

/* ------------------------------------------------------------------------- */
/* host bridge                                                               */
/* ------------------------------------------------------------------------- */

const notifyListeners = new Set()

export const host = {
  notify(payload) {
    const message = payload && typeof payload === 'object' ? payload : { message: String(payload) }
    for (const listener of notifyListeners) listener(message)
  },
  navigate() {
    /* single-page app: nothing to do */
  }
}

export function onNotify(listener) {
  notifyListeners.add(listener)
  return () => notifyListeners.delete(listener)
}

export async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/* ------------------------------------------------------------------------- */
/* REST                                                                      */
/* ------------------------------------------------------------------------- */

export async function rest(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} }
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  const response = await fetch(`/api${path}`, init)
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    const detail =
      data && typeof data === 'object' && data.detail ? data.detail : text || response.statusText
    const error = new Error(`${response.status}: ${JSON.stringify({ detail })}`)
    error.status = response.status
    error.detail = detail
    throw error
  }
  return data
}
