import { Streamdown } from 'streamdown'

/**
 * Renders assistant/reasoning content as Markdown for the overlay surfaces.
 *
 * Streamdown is built for streaming: `parseIncompleteMarkdown` (its default)
 * gracefully closes half-written syntax (an unterminated ```code fence, a
 * dangling `**bold`) so the text never flickers as tokens arrive. It also
 * hardens links/images against untrusted model output and disables raw HTML.
 *
 * The `ov-md` wrapper carries the overlay's always-dark typography (see
 * overlay.css) so the rendered blocks read correctly regardless of the app
 * theme.
 */
export function Markdown({ children }: { children: string }) {
  // The overlay panel is always dark, so pin a dark Shiki theme for both the
  // light/dark slots — otherwise code fences render on a light background and
  // collide with the forced light-on-dark text (white-on-white).
  return (
    <Streamdown className="ov-md" shikiTheme={['github-dark', 'github-dark']}>
      {children}
    </Streamdown>
  )
}
