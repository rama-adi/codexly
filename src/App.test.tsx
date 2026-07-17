import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the Codexly baseline status', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Codexly' })).toBeInTheDocument()
    expect(screen.getByText('Foundation ready')).toBeInTheDocument()
  })
})
