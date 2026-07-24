/**
 * Helpers for converting between browser keyboard events, Electron accelerator
 * strings, and human-readable labels. Shared by every renderer surface so the
 * capture control and the read-only hints stay in sync.
 */

export type AcceleratorPlatform = 'darwin' | 'other'

/** A minimal view of a KeyboardEvent, so this stays testable without the DOM. */
export interface KeyEventLike {
  readonly code: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
])

/** Detects the current platform for display purposes; defaults to darwin. */
export function detectPlatform(): AcceleratorPlatform {
  if (typeof navigator === 'undefined') return 'darwin'
  const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  return source.includes('mac') ? 'darwin' : 'other'
}

/**
 * Maps a physical key (event.code) to its Electron accelerator token. Returns
 * null for keys Electron cannot bind (or that we deliberately reject).
 */
function codeToKeyToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  switch (code) {
    case 'Space':
      return 'Space'
    case 'Enter':
    case 'NumpadEnter':
      return 'Enter'
    case 'Tab':
      return 'Tab'
    case 'Backspace':
      return 'Backspace'
    case 'Delete':
      return 'Delete'
    case 'ArrowUp':
      return 'Up'
    case 'ArrowDown':
      return 'Down'
    case 'ArrowLeft':
      return 'Left'
    case 'ArrowRight':
      return 'Right'
    case 'Home':
      return 'Home'
    case 'End':
      return 'End'
    case 'PageUp':
      return 'PageUp'
    case 'PageDown':
      return 'PageDown'
    case 'Minus':
      return '-'
    case 'Equal':
      return '='
    case 'BracketLeft':
      return '['
    case 'BracketRight':
      return ']'
    case 'Backslash':
      return '\\'
    case 'Semicolon':
      return ';'
    case 'Quote':
      return "'"
    case 'Comma':
      return ','
    case 'Period':
      return '.'
    case 'Slash':
      return '/'
    case 'Backquote':
      return '`'
    default:
      return null
  }
}

/** A key that can stand alone as a global shortcut without a Cmd/Ctrl/Alt modifier. */
function isStandaloneKey(token: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(token)
}

export interface AcceleratorResult {
  /** The Electron accelerator, e.g. "CommandOrControl+Shift+Space". */
  accelerator: string | null
  /**
   * Why an accelerator could not be produced yet. "incomplete" means only
   * modifiers are held (keep listening); "needs-modifier" means a bare key was
   * pressed that we refuse to bind globally.
   */
  reason?: 'incomplete' | 'needs-modifier'
}

/**
 * Builds an Electron accelerator from a keyboard event. Modifiers are emitted in
 * Electron's conventional order. A bare key (no Cmd/Ctrl/Alt) is rejected unless
 * it is a function key, so recording never hijacks ordinary typing.
 */
export function eventToAccelerator(event: KeyEventLike): AcceleratorResult {
  if (MODIFIER_CODES.has(event.code)) return { accelerator: null, reason: 'incomplete' }
  const token = codeToKeyToken(event.code)
  if (!token) return { accelerator: null, reason: 'incomplete' }

  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const hasPrimaryModifier = event.metaKey || event.ctrlKey || event.altKey
  if (!hasPrimaryModifier && !isStandaloneKey(token)) {
    return { accelerator: null, reason: 'needs-modifier' }
  }

  parts.push(token)
  return { accelerator: parts.join('+') }
}

const SYMBOLS_DARWIN: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Super: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
}

const SYMBOLS_OTHER: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Command: 'Win',
  Cmd: 'Win',
  Super: 'Win',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
}

const KEY_SYMBOLS: Record<string, string> = {
  Enter: '⏎',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
}

/** Turns an accelerator into short, platform-appropriate label tokens. */
export function acceleratorTokens(
  accelerator: string,
  platform: AcceleratorPlatform = detectPlatform(),
): string[] {
  const modifierMap = platform === 'darwin' ? SYMBOLS_DARWIN : SYMBOLS_OTHER
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => modifierMap[part] ?? KEY_SYMBOLS[part] ?? part)
}

/** Turns an accelerator into a single display string, e.g. "⌘⇧Space". */
export function formatAccelerator(
  accelerator: string,
  platform: AcceleratorPlatform = detectPlatform(),
): string {
  const tokens = acceleratorTokens(accelerator, platform)
  // macOS shows modifier symbols with no separator; other platforms use "+".
  return platform === 'darwin' ? tokens.join('') : tokens.join('+')
}
