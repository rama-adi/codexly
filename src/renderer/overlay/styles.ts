// Tailwind class recipes shared by more than one overlay surface, so the
// floating panels stay visually identical without repeating utility strings.
// Compose them with `cn()` — later classes win over these defaults.

// A flat width, not `min(760px, 100vw - 16px)`: the window is sized around this
// content, so a viewport-derived width makes every window width its own fixed
// point — the panel stays stuck at whatever the window last happened to be, and
// it outgrows the viewport as soon as a classic scrollbar eats into `100vw`.
export const hudPanel =
  'relative mt-1.5 w-[760px] animate-hud-rise rounded-hud border border-hud-line bg-hud-solid shadow-hud backdrop-blur-[30px] backdrop-saturate-[1.4]'

export const hudInlineError =
  'mt-2 rounded-hud-sm border border-hud-danger/32 bg-hud-danger/8 px-[9px] py-[7px] whitespace-pre-wrap text-hud-danger-text'

export const hudIconButton =
  'grid place-items-center rounded-md border-0 bg-white/6 text-hud-dim transition-colors enabled:hover:bg-white/12 enabled:hover:text-hud-text disabled:opacity-30'

export const hudBubble =
  'max-w-[86%] animate-hud-rise-fast rounded-[9px] px-[9px] py-[7px] text-[11.5px] leading-[1.55] whitespace-pre-wrap'

export const hudToolStack = 'grid gap-1.5'
