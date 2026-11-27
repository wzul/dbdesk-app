import { useEffect } from 'react'

// Anything a keyboard user can tab to. Hidden elements are filtered at call time, because a
// section can collapse between two presses of Tab.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const visible = (element) =>
  element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0

/**
 * Make a rendered overlay behave like a dialog for people who never touch the mouse.
 *
 * Three things, none of which a div gets for free:
 *   - focus moves into the panel when it opens (otherwise the first Tab goes to the page
 *     behind it, and the dialog may as well be a picture);
 *   - Tab and Shift+Tab cycle inside the panel instead of leaving it;
 *   - on close, focus goes back to the control that opened it.
 *
 * `role="dialog"` and `aria-modal` still have to be put on the element by hand — they are
 * attributes rather than behaviour, and a screen reader needs both to announce the panel.
 */
export function useDialogFocus(containerRef, { active = true } = {}) {
  useEffect(() => {
    if (!active) return undefined
    const node = containerRef.current
    if (!node) return undefined

    const previous = document.activeElement
    const focusable = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter(visible)

    // Prefer a marked autofocus target, then the first field, then the panel itself.
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
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
        previous.focus()
      }
    }
  }, [active, containerRef])
}

export default useDialogFocus
