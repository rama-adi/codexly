// Tailwind class recipes shared by more than one overlay surface, so the
// floating panels stay visually identical without repeating utility strings.
// Compose them with `cn()` — later classes win over these defaults.

export const hudPanel =
  'relative mt-1.5 w-[min(760px,calc(100vw-16px))] animate-hud-rise rounded-hud border border-hud-line bg-hud-solid shadow-hud backdrop-blur-[30px] backdrop-saturate-[1.4]'

export const hudInlineError =
  'mt-2 rounded-hud-sm border border-hud-danger/32 bg-hud-danger/8 px-[9px] py-[7px] whitespace-pre-wrap text-hud-danger-text'

export const hudIconButton =
  'grid place-items-center rounded-md border-0 bg-white/6 text-hud-dim transition-colors enabled:hover:bg-white/12 enabled:hover:text-hud-text disabled:opacity-30'

export const hudBubble =
  'max-w-[86%] animate-hud-rise-fast rounded-[9px] px-[9px] py-[7px] text-[11.5px] leading-[1.55] whitespace-pre-wrap'

export const hudToolStack = 'grid gap-1.5'
