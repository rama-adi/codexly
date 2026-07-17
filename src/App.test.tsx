import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { App } from './App'
import { resolveHomepageSection, resolveRendererRole } from './renderer/roles'

describe('renderer roles', () => {
  it('permits only supported renderer roles', () => {
    expect(resolveRendererRole('?role=overlay')).toBe('overlay')
    expect(resolveRendererRole('?role=homepage')).toBe('homepage')
    expect(resolveRendererRole('?role=<script>')).toBe('homepage')
    expect(resolveRendererRole('?role=overlay&role=homepage')).toBe('overlay')
    expect(resolveRendererRole('')).toBe('homepage')
  })

  it('uses a safe workspace fallback for homepage section routing', () => {
    expect(resolveHomepageSection('#activity')).toBe('activity')
    expect(resolveHomepageSection('#invalid')).toBe('workspace')
  })
})

describe('application shells', () => {
  it('renders the homepage surface by default', () => {
    const markup = renderToStaticMarkup(<App search="" />)

    expect(markup).toContain('data-renderer-role="homepage"')
    expect(markup).toContain('Ask about the work in front of you.')
  })

  it('renders the overlay surface for the explicit role', () => {
    const markup = renderToStaticMarkup(<App search="?role=overlay" />)

    expect(markup).toContain('data-renderer-role="overlay"')
    expect(markup).toContain('Ask about your work')
  })
})
